# Scheme: `batch-settlement` on the network `x207:<circleId>`

This follows the frame of `specs/scheme_template.md` of x402 (`Summary`, `Use Cases`, `Appendix`). MUST, SHOULD and MAY mean what they mean in RFC 2119. The byte form of the voucher is in [`voucher-format.md`](./voucher-format.md); test vectors are in [`test-vectors/`](./test-vectors/). A reader of the x402 repository does not have those two; a pull request would carry them next to this file.

> Status: this file is the source of the proposal to the x402 Foundation (SD-046); see `docs/x402-foundation/`. Nothing has been sent. A human owner reads it, checks the claims against the code, and decides whether to send.

## Summary

x207 is a mutual credit settlement layer for x402 agent payments on NEAR. The members of a *circle* owe each other through signed vouchers instead of paying each call on chain. At the end of an epoch, debt cycles are cleared and only the net positions are paid. This scheme states x207 as an x402 v2 binding of `batch-settlement` (Commit, Accumulate, Redeem) whose trust anchor is a stake each member locks in a shared pool (`limit <= stake` in the MVP); in the terms of the generic scheme this is nearest to *capital-backed*, pooled across a circle rather than escrowed per seller, and not *credit-backed* in the sense of an intermediary that underwrites the buyer on the network `x207:<circleId>`.

A seller uses this binding together with an `exact` `near:mainnet` entry (USDT NEP-141) in one 402 response. A buyer that is a member of the circle pays with a voucher; a buyer outside the circle can still pay through `exact`.

### 1. Identity of the binding

| Attribute | Value |
| --- | --- |
| x402 version | `x402Version: 2`; headers `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, each the base64 (UTF-8) of JSON without spaces |
| Scheme | `batch-settlement` |
| Network | `x207:<circleId>`, for example `x207:agents-main` |
| Network validation | The whole network string MUST match the CAIP-2 regex `^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$`. `x207:x207-circle.near` is refused because of the dot. An implementation MUST check this at configuration time, because `register()` of x402 does not validate the network |
| Circle contract account | Carried in `extra.circleContract`, not in the network |
| SDK registration | `register("x207:*", impl)` in the client, the server and the facilitator |
| Payment flow | `authorization`: verify, serve the resource, settle, answer. Other flows MUST NOT be used |
| Asset and unit | `asset` = `"USD"`; 1 credit = 1 USD; `amount` in the smallest unit with `extra.decimals = 6`. 0.02 USD = `"20000"` |
| Companion entry | A server SHOULD always advertise `exact` `near:mainnet` |
| Internal name | `mutual-credit` MUST NOT appear as a scheme or network name |

One facilitator MAY serve more than one circle. `extra.circleContract` MUST equal the mapping from `circleId` to contract in the configuration of the facilitator; otherwise `/verify` refuses with `circle_mismatch`.

## Use Cases

### 2. The 402 response and `PAYMENT-REQUIRED`

The resource server answers a request without `PAYMENT-SIGNATURE` (or with a payment that was refused) with HTTP 402 and a `PAYMENT-REQUIRED` header that holds a `PaymentRequired`. The body MAY carry the same JSON.

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": { "url": "https://summarizer.example/api/summarize", "mimeType": "application/json" },
  "accepts": [
    {
      "scheme": "batch-settlement",
      "network": "x207:agents-main",
      "amount": "20000",
      "asset": "USD",
      "payTo": "summarizer.x207-circle.near",
      "maxTimeoutSeconds": 60,
      "extra": { "circleContract": "x207-circle.near", "unit": "credit", "decimals": 6, "epoch": 42 }
    },
    {
      "scheme": "exact",
      "network": "near:mainnet",
      "amount": "20000",
      "asset": "usdt.tether-token.near",
      "payTo": "summarizer.x207-circle.near",
      "maxTimeoutSeconds": 60
    }
  ]
}
```

