# RPC requests per paid call (facilitator and buyer)

Measured in `near-sandbox` with `apps/facilitator/test/rpc-load.sandbox.test.ts` on 2026-11-03: a real contract, three members, six payer-payee pairs, 96 payments through the seller and the facilitator, JSON-RPC requests counted at the `fetch` of each side. Why it was measured: a testnet run of the network demo stalled after about 17 paid calls because the public RPC answered HTTP 429 and then timed out.

## Before: no cache

| Side | Requests per payment | By view |
| --- | --- | --- |
| Facilitator, `/verify` plus the second `verify` inside `/settle` | 12.0 | `member` 4.0, `obligation` 3.9, `get_epoch` 2.0, `headroom` 2.0 |
| Buyer (`createBuyerFetch`) | 0.03 | `member` and `headroom` once per client, then kept |

One verify is `get_epoch`, `member` of payer and payee, `headroom`, and one `obligation` for the base of the pair plus one for every other pending row of the payer; `/settle` runs verify again.

## After: `chainCache` (a few seconds, in `apps/facilitator/src/chain-cache.ts`)

| Side | Requests per payment after the first round | By view |
| --- | --- | --- |
| Facilitator | 0.13 (96 payments in about 25 seconds) | `obligation` 0.13, `member` 0.06, `headroom` 0.06, `get_epoch` 0.01 |
| Buyer | 0.03 | unchanged |

The number depends on the payment rate: the cache bounds the requests per second, not per payment. Upper bound with everything in use at once: `members / 10 + payers / 10 + pairs / 10 + 1 / 30` requests a second, which is about 2.2 a second for six members and twelve pairs, however many payments there are.

## How stale a read may be, and what that costs

| Read | Kept for | If it is stale |
| --- | --- | --- |
| `get_epoch` | 30 s | The clock check (`epoch_closing` from `cutoff_at - flushLead`) does not depend on it, so no voucher gets in for a closed epoch. After `close_epoch` a voucher of the new epoch is refused `epoch_mismatch` for up to 30 s. |
| `member` | 10 s (the same as `headroom`) | A member suspended or leaving in the last 10 s still gets vouchers accepted, but only up to the headroom that was cached: each accepted voucher lowers the headroom that `verify` computes, so the total is at most the limit of the member (itself at most its stake), once per event, and after 10 s the real `0` is read and the payer is refused. The registrations fail on chain and the rows are dropped. |
| `headroom`, `obligation` | 10 s | Own registrations drop them at once (`invalidatePayer`). A `commit_bundle` is seen after up to 10 s; a voucher beyond the new limit can pass `verify` and then fails on chain. A registration by **another relayer** is not seen for up to 10 s either: with no pending row the base of a voucher is the cached `obligation`, so vouchers that the chain already counts pass `/verify` once each in that window (at most the cumulative the other relayer registered for that pair); their registration fails on chain. |
| `get_bundle` | 30 s | Legs and status do not change inside an epoch. |

**Assumption: one relayer registers the vouchers of a pair.** With two relayers on one circle, set `obligationMs` to 0 or give each relayer its own pairs. In every case the contract refuses what the limit does not cover, so nothing here creates debt; the exposure is the seller delay risk that the binding already states (ADR-23): vouchers accepted and not yet registered. The cache is off in `createFacilitatorService` unless `chainCache` is passed, and on in `main.ts` (`X207_CHAIN_CACHE=off` turns it off). No rule of the binding changed; the TTLs are an operator choice and the binding (section 6) does not say how fresh the reads are.

## Further reduction that needs a decision

`computeHeadroom` reads the registered amount of every pending pair from the chain. The facilitator already stores what it registered (`registeredCumulative` in D3), so it could subtract that locally and skip the `obligation` reads; the only difference is a registration by another relayer, where the local figure is lower and the check is more cautious. That changes the formula of section 6.1, so it is left for the coordinator.
