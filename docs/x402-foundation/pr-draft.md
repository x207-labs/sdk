# Draft PR: `specs/schemes/batch-settlement/scheme_batch_settlement_x207.md`

**Not sent.** Title proposal: `spec: batch-settlement on NEAR with credit-backed vouchers (x207:<circleId>)`

## Summary

Adds a chain-specific spec for the `batch-settlement` scheme on the network family `x207:<circleId>`: payload structure, verification logic and settlement logic for cumulative vouchers that are checked against a credit limit held in a NEAR contract, with multi-party clearing at the end of each epoch.

## Contents of the spec

| Section | What it fixes |
| --- | --- |
| Binding identity | Scheme `batch-settlement`, network `x207:<circleId>` (CAIP-2 pattern), `asset` `USD` with 6 decimals, flow `authorization` |
| `PAYMENT-REQUIRED` | `accepts` entry with `extra.circleContract`, `extra.epoch`, `extra.unit`, `extra.decimals`; the `exact` NEAR entry next to it |
| `PAYMENT-SIGNATURE` payload | Voucher fields (`circle`, `payer`, `payee`, `epoch`, `seq`, `cumulativeAmount`, `unit`, `resource`), ed25519 signature over an NEP-413 payload; optional `bundleId` for a leg of an agreed barter bundle; for an endpoint grant (access asset, feature F8) `extra.grantId` in the entry, `payTo` = the grantor and `resource` = `x207:grant:<grantId>` |
| Verification | Ordered checks, each with a reason code; headroom counts vouchers received but not yet registered |
| Settlement | Latest voucher per pair stored by the facilitator, registered on chain per pair and epoch, retries until cutoff; `extensions.x207` carries the registration state |
| Security | What a leaked voucher key can and cannot do; limits and stake cover |
| Test vectors | Shared JSON vectors and a conformance suite |

## Testing

- Reference implementation and unit tests in the NEAR sandbox; vectors shared with the contract tests; `npm run conformance` passes 54 cases for the reference adapter (TypeScript), and `npm run conformance:python` passes the same 54 for an independent Python implementation (run 2026-11-02).
- No public-network run is claimed.

## Disclosure

This text and parts of the reference implementation were written with AI assistance and reviewed by a human before this PR was marked ready.

## Open questions

See the discussion issue: scheme name versus a separate scheme, the network identifier, and the `extensions` field.