| Field of the x207 entry | Rule |
| --- | --- |
| `scheme` | MUST be `batch-settlement` |
| `network` | MUST be `x207:<circleId>` and match the CAIP-2 regex |
| `amount` | Price of one call; an integer string > 0 |
| `asset` | MUST be `"USD"` |
| `payTo` | NEAR account of the seller. The seller MUST be an `active` member of the same circle and not the payer. The contract refuses a registration to an inactive payee and a payment to oneself, so `/verify` checks this early |
| `maxTimeoutSeconds` | `60`. The client MUST send `PAYMENT-SIGNATURE` within 60 seconds; after that the client SHOULD ask for a new 402, because `extra.epoch` may have changed |
| `extra.circleContract` | Account of the circle contract |
| `extra.unit` | `"credit"` |
| `extra.decimals` | `6` |
| `extra.epoch` | Current epoch according to the contract view `get_epoch`; filled in by the facilitator (`getExtra`) and passed to the server through `GET /supported` |
| `extra.grantId` | Optional. Present on an endpoint that sells access to a grant of the access-asset feature; then `payTo` is the grantor and the voucher `resource` is `x207:grant:<grantId>` (section 7, check 6) |

The `exact` entry follows `scheme_exact_near.md` without change.

### 3. The `PAYMENT-SIGNATURE` payload

The client repeats the request with `PAYMENT-SIGNATURE` that holds a v2 `PaymentPayload`. The field `payload` carries the cumulative voucher per `(payer, payee, epoch)` and the ed25519 signature of the payer.

```json
{
  "x402Version": 2,
  "resource": { "url": "https://summarizer.example/api/summarize" },
  "accepted": { "scheme": "batch-settlement", "network": "x207:agents-main", "amount": "20000", "asset": "USD", "payTo": "summarizer.x207-circle.near", "maxTimeoutSeconds": 60, "extra": { "circleContract": "x207-circle.near", "unit": "credit", "decimals": 6, "epoch": 42 } },
  "payload": {
    "voucher": {
      "circle": "x207-circle.near",
      "payer": "translator.x207-circle.near",
      "payee": "summarizer.x207-circle.near",
      "epoch": 42,
      "seq": 137,
      "cumulativeAmount": "2740000",
      "unit": "credit",
      "resource": "https://summarizer.example/api/summarize"
    },
    "signature": "ed25519:<base58>"
  }
}
```

| Field of the voucher | Rule |
| --- | --- |
| `circle` | MUST equal `accepted.extra.circleContract` |
| `payer` | Account of the buying member; its `pubkey_voucher` in the contract is used for verification |
| `payee` | MUST equal `accepted.payTo` |
| `epoch` | MUST equal `accepted.extra.epoch` and the current epoch of the contract |
| `seq` | Integer >= 1, strictly increasing per `(payer, payee, epoch)`, starting at 1 in each epoch |
| `cumulativeAmount` | Integer string in the smallest unit: the total obligation of the payer to the payee in this epoch up to and including this voucher |
| `unit` | MUST be `"credit"` |
| `resource` | URL of the paid resource, ASCII. Audit information; it does not decide the obligation |
| `signature` | `ed25519:<base58>` over the canonical bytes of the voucher; see `voucher-format.md` |

The voucher is kept apart from `signature` in the payload, the same as the arguments of `register_cumulative(voucher, signature)`.

**Increment per voucher.** `increment = voucher.cumulativeAmount - base.cumulativeAmount` MUST equal `requirements.amount`. The `amount` that the server sends MUST NOT be trusted as the size of the obligation: the obligation is what the payer signed, and `amount` only makes sure that the payer pays the price that was asked.

**Client rules.**
- The last `(seq, cumulativeAmount)` is kept per `(payer, payee, epoch)`. A new epoch starts from `seq 0`, cumulative `0`.
- The local state MUST advance only after a `PAYMENT-RESPONSE` with `success: true`. If a request fails before a response, the next voucher uses the same base.
- A client MUST send at most one unconfirmed voucher per `(payer, payee)`; parallel requests to the same seller are queued.
- A client MUST choose an `x207:*` entry only when it is a member and its estimated headroom is >= `amount`; otherwise it chooses `exact`. If no entry can be paid, the client MUST fail without signing a voucher.

