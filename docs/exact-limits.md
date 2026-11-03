# Limits of the `exact` NEP-366 route of the facilitator

Status: built and tested (`apps/facilitator/test/exact-limits.test.ts`, TC-SR3-20 to TC-SR3-26). Source: `apps/facilitator/src/exact-guard.ts`. Origin: the cross review of the SDK (`backend/docs/security-review-2.md`) and `docs/security-review-3.md` of the umbrella.

## The problem
For `exact` (`@x402/near`) the **relayer** of the facilitator signs and pays the outer transaction of a delegate action. The payer can pass `/verify` and then make the inner `ft_transfer` fail (move the USDT away, or use the nonce of the access key in another transaction). The relayer pays the gas of that transaction and nothing comes back. `/settle` is open to everybody, so a funded account can repeat it until the relayer balance is gone. `/verify` costs the attacker nothing and costs the facilitator several RPC views.

## What is limited
| Limit | Default | Setting | What it does |
| --- | --- | --- | --- |
| Sponsored gas | 30 Tgas (what the standard `@x402/near` client attaches to `ft_transfer`; the library allows 100) | `exactMaxSponsoredGas` / `X207_EXACT_MAX_SPONSORED_GAS` (gas units) | A delegate action that asks more is refused at `/verify` with `invalid_exact_near_payload_gas_limit_exceeded`. A client that sets a higher gas of its own is refused; raise the setting if you serve such a client. |
| Failed settlements per payer | 3 inside 10 minutes, then a pause of 10 minutes | `exactGuard` (`failureLimit`, `failureWindowMs`, `pauseMs`) / `X207_EXACT_FAILURE_LIMIT`, `X207_EXACT_PAUSE_MS` | Counts settlements that were submitted and failed (`errorReason: "settlement_failed"`, the relayer paid). A paused payer gets `success: false, errorReason: "payer_paused"` **before** anything is submitted. A success clears the count. |
| Requests per client | 600 per minute on `/verify` and `/settle` together (a seller calls both once per paid request, so about 300 paid requests per minute per seller address) | `createApp(service, { rateLimit })` / `X207_RATE_LIMIT_MAX` (`0` = off), `X207_TRUST_PROXY=1` | Above the limit: `429`, `Retry-After`. `/supported` and `/x207/pair-state` are not limited. |

The payer in the failure counter is the `senderId` of the delegate action **only when its signature is valid**; a forged payload names nobody, so it cannot pause another account (TC-SR3-22) and it never reaches the relayer.

## What it does not do
- All state is in the memory of one process and is lost on restart. Several facilitator processes each keep their own counters.
- A client is the address of the socket, or the first `x-forwarded-for` when `X207_TRUST_PROXY=1`. Behind a proxy that does not set the header, every request has the address of the proxy; behind one that lets the client set it, a client can choose its key. Set it only behind a proxy you control.
- An attacker with many funded accounts spends 3 failures per account per 10 minutes. The cost to the relayer per failure is the gas of the outer transaction (well under the 30 Tgas cap, which is refunded when unused). **The balance of the relayer is the last limit; alert on it.** A cap per day for the whole relayer was not built.
- `/verify` is not stopped for a paused payer; it only costs RPC views, bounded by the rate limit.
- The x207 route (`batch-settlement`) is not covered: its `/settle` stores a voucher and the scheduler pays gas only for registrations the contract can accept.
