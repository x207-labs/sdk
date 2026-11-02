# x207 conformance suite

Checks that an implementation of the x207 binding and the marketplace formats (voucher, intent, bundle, listing, offer, referral, quick barter) produces the same bytes, hashes and verdicts as the reference. Cases come from `spec/test-vectors/`, the single source of the formats; nothing here is invented by the runner.

```bash
npm run conformance                                  # reference adapter (@x207/core)
npm run conformance -- --cmd "python3 my_impl.py"    # any other implementation
```

Exit code 0 when every case passes, 1 otherwise. A failing case prints its id, the operation, the expected and the received value.

## Adapter protocol (NDJSON on stdin and stdout)

The runner starts the command, writes one JSON object per line `{"id", "op", "input"}` and expects one line per request `{"id", "output"}` or `{"id", "error"}`. Order does not matter. Amounts are decimal strings; hashes are lowercase hex unless the operation says Base58.

| Operation | Input | Output |
| --- | --- | --- |
| `voucher.message` | `{voucher}` (without signature) | canonical JSON string |
| `voucher.signingHash` | `{voucher}` | hex sha256 of the NEP-413 payload |
| `voucher.verify` | `{voucher, publicKey}` (voucher with `signature`) | `{valid}` |
| `intent.message`, `intent.hash`, `intent.hashBase58`, `intent.signingHash` | `{intent}` | string |
| `intent.verify` | `{intent, signature, publicKey}` | `{valid}` |
| `bundle.message`, `bundle.termsHash`, `bundle.signingHash` | `{terms}` | string |
| `bundle.verify` | `{terms, signature, publicKey}` | `{valid}` |
| `listing.message`, `listing.hash`, `listing.hashBase58`, `listing.signingHash` | `{listing}` | string |
| `listing.verify` | `{listing, signature, publicKey}` | `{valid}` |
| `offer.message`, `offer.hash`, `offer.signingHash` | `{offer}` | string |
| `offer.verify` | `{offer, signature, publicKey}` | `{valid}` |
| `referral.message`, `referral.hash`, `referral.signingHash` | `{referral}` | string |
| `referral.verify` | `{referral, signature, publicKey}` | `{valid}` |
| `quick.pay` | `{value, discountBps, searcherShareBps}` | `{counterpartyPays, sellerReceives, searcher, discount}` |
| `quick.barter` | same | `{cashback, searcher, sellerBears, counterpartyGives}` |

Format rules are in `spec/voucher-format.md`, `spec/barter-format.md` and `spec/marketplace.md`. Signatures are ed25519 over the sha256 of an NEP-413 payload (`message` = canonical JSON, `nonce` = sha256 of the message, `recipient` = circle contract). `verify` operations return `{valid: false}` for any malformed or tampered input rather than failing.

## What it does not cover

Network behavior (facilitator HTTP, contract calls, the listing book API) is not in this suite; those are covered by the integration tests in this repository. A language SDK passes this suite first and then the integration flows. The Python SDK of `python/` (SD-059) passes the suite: `npm run conformance:python`.
