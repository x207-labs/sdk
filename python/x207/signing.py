"""NEP-413 style payload, sha256 signing hash and ed25519 signatures with the voucher key (ADR-06). Same bytes as `@x207/core`."""
import hashlib
import json
import struct
from typing import Union

from . import ed25519
from .base58 import b58decode, b58encode

NEP413_TAG = 2147484061  # 2^31 + 413
PREFIX = "ed25519:"

SecretKey = Union[bytes, str]


class FormatError(ValueError):
    """A value that cannot be serialized: it breaks the rules of the format."""


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def canonical_json(value) -> str:
    """JSON like `JSON.stringify`: no spaces, keys in insertion order, non-ASCII text written as is."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _borsh_string(text: str) -> bytes:
    data = text.encode("utf-8")
    return struct.pack("<I", len(data)) + data


def nep413_signing_hash(message: str, nonce: bytes, recipient: str) -> bytes:
    """`sha256(u32 tag + borsh({message, nonce[32], recipient, callback_url: None}))`."""
    if len(nonce) != 32:
        raise FormatError("NEP-413 nonce must be 32 bytes")
    return sha256(struct.pack("<I", NEP413_TAG) + _borsh_string(message) + nonce + _borsh_string(recipient) + b"\x00")


def seed_of(secret_key: SecretKey) -> bytes:
    if isinstance(secret_key, (bytes, bytearray)):
        if len(secret_key) != 32:
            raise ValueError("voucher key seed must be 32 bytes")
        return bytes(secret_key)
    if not secret_key.startswith(PREFIX):
        raise ValueError("voucher key must be ed25519:<base58>")
    raw = b58decode(secret_key[len(PREFIX):])
    if len(raw) != 64:
        raise ValueError("voucher key ed25519:<base58> must be 64 bytes")
    return raw[:32]


def public_key_of(secret_key: SecretKey) -> str:
    return PREFIX + b58encode(ed25519.public_key(seed_of(secret_key)))


def sign_hash(digest: bytes, secret_key: SecretKey) -> str:
    return PREFIX + b58encode(ed25519.sign(seed_of(secret_key), digest))


def verify_hash(digest: bytes, signature: str, public_key: str) -> bool:
    """True only for a valid signature; malformed input gives False."""
    try:
        if not public_key.startswith(PREFIX) or not signature.startswith(PREFIX):
            return False
        return ed25519.verify(b58decode(public_key[len(PREFIX):]), digest, b58decode(signature[len(PREFIX):]))
    except (ValueError, AttributeError):
        return False
