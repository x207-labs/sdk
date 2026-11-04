"""Credit voucher (ADR-17): canonical message, nonce, signing hash, signature. Format: `spec/voucher-format.md`."""
import re

from . import signing
from ._check import MAX_SAFE_INTEGER, is_account, is_int, is_uint_string, need, num
from .signing import SecretKey, canonical_json, nep413_signing_hash, sha256

UNSIGNED_KEYS = ("circle", "payer", "payee", "epoch", "seq", "cumulativeAmount", "unit", "resource")
CREDIT_UNIT = "credit"
_GRANT_RESOURCE = re.compile(r"^x207:grant:(0|[1-9]\d*)$", re.ASCII)


def grant_resource(grant_id: int) -> str:
    """The `resource` of a voucher that pays a grant: `x207:grant:<grantId>` (`grantResource` of `@x207/core`)."""
    need(is_int(grant_id, 0), "grant id must be an integer >= 0")
    return f"x207:grant:{num(grant_id)}"


def parse_grant_resource(resource):
    """Inverse of `grant_resource`; `None` when `resource` is not a grant resource."""
    match = _GRANT_RESOURCE.match(resource) if isinstance(resource, str) else None
    if match is None:
        return None
    grant_id = int(match.group(1))
    return grant_id if grant_id <= MAX_SAFE_INTEGER else None


def validate_unsigned_voucher(voucher: dict) -> None:
    need(isinstance(voucher, dict), "voucher must be an object")
    for key in ("circle", "payer", "payee"):
        need(is_account(voucher.get(key)), f"{key} must be a NEAR account")
    need(is_int(voucher.get("epoch"), 1), "epoch must be an integer >= 1")
    need(is_int(voucher.get("seq"), 1), "seq must be an integer >= 1")
    need(is_uint_string(voucher.get("cumulativeAmount")), "cumulativeAmount must be a U128 decimal string without leading zeros")
    need(voucher.get("unit") == CREDIT_UNIT, 'unit must be "credit"')
    resource = voucher.get("resource")
    need(isinstance(resource, str) and all(ord(c) < 0x80 for c in resource), "resource must be an ASCII string")


def serialize_voucher_message(voucher: dict) -> str:
    """Canonical JSON without `signature`: fixed key order, no spaces."""
    validate_unsigned_voucher(voucher)
    return canonical_json({key: num(voucher[key]) for key in UNSIGNED_KEYS})


def voucher_nonce(voucher: dict) -> bytes:
    validate_unsigned_voucher(voucher)
    return sha256(f"x207:{voucher['payer']}:{voucher['payee']}:{num(voucher['epoch'])}:{num(voucher['seq'])}".encode("utf-8"))


def voucher_signing_hash(voucher: dict) -> bytes:
    return nep413_signing_hash(serialize_voucher_message(voucher), voucher_nonce(voucher), voucher["circle"])


def sign_voucher(voucher: dict, secret_key: SecretKey) -> dict:
    signature = signing.sign_hash(voucher_signing_hash(voucher), secret_key)
    return {**{key: num(voucher[key]) for key in UNSIGNED_KEYS}, "signature": signature}


def verify_voucher(voucher: dict, public_key: str) -> bool:
    """True only for a voucher with a valid signature of `public_key`; malformed or tampered input gives False."""
    try:
        unsigned = {key: voucher[key] for key in UNSIGNED_KEYS}
        return signing.verify_hash(voucher_signing_hash(unsigned), voucher["signature"], public_key)
    except (signing.FormatError, KeyError, TypeError, ValueError):
        return False
