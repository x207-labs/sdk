"""Shared validation helpers; the rules are those of `packages/core/src/validate.ts`, `barter.ts` and `marketplace.ts`."""
import re

from .signing import FormatError

U128_MAX = 340282366920938463463374607431768211455
MAX_SAFE_INTEGER = 2**53 - 1
_ACCOUNT = re.compile(r"^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$", re.ASCII)
_AMOUNT = re.compile(r"^[1-9]\d*$", re.ASCII)
_UINT = re.compile(r"^(?:0|[1-9]\d*)$", re.ASCII)
_HASH = re.compile(r"^[0-9a-f]{64}$")
_NONCE = re.compile(r"^[A-Za-z0-9_-]{1,64}$", re.ASCII)
_ASSET = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,63}$")


def num(value):
    """A JSON number as JavaScript sees it: 5.0 is 5. Anything else that is not an int stays as it is (and fails `is_int`)."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def is_int(value, minimum: int) -> bool:
    value = num(value)
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= MAX_SAFE_INTEGER


def is_account(value) -> bool:
    return isinstance(value, str) and 2 <= len(value) <= 64 and _ACCOUNT.match(value) is not None


def is_amount(value) -> bool:
    """Decimal string above 0 without a leading zero, at most U128."""
    return isinstance(value, str) and _AMOUNT.match(value) is not None and int(value) <= U128_MAX


def is_uint_string(value) -> bool:
    return isinstance(value, str) and _UINT.match(value) is not None and int(value) <= U128_MAX


def is_hash(value) -> bool:
    return isinstance(value, str) and _HASH.match(value) is not None


def is_nonce(value) -> bool:
    return isinstance(value, str) and _NONCE.match(value) is not None


def is_asset_type(value) -> bool:
    return isinstance(value, str) and _ASSET.match(value) is not None


def is_ascii_text(value, maximum: int) -> bool:
    return isinstance(value, str) and len(value) <= maximum and all(0x20 <= ord(c) <= 0x7E for c in value)


def need(condition: bool, message: str) -> None:
    if not condition:
        raise FormatError(message)


def byte_key(text: str) -> bytes:
    """UTF-8 byte order, the order of the legs of a bundle."""
    return text.encode("utf-8")
