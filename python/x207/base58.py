"""Base58 (Bitcoin alphabet) for the `ed25519:<base58>` keys and signatures of NEAR."""

_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_INDEX = {char: i for i, char in enumerate(_ALPHABET)}


def b58encode(data: bytes) -> str:
    zeros = 0
    while zeros < len(data) and data[zeros] == 0:
        zeros += 1
    n = int.from_bytes(data, "big")
    out = ""
    while n > 0:
        n, rem = divmod(n, 58)
        out = _ALPHABET[rem] + out
    return "1" * zeros + out


def b58decode(text: str) -> bytes:
    """Raises ValueError for a character outside the alphabet."""
    zeros = 0
    while zeros < len(text) and text[zeros] == "1":
        zeros += 1
    n = 0
    for char in text:
        if char not in _INDEX:
            raise ValueError(f"invalid base58 character: {char}")
        n = n * 58 + _INDEX[char]
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\x00" * zeros + body