### 3a. Voucher of a bundle leg (optional `bundleId`)

Members can agree a barter bundle on chain (one signature per participant over the same `terms_hash`; the contract reserves the headroom of each payer for its leg). The bytes of the voucher do not change. A payment to a provider that is a leg of such a bundle carries `bundleId` (integer >= 0) in `payload`, next to `voucher` and `signature`.

| Role | Behaviour |
| --- | --- |
| Client | An option `bundleFor(payee, epoch)` returns the `bundle_id` for a pair that is a leg. The payload holds `bundleId`; the x207 entry is chosen even when the free headroom is used up, and the headroom estimate is not reduced |
| Facilitator `verify` | For a `bundleId`: `get_bundle` MUST exist, its `status` MUST be `active`, its `epoch` MUST equal the epoch of the voucher, the pair (payer, payee) MUST be a leg, and `cumulativeAmount` MUST be <= `max_amount` of the leg. The free-headroom check is skipped. Refusals: `bundle_unknown`, `bundle_epoch_mismatch`, `not_a_bundle_leg`, `bundle_leg_exceeded` |
| Facilitator `settle` and the pending store | The row keeps `bundleId`; a bundle-leg row does not reduce the free headroom in `computeHeadroom` |
| Registration | A row with a `bundleId` is registered with `register_in_bundle(bundle_id, voucher, signature)`; `ERR_BUNDLE_LEG_EXCEEDED`, `ERR_BUNDLE_LEG` and `ERR_UNKNOWN_BUNDLE` drop the row |

`verify` reads the final block: a bundle that was just committed is visible only after finality; until then a leg voucher is refused `bundle_unknown` and the client can try again.

### 3b. Bundle terms and `terms_hash` (interface 0.0.12)

The signature of every participant of a bundle is over the same `terms_hash`, so the bytes of the terms are fixed. The full format is in [`barter-format.md`](./barter-format.md); the test vectors are in `test-vectors/barter/`.

1. **`message`** is the canonical JSON `{"circle":…,"epoch":…,"legs":[{"payer":…,"payee":…,"max_amount":…},…]}` without spaces. Legs are sorted by `(payer, payee)` (byte-wise UTF-8), so the order of the input does not change the hash. `max_amount` is a decimal string > 0 with no leading zero, at most `U128`; the pair `(payer, payee)` is unique; at least two legs; `payer` differs from `payee`.
2. **`terms_hash`** is `sha256(UTF-8 message)` in 64 lowercase hex. Each participant signs `sha256(NEP-413 payload)` with `message` as above, `nonce` = the 32 bytes of `terms_hash`, `recipient` = the circle contract and `callback_url` = `None`, with its voucher key (`ed25519:<base58 64 bytes>`). A participant is every account that is a `payer` or a `payee`; the bundle is valid when each has exactly one valid signature over the same `terms_hash`.
3. **`search_leg`** (optional, 0.0.5) `{"payer":…,"payee":…}` marks the leg that pays the seeker. It is a leg of the bundle, and when present its key comes **last** in `message`, after `legs`.
4. **Bond and arbiter (0.0.12, CT-094).** A swap of two participants can carry a bond: the parties name an `arbiter` in the signed terms. Three keys are added **after `search_leg`**, in this order, and **only when there is an arbiter**: `arbiter`, `agreement_hash` (when given) and `confirm_by`. Example: `{"circle":…,"epoch":42,"legs":[…],"arbiter":"scraper.x207-circle.near","agreement_hash":"abab…","confirm_by":"1793900000000000000"}`. A bundle without an arbiter keeps exactly the `message` and the `terms_hash` it had before 0.0.12.
   - `confirm_by` is a **decimal string** of nanoseconds, because the value does not fit a JavaScript number; it is at most `U64`.
   - `agreement_hash` is the sha256 (64 lowercase hex) of the document of the agreement, kept off-chain.
   - `arbiter` and `confirm_by` come together and `agreement_hash` needs them (`ERR_BAD_BUNDLE`); the arbiter is only for a swap of two participants and is not one of them or the owner of the circle (`ERR_ARBITER_INVALID`). At commit the contract also requires `confirm_by` to be between 1 hour and 14 days after the commit (`ERR_DEAL_WINDOW`) and, from `bond_threshold` of value on, an arbiter (`ERR_BOND_REQUIRED`).
   - Only the two parties sign; the arbiter does not.
