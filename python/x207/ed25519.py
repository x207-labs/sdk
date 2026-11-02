"""Ed25519 (RFC 8032) in pure Python, standard library only. Slow (milliseconds per operation) and not hardened against timing attacks:
it is for formats, tests and tools, not for a service that signs for strangers. Verified against the vectors of `spec/test-vectors/`."""
import hashlib

_P = 2**255 - 19
_Q = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_I = pow(2, (_P - 1) // 4, _P)


def _inv(x: int) -> int:
    return pow(x, _P - 2, _P)


def _recover_x(y: int, sign: int):
    if y >= _P:
        return None
    x2 = (y * y - 1) * _inv(_D * y * y + 1) % _P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _I % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


_GY = 4 * _inv(5) % _P
_GX = _recover_x(_GY, 0)
_G = (_GX, _GY, 1, _GX * _GY % _P)


def _add(a, b):
    x1, y1, z1, t1 = a
    x2, y2, z2, t2 = b
    aa = (y1 - x1) * (y2 - x2) % _P
    bb = (y1 + x1) * (y2 + x2) % _P
    cc = 2 * t1 * t2 * _D % _P
    dd = 2 * z1 * z2 % _P
    e, f, g, h = bb - aa, dd - cc, dd + cc, bb + aa
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _mul(s: int, point):
    result = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            result = _add(result, point)
        point = _add(point, point)
        s >>= 1
    return result


def _equal(a, b) -> bool:
    return (a[0] * b[2] - b[0] * a[2]) % _P == 0 and (a[1] * b[2] - b[1] * a[2]) % _P == 0


def _compress(point) -> bytes:
    zinv = _inv(point[2])
    x, y = point[0] * zinv % _P, point[1] * zinv % _P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _decompress(data: bytes):
    if len(data) != 32:
        return None
    y = int.from_bytes(data, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % _P)


def _sha512(data: bytes) -> bytes:
    return hashlib.sha512(data).digest()


def _expand(seed: bytes):
    h = _sha512(seed)
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def public_key(seed: bytes) -> bytes:
    if len(seed) != 32:
        raise ValueError("seed must be 32 bytes")
    a, _ = _expand(seed)
    return _compress(_mul(a, _G))


def sign(seed: bytes, message: bytes) -> bytes:
    if len(seed) != 32:
        raise ValueError("seed must be 32 bytes")
    a, prefix = _expand(seed)
    pub = _compress(_mul(a, _G))
    r = int.from_bytes(_sha512(prefix + message), "little") % _Q
    big_r = _compress(_mul(r, _G))
    k = int.from_bytes(_sha512(big_r + pub + message), "little") % _Q
    s = (r + k * a) % _Q
    return big_r + int.to_bytes(s, 32, "little")


def verify(pub: bytes, message: bytes, signature: bytes) -> bool:
    """True only for a valid signature; any malformed input gives False."""
    if len(pub) != 32 or len(signature) != 64:
        return False
    a = _decompress(pub)
    r = _decompress(signature[:32])
    if a is None or r is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= _Q:
        return False
    k = int.from_bytes(_sha512(signature[:32] + pub + message), "little") % _Q
    return _equal(_mul(s, _G), _add(r, _mul(k, a)))
