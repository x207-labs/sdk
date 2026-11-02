"""SD-059: the Python formats give the same bytes as the vectors of `spec/test-vectors/` (the single source) and as the reference SDK.
Run from `sdk/python`:  python3 -m unittest discover -s tests -v"""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

from x207 import barter, ed25519, marketplace, signing, voucher
from x207.base58 import b58decode, b58encode
from x207.signing import FormatError

SDK = Path(__file__).resolve().parents[2]
VECTORS = SDK / "spec" / "test-vectors"


def load(path: str):
    return json.loads((VECTORS / path).read_text(encoding="utf-8"))


KEYS = load("keys.json")["keys"]
SEEDS = {name: bytes.fromhex(key["seed"]) for name, key in KEYS.items()}


class Ed25519Tests(unittest.TestCase):
    def test_rfc8032_vector_1_empty_message(self):
        seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        self.assertEqual(ed25519.public_key(seed).hex(), "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        signature = ed25519.sign(seed, b"")
        self.assertEqual(signature.hex(), "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")
        self.assertTrue(ed25519.verify(ed25519.public_key(seed), b"", signature))
        self.assertFalse(ed25519.verify(ed25519.public_key(seed), b"x", signature))

    def test_malformed_inputs_give_false(self):
        pub = ed25519.public_key(SEEDS["kA"])
        self.assertFalse(ed25519.verify(pub, b"m", b"\x00" * 63))
        self.assertFalse(ed25519.verify(pub[:31], b"m", b"\x00" * 64))
        self.assertFalse(ed25519.verify(pub, b"m", b"\xff" * 64))

    def test_public_keys_of_the_vector_seeds(self):
        for name, seed in SEEDS.items():
            self.assertEqual(signing.public_key_of(seed), KEYS[name]["publicKey"], name)
            self.assertEqual(signing.public_key_of("ed25519:" + b58encode(seed + ed25519.public_key(seed))), KEYS[name]["publicKey"], name)

    def test_base58_round_trip_and_leading_zeros(self):
        for data in (b"", b"\x00", b"\x00\x00ab", bytes(range(40))):
            self.assertEqual(b58decode(b58encode(data)), data)
        with self.assertRaises(ValueError):
            b58decode("0OIl")


class VoucherTests(unittest.TestCase):
    def test_valid_vector_bytes_and_signature(self):
        vector = load("voucher/valid.json")
        signed = vector["input"]["voucher"]
        unsigned = {k: v for k, v in signed.items() if k != "signature"}
        self.assertEqual(voucher.serialize_voucher_message(unsigned), vector["expected"]["message"])
        self.assertEqual(voucher.voucher_nonce(unsigned).hex(), vector["expected"]["nonce"])
        self.assertEqual(voucher.voucher_signing_hash(unsigned).hex(), vector["expected"]["signingHash"])
        self.assertTrue(voucher.verify_voucher(signed, vector["input"]["publicKey"]))
        self.assertEqual(voucher.sign_voucher(unsigned, SEEDS["kA"]), signed)

    def test_tampered_vectors_do_not_verify(self):
        for path in sorted((VECTORS / "voucher").glob("tampered_*.json")):
            vector = json.loads(path.read_text(encoding="utf-8"))
            self.assertFalse(voucher.verify_voucher(vector["input"]["voucher"], vector["input"]["publicKey"]), path.name)

    def test_invalid_voucher_is_refused(self):
        unsigned = {k: v for k, v in load("voucher/valid.json")["input"]["voucher"].items() if k != "signature"}
        for patch in ({"unit": "usd"}, {"epoch": 0}, {"seq": 1.5}, {"payer": "Bad Name"}, {"cumulativeAmount": "01"}, {"resource": "é"}):
            with self.assertRaises(FormatError, msg=str(patch)):
                voucher.serialize_voucher_message({**unsigned, **patch})
        self.assertFalse(voucher.verify_voucher({**unsigned, "unit": "usd", "signature": "ed25519:x"}, "ed25519:x"))


class BundleTests(unittest.TestCase):
    def test_bundle_vectors_including_search_leg(self):
        for name in ("bundle_abca", "bundle_search"):
            vector = load(f"barter/{name}.json")
            terms = vector["terms"]
            self.assertEqual(barter.serialize_bundle_terms(terms), vector["message"], name)
            self.assertEqual(barter.terms_hash(terms), vector["termsHash"], name)
            self.assertEqual(barter.bundle_signing_hash(terms).hex(), vector["signingHash"], name)
            accounts = {a: k for a, k in zip(vector["participants"], vector["participants"])}
            for signature in vector["signatures"]:
                self.assertTrue(barter.verify_bundle_signature(terms, signature["signature"], vector["participants"][signature["account"]]), name)
            seeds = {account: SEEDS[key] for account, key in {
                "translator.x207-circle.near": "kA", "summarizer.x207-circle.near": "kB", "scraper.x207-circle.near": "kC"}.items()}
            for signature in vector["signatures"]:
                self.assertEqual(barter.sign_bundle(terms, signature["account"], seeds[signature["account"]]), signature, name)
            self.assertEqual(sorted(accounts), barter.bundle_participants(terms), name)

    def test_search_leg_is_last_and_only_when_set(self):
        search = load("barter/bundle_search.json")
        message = barter.serialize_bundle_terms(search["terms"])
        self.assertEqual(list(json.loads(message).keys()), ["circle", "epoch", "legs", "search_leg"])
        self.assertEqual(list(json.loads(message)["search_leg"].keys()), ["payer", "payee"])
        old = load("barter/bundle_abca.json")
        for variant in (old["terms"], {**old["terms"], "search_leg": None}):
            self.assertEqual(barter.terms_hash(variant), old["termsHash"])
        without = {k: v for k, v in search["terms"].items() if k != "search_leg"}
        self.assertNotEqual(barter.terms_hash(without), search["termsHash"])
        # the old signatures do not cover the search_leg
        self.assertFalse(barter.verify_bundle_signature(without, search["signatures"][0]["signature"], search["participants"][search["signatures"][0]["account"]]))

    def test_search_leg_must_be_a_leg_and_the_format_rules_hold(self):
        terms = load("barter/bundle_abca.json")["terms"]
        with self.assertRaises(FormatError):
            barter.serialize_bundle_terms({**terms, "search_leg": {"payer": terms["legs"][0]["payer"], "payee": terms["legs"][0]["payer"]}})
        with self.assertRaises(FormatError):
            barter.serialize_bundle_terms({**terms, "legs": terms["legs"][:1]})
        with self.assertRaises(FormatError):
            barter.serialize_bundle_terms({**terms, "legs": [terms["legs"][0], terms["legs"][0]]})
        with self.assertRaises(FormatError):
            barter.serialize_bundle_terms({**terms, "legs": [{**terms["legs"][0], "max_amount": "0"}, terms["legs"][1]]})

    def test_legs_in_any_order_give_the_same_hash(self):
        terms = load("barter/bundle_abca.json")["terms"]
        self.assertEqual(barter.terms_hash({**terms, "legs": list(reversed(terms["legs"]))}), barter.terms_hash(terms))


class IntentListingOfferReferralTests(unittest.TestCase):
    def test_intent(self):
        vector = load("barter/intent.json")
        intent = vector["intent"]
        self.assertEqual(barter.serialize_intent(intent), vector["message"])
        self.assertEqual(barter.intent_hash(intent), vector["intentHash"])
        self.assertEqual(barter.intent_hash_base58(intent), vector["intentHashBase58"])
        self.assertEqual(barter.intent_signing_hash(intent).hex(), vector["signingHash"])
        self.assertTrue(barter.verify_intent_signature(intent, vector["signature"], vector["pubkey"]))
        self.assertFalse(barter.verify_intent_signature({**intent, "nonce": "n2"}, vector["signature"], vector["pubkey"]))

    def test_listing_and_offers(self):
        vector = load("barter/listing.json")
        listing = vector["listing"]
        self.assertEqual(marketplace.serialize_listing(listing), vector["message"])
        self.assertEqual(marketplace.listing_hash(listing), vector["listingHash"])
        self.assertEqual(marketplace.listing_hash_base58(listing), vector["listingHashBase58"])
        self.assertEqual(marketplace.listing_signing_hash(listing).hex(), vector["signingHash"])
        self.assertTrue(marketplace.verify_listing_signature(listing, vector["signature"], vector["pubkey"]))
        self.assertEqual(marketplace.sign_listing(listing, SEEDS["kA"]), vector["signature"])
        offer = vector["offer"]
        self.assertEqual(marketplace.serialize_offer(offer), vector["offerMessage"])
        self.assertEqual(marketplace.offer_hash(offer), vector["offerHash"])
        self.assertEqual(marketplace.offer_signing_hash(offer).hex(), vector["offerSigningHash"])
        self.assertTrue(marketplace.verify_offer_signature(offer, vector["offerSignature"], vector["offerPubkey"]))
        self.assertFalse(marketplace.verify_offer_signature({**offer, "round": 2}, vector["offerSignature"], vector["offerPubkey"]))
        with self.assertRaises(FormatError):
            marketplace.serialize_listing({**listing, "offer": {**listing["offer"], "asset_class": "X"}})

    def test_referral(self):
        vector = load("barter/referral.json")
        referral = vector["referral"]
        self.assertEqual(marketplace.serialize_referral(referral), vector["message"])
        self.assertEqual(marketplace.referral_hash(referral), vector["referralHash"])
        self.assertEqual(marketplace.referral_signing_hash(referral).hex(), vector["signingHash"])
        self.assertTrue(marketplace.verify_referral_signature(referral, vector["signature"], vector["pubkey"]))
        with self.assertRaises(FormatError):
            marketplace.serialize_referral({**referral, "to": referral["seeker"]})

    def test_quick_barter_arithmetic(self):
        vector = load("barter/quick_barter.json")
        p = vector["params"]
        self.assertEqual(marketplace.quick_pay(p["value"], p["discountBps"], p["searcherShareBps"]), vector["pay"])
        self.assertEqual(marketplace.quick_barter(p["value"], p["discountBps"], p["searcherShareBps"]), vector["barter"])
        with self.assertRaises(FormatError):
            marketplace.quick_pay("100", 100, 200)  # the seeker share cannot exceed the discount


class ConformanceTests(unittest.TestCase):
    @unittest.skipIf(shutil.which("node") is None, "node is needed for the runner of the conformance suite")
    def test_runner_of_the_suite_passes_every_case(self):
        result = subprocess.run(
            ["node", "conformance/run.mjs", "--cmd", "PYTHONPATH=python python3 -m x207.conformance_adapter"],
            cwd=SDK, capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertRegex(result.stdout, r"conformance: (\d+)/\1 passed")


if __name__ == "__main__":
    unittest.main()