5. **Argument of `commit_bundle`**: `bundle: { epoch, legs, search_leg?, arbiter?, agreement_hash?, confirm_by? }`. The contract builds the `message` from these fields, so a key that was signed MUST be sent.

Test vectors: `bundle_abca.json` (three legs), `bundle_search.json` (with `search_leg`), `bundle_deal.json` (with `agreement_hash`) and `bundle_deal_no_agreement.json`.

### 4. The `PAYMENT-RESPONSE` header

The server sends `PAYMENT-RESPONSE` on a 200 after a successful `/settle`, and on a 402 if `/settle` fails. It holds the `SettleResponse` of the facilitator.

```json
{
  "success": true,
  "transaction": "translator.x207-circle.near:summarizer.x207-circle.near:42:137",
  "network": "x207:agents-main",
  "payer": "translator.x207-circle.near",
  "extensions": { "x207": { "epoch": 42, "seq": 137, "cumulativeAmount": "2740000", "registration": "pending" } }
}
```

| Field | Meaning |
| --- | --- |
| `transaction` | Commitment id `<payer>:<payee>:<epoch>:<seq>`. Not a transaction hash, because `/settle` only records |
| `extensions.x207.registration` | `pending` (kept by the facilitator, not on chain yet), `registered` (a voucher with this `seq` or a higher one is on chain), `retrying` (a registration failed before and is being repeated) |
| `errorReason` | Only when `success: false`; a value from the table in section 9 |

A refusal for `seq_not_increasing`, `cumulative_decreased` or `amount_mismatch` carries `extensions.x207 { epoch, lastSeq, lastCumulativeAmount }` so that the client can realign its state. The server takes these values from `GET /x207/pair-state` (section 8.5), because `VerifyResponse` has no `extensions`. A client MAY realign and try once more; a second refusal is not repeated.

`settlement_pending` (non-terminal) appears only in the demo mode of `register_voucher` per request: if the registration is not final within the facilitator timeout of 10 seconds, `/settle` answers `success: false, errorReason: "settlement_pending"`, the resource is still served, and the facilitator goes on with the registration.

### 5. Behaviour of the resource server

1. A request without `PAYMENT-SIGNATURE`: answer 402 and `PAYMENT-REQUIRED`.
2. With `PAYMENT-SIGNATURE`: decode the base64. A header that is not JSON is answered 402 `invalid_payload` without calling the facilitator. Otherwise call `POST /verify` (timeout 10 seconds).
3. `isValid: false`: answer 402 with a new `PAYMENT-REQUIRED` whose `error` holds the `invalidReason`. For `insufficient_credit` the `exact` entry MUST stay. For the three realignment codes of section 4, include the realignment `PAYMENT-RESPONSE`.
4. `isValid: true`: run the handler. If the handler fails (5xx), the server MUST NOT call `/settle`, so there is no obligation; the 5xx status is passed on.
5. Handler succeeded: call `POST /settle`. `success: true` or `settlement_pending`: answer 200 and `PAYMENT-RESPONSE`. Any other failure: answer 402 and `PAYMENT-RESPONSE`.
6. The facilitator does not answer within 10 seconds or answers 5xx: answer 503 with `Retry-After: 5`, without serving the resource.

### 6. Headroom, pending vouchers and registration

**Headroom includes pending vouchers.** For payer `p` in the current epoch `e`:

```text
base(p, q)         = pending(p, q, e) if it exists, otherwise registered(p, q, e)
unregistered(p)    = sum_q [ pending(p, q, e).cumulativeAmount - registered(p, q, e).cumulativeAmount ]
computeHeadroom(p) = max(0, headroom(p) - unregistered(p))
condition          : increment <= computeHeadroom(p)
```

