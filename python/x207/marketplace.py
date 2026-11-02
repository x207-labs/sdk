"""Listings, offers, referrals and the quick barter arithmetic (F9). Format: `spec/marketplace.md`."""
from . import signing
from ._check import is_account, is_amount, is_ascii_text, is_asset_type, is_hash, is_int, is_nonce, need, num
from .base58 import b58encode
from .signing import SecretKey, canonical_json, nep413_signing_hash, sha256

ASSET_CLASSES = ("A", "B", "C", "D")  # class X is rejected
_BPS = 10_000


def _check_side(side, name: str) -> None:
    need(isinstance(side, dict), f"{name} must be an object")
    need(is_asset_type(side.get("asset_type")), f"{name}.asset_type is not valid")
    need(side.get("asset_class") in ASSET_CLASSES, f"{name}.asset_class {side.get('asset_class')!r} is rejected: valid classes are A, B, C or D")
    need(is_int(side.get("quantity"), 1), f"{name}.quantity must be an integer >= 1")
    need(is_amount(side.get("value")), f"{name}.value must be a decimal string above 0 without a leading zero, at most U128")


def validate_listing(listing: dict) -> None:
    need(is_account(listing.get("circle")) and is_account(listing.get("account")), "circle and account must be NEAR accounts")
    _check_side(listing.get("offer"), "offer")
    _check_side(listing.get("want"), "want")
    need(is_ascii_text(listing.get("terms"), 512), "terms must be ASCII text of at most 512 characters")
    need(is_ascii_text(listing.get("detail"), 2048), "detail must be ASCII text of at most 2048 characters")
    need(is_int(listing.get("expires_at"), 1), "expires_at must be an integer unix second >= 1")
    need(is_int(listing.get("discount_bps"), 0) and num(listing["discount_bps"]) <= _BPS, "discount_bps must be an integer 0..10000")
    need(isinstance(listing.get("accept_payment"), bool) and isinstance(listing.get("discoverable"), bool), "accept_payment and discoverable must be booleans")
    need(is_nonce(listing.get("nonce")), "nonce must be 1-64 characters [A-Za-z0-9_-]")


def validate_offer(offer: dict) -> None:
    need(is_account(offer.get("circle")) and is_account(offer.get("proposer")), "circle and proposer must be NEAR accounts")
    need(is_hash(offer.get("listing_hash")), "listing_hash must be 64 lowercase hex characters")
    need(is_int(offer.get("round"), 1), "round must be an integer >= 1")
    need(offer.get("mode") in ("pay", "barter"), 'mode must be "pay" or "barter"')
    need(is_amount(offer.get("value")), "value must be a decimal string above 0 without a leading zero, at most U128")
    need(is_int(offer.get("quantity"), 1), "quantity must be an integer >= 1")
    need(is_int(offer.get("deliver_by"), 1), "deliver_by must be an integer unix second >= 1")


def validate_referral(referral: dict) -> None:
    need(all(is_account(referral.get(k)) for k in ("circle", "seeker", "to")), "circle, seeker and to must be NEAR accounts")
    need(referral["seeker"] != referral["to"], "a seeker does not refer itself")
    need(is_hash(referral.get("listing_hash")), "listing_hash must be 64 lowercase hex characters")
    need(referral.get("mode") in ("pay", "barter"), 'mode must be "pay" or "barter"')
    need(is_amount(referral.get("value")), "value must be a decimal string above 0 without a leading zero, at most U128")
    need(is_int(referral.get("quantity"), 1), "quantity must be an integer >= 1")
    need(is_int(referral.get("deliver_by"), 1), "deliver_by must be an integer unix second >= 1")
    need(is_int(referral.get("searcher_share_bps"), 0) and num(referral["searcher_share_bps"]) <= _BPS, "searcher_share_bps must be an integer 0..10000")
    need(is_int(referral.get("expires_at"), 1), "expires_at must be an integer unix second >= 1")
    need(is_nonce(referral.get("nonce")), "nonce must be 1-64 characters [A-Za-z0-9_-]")


def _side(s: dict) -> dict:
    return {"asset_type": s["asset_type"], "asset_class": s["asset_class"], "quantity": num(s["quantity"]), "value": s["value"]}


def serialize_listing(listing: dict) -> str:
    validate_listing(listing)
    return canonical_json({
        "circle": listing["circle"], "account": listing["account"], "offer": _side(listing["offer"]), "want": _side(listing["want"]),
        "terms": listing["terms"], "detail": listing["detail"], "expires_at": num(listing["expires_at"]), "discount_bps": num(listing["discount_bps"]),
        "accept_payment": listing["accept_payment"], "discoverable": listing["discoverable"], "nonce": listing["nonce"],
    })


