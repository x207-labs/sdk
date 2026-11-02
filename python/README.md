# x207 for Python (SD-059)

The formats of x207 in Python, standard library only: credit voucher, barter intent, bundle terms (with `search_leg`), listing, offer, referral, the quick barter arithmetic, and the NEP-413 style ed25519 signatures with the voucher key. The bytes, hashes and verdicts are the same as `@x207/core`; the single source of the formats is `../spec/test-vectors/`.

It is **not published** to PyPI. It covers the formats only: no facilitator client, no contract calls, no listing book client. Those are in the TypeScript SDK and are not part of the conformance suite.

```python
from x207 import sign_voucher, verify_voucher, public_key_of, terms_hash

voucher = {"circle": "x207-circle.near", "payer": "a.x207-circle.near", "payee": "b.x207-circle.near", "epoch": 42, "seq": 1,
           "cumulativeAmount": "20000", "unit": "credit", "resource": "https://seller.example/api"}
seed = bytes.fromhex("01" * 32)            # or "ed25519:<base58 of seed + public key>"
signed = sign_voucher(voucher, seed)
assert verify_voucher(signed, public_key_of(seed))
```

## Check

From `sdk/`:

```bash
npm run conformance:python     # the conformance suite of the sdk against the Python adapter
cd python && python3 -m unittest discover -s tests -v
```

## Limits

- Ed25519 is pure Python (RFC 8032): correct against the vectors and RFC 8032 test vector 1, but slow (milliseconds per operation) and not hardened against timing attacks. Use it for formats, tests and tools; for a service that signs for others, put a vetted library behind `x207.signing.sign_hash`.
- Tested on Python 3.9. Text fields that the format limits to ASCII are checked as the TypeScript SDK checks them; numbers that JSON gives as `5.0` count as `5`, like JavaScript.