`headroom(p)` is the on-chain view `max(0, limit - outstanding_debt)`, `"0"` if the member is not `active`. Only the increase of pending over the registered cumulative is subtracted, because the registered cumulative is already part of `outstanding_debt`.

**Pending store.** The facilitator MUST keep the vouchers it receives at `/settle` in persistent storage, one row per `(circle, payer, payee, epoch)` with the highest `seq`. U128 amounts are stored as text and compared as big integers.

**Registration scheduler.** The facilitator sends `register_cumulative` per pair, not per request:

| Rule | Default |
| --- | --- |
| Threshold trigger | Pending cumulative minus registered >= `registerThreshold` (1 credit) |
| Trigger before the cutoff | At `cutoff_at - flushLead` (120 seconds) every pending row of that epoch is registered |
| Acceptance limit | `/verify` refuses a voucher of epoch `e` with `epoch_closing` from `cutoff_at - flushLead` on |
| Retry | A failure is stored and repeated with backoff 5, 10, 20, 40 seconds (maximum 60) until `cutoff_at` |
| Idempotence | Safe to repeat: the contract refuses `seq` <= `last_seq` without effect. If `last_seq >= seq`, the facilitator counts the registration as done |
| Refusal of new vouchers | While a payer has a registration that failed more than once (`attempts >= 2`), `/verify` refuses new vouchers of that payer with `registration_retry_pending` |
| Failed until the cutoff | Written to the log; the risk of the seller is limited to the unregistered value of that pair |
| Demo mode | `register_voucher` per request at every `/settle`, behind a configuration flag; the default stays `register_cumulative` |

**Freshness of the chain reads.** The binding does not say how fresh the on-chain reads of `/verify` must be. An implementation MAY keep them for a few seconds to spare the RPC endpoint, as long as its own registrations drop the cached debt of the payer, because the contract refuses what the limit does not cover and the loss is limited to the vouchers that are not registered yet. The reference implementation keeps `get_epoch` 30 s, `member` 15 s, `headroom` and `obligation` 10 s (`sdk/docs/rpc-load.md`).

### 7. Order of verification in `/verify`

The facilitator MUST run the following 19 checks in order and stop at the first refusal. `/verify` MUST NOT change state.

| No | Check | `invalidReason` |
| --- | --- | --- |
| 1 | `x402Version = 2` | `invalid_x402_version` |
| 2 | `accepted.scheme = batch-settlement` and the network is registered | `unsupported_scheme` / `invalid_network` |
| 3 | `accepted` is exactly equal to `paymentRequirements` of the server; `amount` is an integer string > 0 | `invalid_payment_requirements` |
| 4 | The payload passes the schema `X207Payload` | `invalid_payload` |
| 5 | `voucher.circle = extra.circleContract =` the configuration | `circle_mismatch` |
| 6 | `voucher.payee = accepted.payTo`, `unit = credit`, `resource` is ASCII; if `extra.grantId` exists, `resource` = `x207:grant:<grantId>` | `payee_mismatch` / `grant_resource_mismatch` / `invalid_payload` |
| 7 | `voucher.payer != voucher.payee` | `self_payment` |
| 8 | `voucher.epoch = extra.epoch =` the current epoch | `epoch_mismatch` |
| 9 | `now < cutoff_at - flushLead` | `epoch_closing` |
| 10 | The payer is registered | `member_not_found` |
| 11 | The status of the payer is `active` | `member_not_active` |
| 12 | The payee is registered and `active` | `payee_not_active` |
| 13 | Neither payer nor payee is leaving | `member_exiting` |
| 13a | Neither payer nor payee is frozen (view `is_frozen`, contract 0.0.12; skipped when the facilitator has no such view). Also for a new voucher in the epoch of the freeze | `account_frozen` |
| 14 | The signature is valid against `pubkey_voucher` of the payer | `invalid_signature` |
| 15 | The payer is not under the rule `registration_retry_pending` | `registration_retry_pending` |
| 16 | `voucher.seq > base.seq` (on chain and pending) | `seq_not_increasing` |
| 17 | `voucher.cumulativeAmount >= base.cumulativeAmount` | `cumulative_decreased` |
| 18 | `increment = requirements.amount` | `amount_mismatch` |
| 19 | `increment <= computeHeadroom(payer)` | `insufficient_credit` |

