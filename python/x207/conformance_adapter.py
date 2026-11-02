"""Conformance adapter (NDJSON on stdin and stdout), protocol in `sdk/conformance/README.md`.

    cd sdk && npm run conformance -- --cmd "PYTHONPATH=python python3 -m x207.conformance_adapter"
"""
import json
import sys

from . import barter, marketplace, voucher


def _verify(fn):
    return {"valid": bool(fn())}


OPS = {
    "voucher.message": lambda i: voucher.serialize_voucher_message(i["voucher"]),
    "voucher.signingHash": lambda i: voucher.voucher_signing_hash(i["voucher"]).hex(),
    "voucher.verify": lambda i: _verify(lambda: voucher.verify_voucher(i["voucher"], i["publicKey"])),
    "intent.message": lambda i: barter.serialize_intent(i["intent"]),
    "intent.hash": lambda i: barter.intent_hash(i["intent"]),
    "intent.hashBase58": lambda i: barter.intent_hash_base58(i["intent"]),
    "intent.signingHash": lambda i: barter.intent_signing_hash(i["intent"]).hex(),
    "intent.verify": lambda i: _verify(lambda: barter.verify_intent_signature(i["intent"], i["signature"], i["publicKey"])),
    "bundle.message": lambda i: barter.serialize_bundle_terms(i["terms"]),
    "bundle.termsHash": lambda i: barter.terms_hash(i["terms"]),
    "bundle.signingHash": lambda i: barter.bundle_signing_hash(i["terms"]).hex(),
    "bundle.verify": lambda i: _verify(lambda: barter.verify_bundle_signature(i["terms"], i["signature"], i["publicKey"])),
    "listing.message": lambda i: marketplace.serialize_listing(i["listing"]),
    "listing.hash": lambda i: marketplace.listing_hash(i["listing"]),
    "listing.hashBase58": lambda i: marketplace.listing_hash_base58(i["listing"]),
    "listing.signingHash": lambda i: marketplace.listing_signing_hash(i["listing"]).hex(),
    "listing.verify": lambda i: _verify(lambda: marketplace.verify_listing_signature(i["listing"], i["signature"], i["publicKey"])),
    "offer.message": lambda i: marketplace.serialize_offer(i["offer"]),
    "offer.hash": lambda i: marketplace.offer_hash(i["offer"]),
    "offer.signingHash": lambda i: marketplace.offer_signing_hash(i["offer"]).hex(),
    "offer.verify": lambda i: _verify(lambda: marketplace.verify_offer_signature(i["offer"], i["signature"], i["publicKey"])),
    "referral.message": lambda i: marketplace.serialize_referral(i["referral"]),
    "referral.hash": lambda i: marketplace.referral_hash(i["referral"]),
    "referral.signingHash": lambda i: marketplace.referral_signing_hash(i["referral"]).hex(),
    "referral.verify": lambda i: _verify(lambda: marketplace.verify_referral_signature(i["referral"], i["signature"], i["publicKey"])),
    "quick.pay": lambda i: marketplace.quick_pay(i["value"], i["discountBps"], i["searcherShareBps"]),
    "quick.barter": lambda i: marketplace.quick_barter(i["value"], i["discountBps"], i["searcherShareBps"]),
}


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        try:
            handler = OPS.get(request["op"])
            if handler is None:
                raise ValueError(f"unknown op: {request['op']}")
            answer = {"id": request["id"], "output": handler(request["input"])}
        except Exception as error:  # noqa: BLE001 - the protocol answers every request
            answer = {"id": request["id"], "error": str(error)}
        sys.stdout.write(json.dumps(answer, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
