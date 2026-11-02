"""Barter intent and bundle terms (F5, F9): canonical JSON, hash, signatures. Format: `spec/barter-format.md`."""
import re

from . import signing
from ._check import byte_key, is_account, is_amount, is_int, is_nonce, need, num
from .base58 import b58encode
from .signing import SecretKey, canonical_json, nep413_signing_hash, sha256

_SERVICE = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,63}$")


def _check_side(side, name: str) -> None:
    need(isinstance(side, dict), f"{name} must be an object")
    need(isinstance(side.get("service"), str) and _SERVICE.match(side["service"]) is not None, f"{name}.service is not valid")
    need(is_int(side.get("calls"), 1), f"{name}.calls must be an integer >= 1")
    need(is_amount(side.get("value")), f"{name}.value must be a decimal string above 0 without a leading zero, at most U128")


def validate_intent(intent: dict) -> None:
    need(is_account(intent.get("circle")), "circle is not a NEAR account")
    need(is_account(intent.get("account")), "account is not a NEAR account")
    _check_side(intent.get("offer"), "offer")
    _check_side(intent.get("need"), "need")
    need(is_int(intent.get("expiresAt"), 1), "expiresAt must be an integer unix second >= 1")
    need(is_nonce(intent.get("nonce")), "nonce must be 1-64 characters [A-Za-z0-9_-]")


def serialize_intent(intent: dict) -> str:
    validate_intent(intent)
    side = lambda s: {"service": s["service"], "calls": num(s["calls"]), "value": s["value"]}  # noqa: E731
    return canonical_json({
        "circle": intent["circle"], "account": intent["account"], "offer": side(intent["offer"]), "need": side(intent["need"]),
        "expiresAt": num(intent["expiresAt"]), "nonce": intent["nonce"],
    })


def intent_hash_bytes(intent: dict) -> bytes:
    return sha256(serialize_intent(intent).encode("utf-8"))


def intent_hash(intent: dict) -> str:
    return intent_hash_bytes(intent).hex()


def intent_hash_base58(intent: dict) -> str:
    return b58encode(intent_hash_bytes(intent))


def intent_signing_hash(intent: dict) -> bytes:
    return nep413_signing_hash(serialize_intent(intent), intent_hash_bytes(intent), intent["circle"])


def verify_intent_signature(intent: dict, signature: str, public_key: str) -> bool:
    try:
        return signing.verify_hash(intent_signing_hash(intent), signature, public_key)
    except (signing.FormatError, KeyError, TypeError, ValueError):
        return False


def validate_bundle_terms(terms: dict) -> None:
    need(is_account(terms.get("circle")), "circle is not a NEAR account")
    need(is_int(terms.get("epoch"), 1), "epoch must be an integer >= 1")
    legs = terms.get("legs")
    need(isinstance(legs, list) and len(legs) >= 2, "a bundle needs at least two legs")
    seen = set()
    for leg in legs:
        need(is_account(leg.get("payer")) and is_account(leg.get("payee")), "payer and payee must be NEAR accounts")
        need(leg["payer"] != leg["payee"], "a leg cannot pay itself")
        need(is_amount(leg.get("max_amount")), "max_amount must be a decimal string above 0 without a leading zero, at most U128")
        key = (leg["payer"], leg["payee"])
        need(key not in seen, f"the pair {leg['payer']}>{leg['payee']} appears twice")
        seen.add(key)
    search = terms.get("search_leg")
    if search is not None:
        need(isinstance(search, dict) and is_account(search.get("payer")) and is_account(search.get("payee")), "search_leg must be {payer, payee} NEAR accounts")
        need((search["payer"], search["payee"]) in seen, "search_leg is not a leg of the bundle")


def serialize_bundle_terms(terms: dict) -> str:
    """Canonical JSON: `circle, epoch, legs` sorted by (payer, payee), then `search_leg` only when set (interface 0.0.5)."""
    validate_bundle_terms(terms)
    legs = sorted(terms["legs"], key=lambda l: (byte_key(l["payer"]), byte_key(l["payee"])))
    body = {
        "circle": terms["circle"], "epoch": num(terms["epoch"]),
        "legs": [{"payer": l["payer"], "payee": l["payee"], "max_amount": l["max_amount"]} for l in legs],
    }
    search = terms.get("search_leg")
    if search is not None:
        body["search_leg"] = {"payer": search["payer"], "payee": search["payee"]}
    return canonical_json(body)


def terms_hash_bytes(terms: dict) -> bytes:
    return sha256(serialize_bundle_terms(terms).encode("utf-8"))


def terms_hash(terms: dict) -> str:
    return terms_hash_bytes(terms).hex()


def bundle_signing_hash(terms: dict) -> bytes:
    return nep413_signing_hash(serialize_bundle_terms(terms), terms_hash_bytes(terms), terms["circle"])


def sign_bundle(terms: dict, account: str, secret_key: SecretKey) -> dict:
    return {"account": account, "signature": signing.sign_hash(bundle_signing_hash(terms), secret_key)}


def verify_bundle_signature(terms: dict, signature: str, public_key: str) -> bool:
    try:
        return signing.verify_hash(bundle_signing_hash(terms), signature, public_key)
    except (signing.FormatError, KeyError, TypeError, ValueError):
        return False


def bundle_participants(terms: dict) -> list:
    validate_bundle_terms(terms)
    return sorted({a for l in terms["legs"] for a in (l["payer"], l["payee"])}, key=byte_key)
