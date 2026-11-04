"""SD-086: the x402 side of the Python buyer gives the bytes of the TypeScript client (`spec/test-vectors/payload/`), and `paid_get` pays a seller that
speaks the wire of `@x207/scheme` (a stub server here; the real seller on near-sandbox is `examples/python-buyer`).
Run from `sdk/python`:  python3 -m unittest discover -s tests -v"""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from x207 import (FormatError, MemoryVoucherStore, PaymentRefused, SpendLimitError, X207PaymentClient, decode_header, encode_header,
                  generate_voucher_keypair, paid_get, public_key_of, select_x207_requirements, sign_voucher, validate_requirements, verify_voucher)
from x207.voucher import grant_resource, parse_grant_resource

SDK = Path(__file__).resolve().parents[2]
VECTORS = SDK / "spec" / "test-vectors"
load = lambda path: json.loads((VECTORS / path).read_text(encoding="utf-8"))
SEED_A = bytes.fromhex(load("keys.json")["keys"]["kA"]["seed"])
PAYER = "translator.x207-circle.near"


class PayloadVectorTests(unittest.TestCase):
    def test_two_consecutive_vouchers_have_the_bytes_of_the_typescript_client(self):
        vector = load("payload/client_seq1_seq2.json")
        client = X207PaymentClient(PAYER, SEED_A)
        requirements, resource = vector["input"]["requirements"], vector["input"]["resource"]
        for step in ("seq1", "seq2"):
            pending = client.create_payment(requirements, resource)
            self.assertEqual(pending.payload, vector["expected"][step]["paymentPayload"], step)
            self.assertEqual(pending.header, vector["expected"][step]["header"], step)
            self.assertTrue(client.on_response(pending, {"success": True}))

    def test_an_unconfirmed_voucher_does_not_move_the_counters(self):
        vector = load("payload/client_seq1_seq2.json")
        client = X207PaymentClient(PAYER, SEED_A)
        first = client.create_payment(vector["input"]["requirements"], vector["input"]["resource"])
        self.assertFalse(client.on_response(first, {"success": False, "errorReason": "x"}))
        again = client.create_payment(vector["input"]["requirements"], vector["input"]["resource"])
        self.assertEqual((again.seq, again.cumulative), (1, "20000"))

    def test_the_header_encoding_keeps_the_key_order_of_the_vector(self):
        vector = load("payload/payment_signature_agents_main.json")
        self.assertEqual(encode_header(vector["input"]["paymentPayload"]), vector["expected"]["header"])
        self.assertEqual(decode_header(vector["expected"]["header"]), vector["input"]["paymentPayload"])
        voucher = vector["input"]["paymentPayload"]["payload"]["voucher"]
        signature = vector["input"]["paymentPayload"]["payload"]["signature"]
        self.assertTrue(verify_voucher({**voucher, "signature": signature}, public_key_of(SEED_A)))


