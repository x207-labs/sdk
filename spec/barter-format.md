# x207 barter intent and bundle format

Source: SD-047 (F5, F9). The `x207-circle` contract (`post_intent`, `commit_bundle`) builds the same bytes. Test vectors: [`test-vectors/barter/`](./test-vectors/barter/). Code: `packages/core/src/barter.ts`.

## Barter intent
An account offers an `offer` and needs a `need`. Values are in credit, smallest unit (6 decimals).

1. **`message`** = canonical JSON, keys in the order `circle, account, offer, need, expiresAt, nonce`, no spaces. `offer` and `need` have the form `{service, calls, value}` with the keys in that order.
2. Value rules: `service` = ASCII `[a-z0-9][a-z0-9._:-]{0,63}`; `calls` integer ≥ 1; `value` decimal string > 0 with no leading zero and ≤ U128; `expiresAt` unix-seconds integer ≥ 1; `nonce` = 1 to 64 characters `[A-Za-z0-9_-]`; `circle` and `account` valid NEAR accounts. Values are not normalized.
3. **`intent_hash`** = `sha256(UTF-8 message)`, 32 bytes. The argument `post_intent(intent_hash)` uses `Base58CryptoHash` (base58 of those 32 bytes); lowercase hex is used in the API and logs.
4. **Intent signature** (optional, outside the contract) = ed25519 with the voucher key over `sha256(NEP-413 payload)` with `message` as above, `nonce` = `intent_hash` (32 bytes), `recipient` = `circle`, `callback_url` = `None`. Payload: `u32 LE 2147484061` then borsh `{ message, nonce[32], recipient, callback_url }`, exactly as in [`voucher-format.md`](./voucher-format.md).

## Bundle terms
1. **`message`** = canonical JSON `{"circle":…,"epoch":…,"legs":[{"payer":…,"payee":…,"max_amount":…},…]}`, no spaces. Legs are sorted by `(payer, payee)` (UTF-8 string comparison per byte), so the order of the input does not affect the hash. The name `max_amount` is the same as the `BundleLeg` field of the contract and the `bundle_committed` event.
2. Rules: at least two legs; `payer` ≠ `payee`; the pair `(payer, payee)` is unique; `max_amount` is a decimal string > 0 with no leading zero and ≤ U128; `epoch` is an integer ≥ 1.
3. **`terms_hash`** = `sha256(UTF-8 message)`, written as 64 lowercase hex characters.
4. **What each participant signs** = `sha256(NEP-413 payload)` with `message` as above, `nonce` = `terms_hash` (32 bytes), `recipient` = `circle`, `callback_url` = `None`. An ed25519 signature with the voucher key of that account (`pubkey_voucher` in D1), written `ed25519:<base58 64 bytes>`.
5. **Participants** = all accounts that appear as `payer` or `payee`. A bundle is valid when every participant has exactly one valid signature over the same `terms_hash`.

Example A→B→C→A (10, 8, 6 credit): [`test-vectors/barter/bundle_abca.json`](./test-vectors/barter/bundle_abca.json).

### Seeker leg `search_leg` (interface 0.0.5)
6. Optional **`search_leg`**: `{"payer":…,"payee":…}`, marks the bundle leg that pays the seeker (F9). When present, its key comes **last** in `message`, after `legs`: `{"circle":…,"epoch":…,"legs":[…],"search_leg":{"payer":…,"payee":…}}`, no spaces, key order `payer` then `payee`. When absent (or `null` in the SDK), `message` and `terms_hash` are exactly the same as in the format before 0.0.5; `bundle_abca.json` stays valid and unchanged.
7. Rules: the pair `(payer, payee)` must be one of the legs of the bundle (the SDK throws `BarterFormatError`; the contract `ERR_BAD_BUNDLE`). The contract limits the `max_amount` of that leg to `max_search_share_bps` (default 500 = 5%) of the sum of `max_amount` of all legs; more than that is `ERR_SEARCH_SHARE_EXCEEDED`. `search_leg` is part of the signed bytes, so a participant who signed terms without `search_leg` is not valid for a bundle with `search_leg` (`ERR_BUNDLE_SIGNATURES`).
8. Argument of `commit_bundle`: `bundle: { epoch, legs, search_leg? }`.

### Bond and arbiter (interface 0.0.12, CT-094, SD-073)
9. **`arbiter`**, **`agreement_hash`** (optional) and **`confirm_by`** mark a swap of two participants that carries a bond. All three are in `message` **after `search_leg`**, in the order `arbiter`, `agreement_hash` (when present), `confirm_by`, and only when there is an arbiter, so a bundle without an arbiter (`bundle_abca`, `bundle_search`) keeps its `terms_hash`. Example: `{"circle":…,"epoch":…,"legs":[…],"arbiter":"scraper.x207-circle.near","agreement_hash":"abab…","confirm_by":"1793900000000000000"}`.
10. **`confirm_by` is a decimal string** (nanoseconds; it does not fit a JavaScript number). `agreement_hash` is the sha256, 64 lowercase hex characters, of the agreement document kept off chain.
11. Rules (the SDK throws `BarterFormatError`; the contract `ERR_BAD_BUNDLE` or `ERR_ARBITER_INVALID`): `arbiter` and `confirm_by` come together, `agreement_hash` needs both, only for two participants, and the arbiter is not a participant. The contract also requires `confirm_by` between 1 hour and 14 days after the commit (`ERR_DEAL_WINDOW`) and the arbiter not to be the owner of the circle; this is visible only at commit, so the SDK does not check it.
12. Argument of `commit_bundle`: `bundle: { epoch, legs, search_leg?, arbiter?, agreement_hash?, confirm_by? }`.
13. Vectors: `test-vectors/barter/bundle_deal.json` (with `agreement_hash`) and `bundle_deal_no_agreement.json`; only A and B sign, the arbiter does not.