def serialize_offer(offer: dict) -> str:
    validate_offer(offer)
    return canonical_json({
        "circle": offer["circle"], "listing_hash": offer["listing_hash"], "proposer": offer["proposer"], "round": num(offer["round"]),
        "mode": offer["mode"], "value": offer["value"], "quantity": num(offer["quantity"]), "deliver_by": num(offer["deliver_by"]),
    })


def serialize_referral(referral: dict) -> str:
    validate_referral(referral)
    return canonical_json({
        "circle": referral["circle"], "seeker": referral["seeker"], "to": referral["to"], "listing_hash": referral["listing_hash"],
        "mode": referral["mode"], "value": referral["value"], "quantity": num(referral["quantity"]), "deliver_by": num(referral["deliver_by"]),
        "searcher_share_bps": num(referral["searcher_share_bps"]), "expires_at": num(referral["expires_at"]), "nonce": referral["nonce"],
    })


def _hash_of(serialize, value) -> bytes:
    return sha256(serialize(value).encode("utf-8"))


def listing_hash(listing: dict) -> str:
    return _hash_of(serialize_listing, listing).hex()


def listing_hash_base58(listing: dict) -> str:
    return b58encode(_hash_of(serialize_listing, listing))


def offer_hash(offer: dict) -> str:
    return _hash_of(serialize_offer, offer).hex()


def referral_hash(referral: dict) -> str:
    return _hash_of(serialize_referral, referral).hex()


def listing_signing_hash(listing: dict) -> bytes:
    return nep413_signing_hash(serialize_listing(listing), _hash_of(serialize_listing, listing), listing["circle"])


def offer_signing_hash(offer: dict) -> bytes:
    return nep413_signing_hash(serialize_offer(offer), _hash_of(serialize_offer, offer), offer["circle"])


def referral_signing_hash(referral: dict) -> bytes:
    return nep413_signing_hash(serialize_referral(referral), _hash_of(serialize_referral, referral), referral["circle"])


def sign_listing(listing: dict, secret_key: SecretKey) -> str:
    return signing.sign_hash(listing_signing_hash(listing), secret_key)


def sign_offer(offer: dict, secret_key: SecretKey) -> str:
    return signing.sign_hash(offer_signing_hash(offer), secret_key)


def sign_referral(referral: dict, secret_key: SecretKey) -> str:
    return signing.sign_hash(referral_signing_hash(referral), secret_key)


def _verify(signing_hash, value, signature: str, public_key: str) -> bool:
    try:
        return signing.verify_hash(signing_hash(value), signature, public_key)
    except (signing.FormatError, KeyError, TypeError, ValueError):
        return False


def verify_listing_signature(listing: dict, signature: str, public_key: str) -> bool:
    return _verify(listing_signing_hash, listing, signature, public_key)


def verify_offer_signature(offer: dict, signature: str, public_key: str) -> bool:
    return _verify(offer_signing_hash, offer, signature, public_key)


def verify_referral_signature(referral: dict, signature: str, public_key: str) -> bool:
    return _verify(referral_signing_hash, referral, signature, public_key)


def _split(value: str, discount_bps, searcher_share_bps):
    need(is_amount(value), "value must be a decimal string above 0 without a leading zero, at most U128")
    for name, bps in (("discountBps", discount_bps), ("searcherShareBps", searcher_share_bps)):
        need(is_int(bps, 0) and num(bps) <= _BPS, "bps must be an integer 0..10000")
    v = int(value)
    discount = v * num(discount_bps) // _BPS
    searcher = v * num(searcher_share_bps) // _BPS
    need(searcher <= discount, "the searcher share cannot exceed the discount")
    return v, discount, searcher


def quick_pay(value: str, discount_bps, searcher_share_bps) -> dict:
    """Pay path: the counterparty pays `value - discount + searcher`; the seller receives `value - discount`; the seeker its share."""
    v, discount, searcher = _split(value, discount_bps, searcher_share_bps)
    return {"counterpartyPays": str(v - discount + searcher), "sellerReceives": str(v - discount), "searcher": str(searcher), "discount": str(discount)}


def quick_barter(value: str, discount_bps, searcher_share_bps) -> dict:
    """Barter path: cashback = discount - searcher share; the seller bears the discount."""
    v, discount, searcher = _split(value, discount_bps, searcher_share_bps)
    return {"cashback": str(discount - searcher), "searcher": str(searcher), "sellerBears": str(discount), "counterpartyGives": str(v)}