class ClientRulesTests(unittest.TestCase):
    requirements = load("payload/client_seq1_seq2.json")["input"]["requirements"]

    def test_requirements_are_checked_like_validatePaymentRequirements(self):
        validate_requirements(self.requirements)
        bad = [("scheme", "exact"), ("network", "eip155:1"), ("amount", "0"), ("amount", "01"), ("asset", "USDC"), ("payTo", "Bad Account"), ("maxTimeoutSeconds", 0)]
        for key, value in bad:
            with self.assertRaises(FormatError, msg=f"{key}={value}"):
                validate_requirements({**self.requirements, key: value})
        for extra in ({"unit": "usd"}, {"decimals": 7}, {"epoch": 0}, {"circleContract": ""}, {"grantId": 0}):
            with self.assertRaises(FormatError, msg=str(extra)):
                validate_requirements({**self.requirements, "extra": {**self.requirements["extra"], **extra}})

    def test_the_x207_entry_is_chosen_among_the_accepts(self):
        exact = {"scheme": "exact", "network": "near:mainnet", "amount": "1"}
        self.assertEqual(select_x207_requirements({"accepts": [exact, self.requirements]}), self.requirements)
        self.assertIsNone(select_x207_requirements({"accepts": [exact]}))
        self.assertIsNone(select_x207_requirements({}))

    def test_spend_limits_stop_a_payment_before_a_voucher_is_signed(self):
        client = X207PaymentClient(PAYER, SEED_A, max_per_call="10000")
        with self.assertRaises(SpendLimitError):
            client.create_payment(self.requirements, "https://s.example/a")
        client = X207PaymentClient(PAYER, SEED_A, max_per_epoch="30000")
        first = client.create_payment(self.requirements, "https://s.example/a")
        client.on_response(first, {"success": True})
        with self.assertRaises(SpendLimitError):
            client.create_payment(self.requirements, "https://s.example/a")
        self.assertEqual(client.spent_in_epoch(42), 20000)

    def test_a_refusal_gives_the_budget_back_and_a_resync_moves_the_counters_to_the_server(self):
        client = X207PaymentClient(PAYER, SEED_A, max_per_epoch="40000")
        pending = client.create_payment(self.requirements, "https://s.example/a")
        refused = {"success": False, "errorReason": "stale_seq", "extensions": {"x207": {"epoch": 42, "lastSeq": 4, "lastCumulativeAmount": "80000"}}}
        self.assertFalse(client.on_response(pending, refused))
        self.assertTrue(client.resynced)
        self.assertEqual(client.spent_in_epoch(42), 0)
        nxt = client.create_payment(self.requirements, "https://s.example/a")
        self.assertEqual((nxt.seq, nxt.cumulative), (5, "100000"))

    def test_a_grant_endpoint_signs_the_grant_resource_not_the_url(self):
        requirements = {**self.requirements, "extra": {**self.requirements["extra"], "grantId": 7}}
        pending = X207PaymentClient(PAYER, SEED_A).create_payment(requirements, "https://broker.example/grants/7/lease")
        self.assertEqual(pending.payload["payload"]["voucher"]["resource"], "x207:grant:7")
        self.assertEqual(pending.payload["resource"]["url"], "https://broker.example/grants/7/lease")

    def test_keypairs_and_grant_resources(self):
        pair = generate_voucher_keypair()
        self.assertEqual(public_key_of(pair["secretKey"]), pair["publicKey"])
        unsigned = {"circle": "c.near", "payer": "a.near", "payee": "b.near", "epoch": 1, "seq": 1, "cumulativeAmount": "5", "unit": "credit", "resource": "r"}
        self.assertTrue(verify_voucher(sign_voucher(unsigned, pair["secretKey"]), pair["publicKey"]))
        self.assertNotEqual(generate_voucher_keypair()["secretKey"], pair["secretKey"])
        self.assertEqual(grant_resource(12), "x207:grant:12")
        self.assertEqual(parse_grant_resource("x207:grant:12"), 12)
        for bad in ("x207:grant:012", "x207:grant:", "x207:grant:-1", "grant:1", None, "x207:grant:99999999999999999999"):
            self.assertIsNone(parse_grant_resource(bad), str(bad))