For a voucher with a `bundleId` (section 3a) the bundle checks run between checks 15 and 16 and check 19 is replaced by the limit of the leg.

A failure to read the RPC (both endpoints fail or pass the timeout) is not an `invalidReason`; the facilitator answers HTTP 503. Between `cutoff_at` and `close_epoch`, `get_epoch` without arguments still returns the same epoch with the phase `cutoff`, so a voucher of that epoch fails at check 9.

### 8. Endpoints of the facilitator

All bodies are `application/json`. The endpoints are called by the resource server, not by the client.

**8.1 `POST /verify`.** Body `{ x402Version, paymentPayload, paymentRequirements }`. Answer `{ "isValid": true, "payer": "..." }` or `{ "isValid": false, "invalidReason": "...", "payer": "..." }`. For a refusal at checks 1 to 4, `payer` may be absent.

**8.2 `POST /settle`.** The same body as `/verify`. The facilitator runs `verify` again; if the voucher is valid, it stores it in the pending store (replacing a lower `seq` of that pair) and triggers a registration if the threshold has been passed. A successful answer is the `SettleResponse` of section 4. A `/settle` that is repeated with the same payload returns the same successful answer without changing state. A payload with a `seq` lower than the stored one is refused `seq_not_increasing`.

**8.3 `GET /supported`.** The list of `kinds` of x207 (with `extra` that holds the current epoch) and of `exact`, and `signers` per CAIP family (`x207:*`). The signer account is the relayer account of the facilitator.

**8.4 HTTP status.**

| Status | When |
| --- | --- |
| 200 | A business result, including `isValid: false` and `success: false` |
| 400 | The body is not JSON, a required field is missing, the network fails the regex (`{ "error": "invalid_request" }`) |
| 404 | Unknown route |
| 503 | The NEAR RPC cannot be reached after failover or passes the 10 second timeout (`chain_unavailable`, with `Retry-After`) |
| 500 | Any other internal error |

**8.5 `GET /x207/pair-state`.** Parameters `network`, `payer`, `payee`, `epoch`. Answer `{ network, payer, payee, epoch, lastSeq, lastCumulativeAmount, source }` where `source` is `pending` (a row of the pending store), `onchain` (the view `obligation`) or `none` (`lastSeq 0`, `"0"`). Read only; it does not change state.

### 9. Reason codes for refusals

| Code | Meaning | Action of the client |
| --- | --- | --- |
| `invalid_x402_version` | The version is not 2 | Update the SDK |
| `unsupported_scheme`, `invalid_network` | The scheme or the network is not served | Choose another entry |
| `invalid_payment_requirements` | `accepted` differs from the requirements of the server | Ask for a new 402 |
| `invalid_payload` | The schema of the payload is wrong or `unit` is not `credit` | Fix the client |
| `circle_mismatch` | `circle` or `extra.circleContract` does not match the configuration | Ask for a new 402 |
| `payee_mismatch` | `voucher.payee` != `payTo` | Fix the client |
| `grant_resource_mismatch` | `extra.grantId` exists but `voucher.resource` is not `x207:grant:<grantId>` | Fix the client |
| `epoch_mismatch` | The epoch of the voucher is not the current epoch | Ask for a new 402, reset the epoch state |
| `epoch_closing` | Already in the `flushLead` window before the cutoff | Use `exact` or wait for the next epoch |
| `member_not_found`, `member_not_active`, `payee_not_active` | The member or the seller is not registered or not `active` | Use `exact` |
| `self_payment` | `payer = payee` | Fix the client |
| `invalid_signature` | The signature does not match `pubkey_voucher` | Fix the key |
| `registration_retry_pending` | Vouchers of the payer repeatedly failed to register | Use `exact` until it recovers |
| `seq_not_increasing` | `seq` <= the last `seq` (replay) | Realign with `lastSeq` |
| `member_exiting` | The payer or the payee is leaving | Use `exact` or another seller |
| `account_frozen` | The payer or the payee is frozen by the DAO (ADR-43) | Use another seller; only the DAO lifts a freeze |
| `cumulative_decreased` | `cumulativeAmount` went down | Realign the state |
| `amount_mismatch` | The increment != the price that was asked | Realign the state, try once more |
| `insufficient_credit` | The increment > the headroom after pending is subtracted | Fall back to `exact` `near:mainnet` |
| `bundle_unknown`, `bundle_epoch_mismatch`, `not_a_bundle_leg`, `bundle_leg_exceeded` | The `bundleId` does not name an active bundle of this epoch that has this pair as a leg with room left (section 3a) | Wait for finality and try again, or use another entry |
| `settlement_pending` | Non-terminal, demo mode only | None; the resource has been served |