Example with a seeker leg (55, 40, 5 credit; the 5 leg out of 100 = 500 bps): [`test-vectors/barter/bundle_search.json`](./test-vectors/barter/bundle_search.json). Its JSON bytes and `terms_hash` were matched against contract 0.0.5 in near-sandbox (`packages/core/test/sandbox/search-leg.sandbox.test.ts`: the contract `get_bundle.terms_hash` equals the SDK `termsHash`) and against the `terms_message` function in `contracts/x207-circle/src/bundle.rs`. The contract side copies the vectors to `contracts/tests/vectors/barter/` when it wants unit tests.

## Contract rules that apply to a bundle
- **`terms_hash` is unique.** `commit_bundle` refuses a `terms_hash` that is already recorded with `ERR_BUNDLE_EXISTS`. Identical bundle terms (same hash) cannot be used twice; the next bundle with the same legs must differ in one canonical field, that is `epoch` or a `max_amount` value. Same hash means the same `circle`, `epoch` and all legs.
- **Current epoch.** `bundle.epoch` must be the current epoch with phase `open`. A bundle for another epoch or one that is already closed is refused.
- **Errors surface as they are.** The SDK does not translate or wrap contract codes: the `ERR_*` panic message (for example `ERR_BUNDLE_EXISTS`, `ERR_BUNDLE_SIGNATURES`, `ERR_BUNDLE_HEADROOM`) reaches the caller, and `contractErrorCode(error)` returns the code. Common cause of `ERR_BUNDLE_EXISTS`: the caller resends the same proposal within one epoch.

## Bundle leg voucher (SD-048, interface 0.0.4)
The voucher bytes do not change. An F2 payment to a provider that is a bundle leg carries `bundleId` (integer >= 0) in the x402 `payload`, next to `voucher` and `signature`:

| Role | Behaviour |
| --- | --- |
| Client (`X207SchemeClient`, `X207PaymentClient`) | The option `bundleFor(payee, epoch)` returns the `bundle_id` for a pair that is a leg. The payload holds `bundleId`; the x207 entry is chosen even when the free headroom is used up, and the headroom estimate is not reduced |
| Facilitator `verify` | For a `bundleId`: `get_bundle` must exist, `status` `active`, `epoch` equal to the voucher, the pair (payer, payee) is a leg, and `cumulativeAmount` <= `max_amount` of the leg. The free-headroom check is skipped. Refusals: `bundle_unknown`, `bundle_epoch_mismatch`, `not_a_bundle_leg`, `bundle_leg_exceeded` |
| Facilitator `settle` and D3 | `pending_vouchers.bundle_id` stores `bundleId`; a bundle-leg row does not reduce the free headroom in `computeHeadroom` |
| Scheduler | A row with `bundle_id` is registered with `register_in_bundle(bundle_id, voucher, signature)`; `ERR_BUNDLE_LEG_EXCEEDED`, `ERR_BUNDLE_LEG`, `ERR_UNKNOWN_BUNDLE` drop the row (`bundle_leg_exceeded`, `not_a_bundle_leg`, `bundle_unknown`) |

`verify` reads the final block: a bundle that was just committed is visible only after finality; before that a leg voucher is refused `bundle_unknown` and the client can retry.

## F8 grant endpoint (SD-053, interface 0.0.6)
An endpoint that serves a grant (M10 broker) uses the F2 flow as it is, with three rules:
- The server puts `grantId` (integer >= 1) in `extra` of the `batch-settlement` entry and uses `payTo` = the **grantor**, not the broker account (`x207Middleware`: `routes[...].grant(request)` returns `{ grantId, payTo }`, or `undefined` for 404 `grant_not_found`). The `exact` entry does not hold `grantId`.
- The client builds the voucher with `payee` = `payTo` and `resource` = `x207:grant:<grantId>` (`grantResource`), not the endpoint URL. The voucher pair stays `(payer, payee, epoch)`, so headroom and clearing do not change.
- Facilitator `verify`: `voucher.payee` != `payTo` is still `payee_mismatch` (a voucher whose payee is the broker account is refused) and `voucher.resource` != `x207:grant:<grantId>` is refused `grant_resource_mismatch`.

Vectors: [`test-vectors/grant/voucher_grant.json`](./test-vectors/grant/voucher_grant.json) (valid voucher, broker payee, URL resource, another grant's resource).