class _Seller(BaseHTTPRequestHandler):
    """A seller with the wire of `@x207/scheme`: 402 + PAYMENT-REQUIRED, then PAYMENT-SIGNATURE -> 200 + PAYMENT-RESPONSE; it keeps (seq, cumulative) per pair."""
    requirements = load("payload/client_seq1_seq2.json")["input"]["requirements"]
    public_key = public_key_of(SEED_A)
    state = (0, 0)
    hits = 0
    refuse = False  # refuse every voucher

    def log_message(self, *args):
        pass

    def _send(self, status, headers, body=b""):
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        type(self).hits += 1
        signature = self.headers.get("PAYMENT-SIGNATURE")
        if signature is None:
            required = {"x402Version": 2, "error": "payment_required", "resource": {"url": self.path}, "accepts": [{"scheme": "exact", "network": "near:mainnet", "amount": "1"}, self.requirements]}
            return self._send(402, {"PAYMENT-REQUIRED": encode_header(required)})
        payload = decode_header(signature)
        voucher, sig = payload["payload"]["voucher"], payload["payload"]["signature"]
        seq, cumulative = type(self).state
        ok = verify_voucher({**voucher, "signature": sig}, self.public_key) and voucher["seq"] == seq + 1 and not type(self).refuse and payload["accepted"] == self.requirements
        if ok:
            type(self).state = (voucher["seq"], int(voucher["cumulativeAmount"]))
            receipt = {"success": True, "transaction": f"{voucher['payer']}:{voucher['payee']}:{voucher['epoch']}:{voucher['seq']}", "network": self.requirements["network"],
                       "extensions": {"x207": {"epoch": voucher["epoch"], "seq": voucher["seq"], "cumulativeAmount": voucher["cumulativeAmount"], "registration": "pending"}}}
            return self._send(200, {"PAYMENT-RESPONSE": encode_header(receipt), "content-type": "application/json"}, b'{"summary":"ok"}')
        receipt = {"success": False, "errorReason": "stale_seq", "transaction": "", "network": self.requirements["network"],
                   "extensions": {"x207": {"epoch": 42, "lastSeq": seq, "lastCumulativeAmount": str(cumulative)}}}
        return self._send(402, {"PAYMENT-RESPONSE": encode_header(receipt)})


class PaidGetTests(unittest.TestCase):
    def setUp(self):
        _Seller.state, _Seller.hits, _Seller.refuse = (0, 0), 0, False
        self.server = HTTPServer(("127.0.0.1", 0), _Seller)
        self.url = f"http://127.0.0.1:{self.server.server_port}/api/summarize"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.server_close)

    def test_two_calls_are_paid_with_cumulative_vouchers(self):
        client = X207PaymentClient(PAYER, SEED_A)
        first, second = paid_get(client, self.url), paid_get(client, self.url)
        self.assertEqual((first.status, first.paid, first.json()), (200, True, {"summary": "ok"}))
        self.assertEqual(second.receipt["extensions"]["x207"], {"epoch": 42, "seq": 2, "cumulativeAmount": "40000", "registration": "pending"})
        self.assertEqual(client.store.get(PAYER, "summarizer.x207-circle.near", 42), (2, "40000"))

    def test_a_client_that_lost_its_counters_resyncs_once_and_pays(self):
        _Seller.state = (3, 60000)
        client = X207PaymentClient(PAYER, SEED_A, store=MemoryVoucherStore())
        response = paid_get(client, self.url)
        self.assertEqual(response.receipt["extensions"]["x207"]["seq"], 4)
        self.assertEqual(_Seller.hits, 3)  # the 402, the stale voucher, the resynced voucher

    def test_a_seller_that_keeps_refusing_raises_payment_refused_after_one_retry(self):
        _Seller.state = (3, 60000)
        _Seller.refuse = True
        with self.assertRaises(PaymentRefused) as caught:
            paid_get(X207PaymentClient(PAYER, SEED_A), self.url)
        self.assertEqual(caught.exception.reason, "stale_seq")

    def test_an_endpoint_that_is_not_paid_is_returned_as_it_is(self):
        class Free(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                self.send_response(200); self.send_header("content-length", "2"); self.end_headers(); self.wfile.write(b"{}")
        free = HTTPServer(("127.0.0.1", 0), Free)
        threading.Thread(target=free.serve_forever, daemon=True).start()
        self.addCleanup(free.shutdown); self.addCleanup(free.server_close)
        response = paid_get(X207PaymentClient(PAYER, SEED_A), f"http://127.0.0.1:{free.server_port}/")
        self.assertEqual((response.status, response.paid), (200, False))


if __name__ == "__main__":
    unittest.main()
