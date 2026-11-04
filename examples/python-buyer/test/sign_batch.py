"""Helper of parity.test.ts: reads {"items": [{"voucher": {...unsigned}, "secretKey": "ed25519:..."}]} on stdin, signs each with the Python SDK, writes the signed vouchers
and the keypairs' public keys as JSON. Also verifies {"verify": [{"voucher": signed, "publicKey": "..."}]} and answers the verdicts."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "python"))
import x207  # noqa: E402

request = json.load(sys.stdin)
out = {
    "signed": [x207.sign_voucher(i["voucher"], i["secretKey"]) for i in request.get("items", [])],
    "publicKeys": [x207.public_key_of(i["secretKey"]) for i in request.get("items", [])],
    "verdicts": [x207.verify_voucher(v["voucher"], v["publicKey"]) for v in request.get("verify", [])],
    "keypair": x207.generate_voucher_keypair(),
}
print(json.dumps(out))
