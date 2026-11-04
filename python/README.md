# x207 for Python (SD-059)

The formats of x207 in Python, standard library only: credit voucher, barter intent, bundle terms (with `search_leg`), listing, offer, referral, the quick barter arithmetic, and the NEP-413 style ed25519 signatures with the voucher key. The bytes, hashes and verdicts are the same as `@x207/core`; the single source of the formats is `../spec/test-vectors/`.

It is **not published** to PyPI. Besides the formats it has the x402 side of a buyer (`x207.payment`, `x207.client`, SD-086): read a 402, sign the next cumulative voucher, send `PAYMENT-SIGNATURE`, read `PAYMENT-RESPONSE`; see [`../examples/python-buyer`](../examples/python-buyer). There are no contract calls, no facilitator or seller server and no listing book client; those are in the TypeScript SDK and are not part of the conformance suite.

```python
from x207 import sign_voucher, verify_voucher, public_key_of, terms_hash

voucher = {"circle": "x207-circle.near", "payer": "a.x207-circle.near", "payee": "b.x207-circle.near", "epoch": 42, "seq": 1,
           "cumulativeAmount": "20000", "unit": "credit", "resource": "https://seller.example/api"}
seed = bytes.fromhex("01" * 32)            # or "ed25519:<base58 of seed + public key>"
signed = sign_voucher(voucher, seed)
assert verify_voucher(signed, public_key_of(seed))
```

## Pay an x402 endpoint

```python
from x207 import X207PaymentClient, generate_voucher_keypair, paid_get

client = X207PaymentClient("my-agent.near", "ed25519:<voucher secret key>", max_per_call="100000")   # limits in credit base units
response = paid_get(client, "https://seller.example/api/summarize")   # pays a 402 with the batch-settlement entry on x207:<circleId>
response.status, response.paid, response.json(), response.receipt["extensions"]["x207"]   # seq, cumulativeAmount, registration
```

`generate_voucher_keypair()` makes a new voucher key (not a NEAR key). `X207PaymentClient.create_payment(requirements, url)` and `on_response(...)` are the same steps without HTTP, for any HTTP library.

## Parity with `@x207/core`

| Part of `@x207/core` | Python | Checked by |
| --- | --- | --- |
| voucher message, nonce, signing hash, `signVoucher`, `verifyVoucher`, NEP-413 hash | `x207.voucher`, `x207.signing` | the conformance suite (54 cases of `spec/test-vectors/`), `npm run conformance:python`; `examples/python-buyer/test/parity.test.ts` (40 random vouchers both ways) |
| `generateVoucherKeypair`, `voucherPublicKey`, `grantResource`, `parseGrantResource` | `generate_voucher_keypair`, `public_key_of`, `grant_resource`, `parse_grant_resource` | `tests/test_payment.py`, `parity.test.ts` |
| `validatePaymentRequirements`, the client payload and its `PAYMENT-SIGNATURE` header | `validate_requirements`, `X207PaymentClient`, `encode_header` | `spec/test-vectors/payload/` (header bytes of two consecutive vouchers), `tests/test_payment.py` |
| barter intent, bundle terms, listing, offer, referral, quick barter | `x207.barter`, `x207.marketplace` | the conformance suite |
| contract args and messages (`spec/test-vectors/args`, `msg`), clearing hashes, headroom, events, grant proofs, the facilitator, the other pipelines (invoice, order, license, transfer) | not in Python | TypeScript only |

## Check

From `sdk/`:

```bash
npm run conformance:python     # the conformance suite of the sdk against the Python adapter
cd python && python3 -m unittest discover -s tests -v   # 29 tests
# a Python agent against the TypeScript seller on near-sandbox: examples/python-buyer/README.md
```

## Limits

- Ed25519 is pure Python (RFC 8032): correct against the vectors and RFC 8032 test vector 1, but slow (milliseconds per operation) and not hardened against timing attacks. Use it for formats, tests and tools; for a service that signs for others, put a vetted library behind `x207.signing.sign_hash`.
- Tested on Python 3.9. Text fields that the format limits to ASCII are checked as the TypeScript SDK checks them; numbers that JSON gives as `5.0` count as `5`, like JavaScript.