## Appendix

### 10. How the 7 requirements of a `batch-settlement` binding are met

| Requirement | How it is met | Enforcement on chain |
| --- | --- | --- |
| 1. Commitment format | `X207Payload`: cumulative voucher and an `ed25519:` signature in `PAYMENT-SIGNATURE` (section 3) | `register_cumulative(voucher, signature)` reads the same canonical bytes |
| 2. Verification rules | The 19 checks of section 7; headroom includes pending (section 6) | The contract verifies again the signature, the status, `seq`, the headroom and the cutoff at registration |
| 3. Storage behaviour | A pending store at the facilitator; commitment id `<payer>:<payee>:<epoch>:<seq>` | One state entry per pair per epoch in the contract |
| 4. Double-spend prevention | `seq_not_increasing`, `cumulative_decreased`, one unconfirmed voucher per pair | `seq` <= `last_seq` is refused without effect |
| 5. Commitment expiry | `epoch_mismatch`, `epoch_closing`; a voucher is not valid after the cutoff; `maxTimeoutSeconds = 60` | `close_epoch` freezes the snapshot; a later registration fails |
| 6. Redemption | Outside the x402 cycle: clearing of cycles (`submit_clearing`, `commit_epoch`), net debtors pay the residual to the pool, net creditors `claim` | `submit_clearing`, `commit_epoch`, settle, `finalize_epoch`, `claim` |
| 7. Trust model | Hybrid: the facilitator is only a relayer without custody and cannot forge vouchers; the on-chain guarantee is stake and a reserve fund; the invariant of the MVP is `limit <= stake` | An explicit allocation of loss: cut the stake of the debtor, then the reserve fund, then a haircut to the direct creditors of the debtor without cascade |

### 11. Security

**Replay.** A voucher is cumulative with a `seq` that is strictly increasing per `(payer, payee, epoch)`. Sending the same voucher again, or an older one, is refused by the facilitator (`seq_not_increasing`) and by the contract (a registration with `seq` <= `last_seq` is refused without effect). The nonce of the signature is derived from `payer:payee:epoch:seq` and its recipient is the account of the circle contract, so a signature is not valid in another circle, pair, epoch or order. Because the voucher is cumulative, the newest one replaces all earlier ones; no per-request id has to be stored.

**Authorization scope.** The voucher key (`pubkey_voucher`) is an ed25519 key separate from the access keys of the NEAR account. It can only sign x207 vouchers for that account; it cannot move assets of the account, call another contract, or sign a NEAR transaction. A leaked voucher key means an attacker can create obligations in the name of the payer up to `limit`, not more, and no more than the locked stake (`limit <= stake`). The owner MUST treat this key as a secret. The signature binds `circle`, `payer`, `payee`, `epoch`, `seq`, `cumulativeAmount`, `unit` and `resource`; changing one field makes it invalid.

**Settlement atomicity.** `/settle` records the voucher in the pending store and does not send an on-chain transaction; registration follows in batches. So there is no atomicity between the answer of `/settle` and certainty on chain. The risk is bounded: (1) `/verify` subtracts pending vouchers from the headroom, so a payer cannot promise more than `limit`; (2) a registration failure is repeated with backoff and new vouchers of the payer are refused after more than one failed attempt; (3) if it still fails until the cutoff, the seller bears at most the unregistered value of that pair. The server MUST NOT call `/settle` if the handler fails, so a payment is recorded only for a resource that was served.

**Facilitator as a relayer without custody.** The facilitator holds no funds and no voucher key. It only passes the voucher signed by the payer to the contract and pays gas with its relayer account. It cannot forge a voucher (ADR-06), and the contract refuses a voucher whose signature does not match the `pubkey_voucher` of the member. A malicious or dead facilitator can only delay a registration or refuse to serve; a voucher that the payer has signed can be registered by another party that holds it before the cutoff.

**Consent to clearing at `join`.** The clearing of x207 uses only debt cycles. Removing a cycle reduces the debts and the claims of a member by the same amount, so the net position and the counterparties of each member do not change. So consent to clearing is given once, when a member calls `join(circle_id, pubkey_voucher, terms_hash)`: `terms_hash` binds the member to the terms of the circle, including the clearing of cycles by any solver. A member does not sign each round of clearing. The contract verifies a clearing proposal on chain (every member is balanced and the cleared amount does not exceed the obligation, `ERR_UNBALANCED_MEMBER` and `ERR_CLEARED_EXCEEDS_OBLIGATION`) before it is applied in `commit_epoch`.

**Input safety.** An implementation MUST refuse, not normalise, a `cumulativeAmount` with leading zeros or above U128, a non-ASCII `resource`, a `unit` other than `credit`, and an `epoch` or `seq` that is not an integer >= 1. Comparison of amounts MUST use big integers, not floating point.

### 12. Test vectors

The files in `test-vectors/` are the single source that the TypeScript CI (`@x207/core`, `@x207/scheme`) and the Rust CI of the contract `x207-circle` read. Plain JSON only: amounts as decimal strings, bytes as hex, keys as `ed25519:<base58>`.

| File | Content |
| --- | --- |
| `keys.json` | Ed25519 seeds and public test keys (`kA`, `kB`, `kC`, `kD`, `kOther`, `kZ`) |
| `voucher/valid.json` | A valid voucher: canonical bytes, nonce, hash, signature |
| `voucher/tampered_<field>.json` | One file per changed voucher field; verification MUST fail |
| `voucher/bad_signature.json` | A broken signature (`invalid_signature` / `ERR_BAD_SIGNATURE`) |
| `voucher/seq_stale.json`, `voucher/seq_backwards.json` | Replay and a `seq` that goes backwards (`seq_not_increasing` / `ERR_SEQ_NOT_INCREASING`) |
| `voucher/past_cutoff.json` | A voucher after the cutoff (`epoch_closing` / `ERR_PAST_CUTOFF`) |
| `payload/payment_signature_agents_main.json` | A `PaymentPayload` and the value of the `PAYMENT-SIGNATURE` header |
| `payload/client_seq1_seq2.json` | Two successive client payloads (`seq 1` and `seq 2`) with their headers |
| `clearing/*.json` | Clearing cases: valid, clearing above the obligation, unbalanced member |
| `constants.json` | `CREDIT_DECIMALS`, `CREDIT_UNIT`, external contract accounts, RPC and service endpoints |

A conformance suite (`npm run conformance` in the `sdk` repository) runs 54 cases against any implementation through a line-based adapter protocol; the TypeScript reference adapter and an independent Python implementation (`sdk/python/`) both pass all 54.

### 13. Reference implementation

`@x207/core` (types, validators, `signVoucher`, `verifyVoucher`), `@x207/scheme` (client, server and facilitator roles), and `apps/facilitator` (Hono) in the `sdk` repository. The contract `x207-circle` is in the `contracts` repository. Results so far come from a local NEAR sandbox and from rehearsals on NEAR testnet with a mock USDT; there is no mainnet result.
