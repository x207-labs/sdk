# Costs: when there is an on-chain transaction

Paying with an x207 voucher does not send a NEAR transaction per call. In short:

| Event | On-chain transaction? | Who pays the gas |
| --- | --- | --- |
| An agent pays one x402 call (new voucher) | No. The voucher is signed on the client and checked by the facilitator | No one |
| `/settle` stores the voucher | No. The facilitator keeps the latest voucher of each pair in the pending store D3 | No one |
| Registration `register_cumulative` | Yes, **one per (payer, payee) pair per epoch**, not per call | The facilitator relayer account |
| `join` and stake | Yes, once per member | The agent |
| `close_epoch`, `submit_clearing`, `commit_epoch` | Yes, one per epoch for the whole circle | Keeper and solver |
| Settling the residual and `claim` | Yes, only for net positions | The party concerned |

## Cumulative vouchers

Each voucher holds the `cumulativeAmount` for that pair and epoch and a `seq` that always goes up. A newer voucher replaces the old one, so the contract only needs the last voucher. 300 calls between two agents in one epoch become one registration, not 300 transactions.

The facilitator registers a pair when the difference between the latest cumulative and the registered one passes a threshold (default 1 credit, `registerThreshold`) and, whatever the value, 120 seconds before `cutoff_at`. Failures are retried after 5, 10, 20, 40, then 60 seconds until `cutoff_at`.

## Numbers from this repository

The sandbox `npm run demo:sandbox` (from the umbrella root) runs 120 paid calls between six agents at `medium` density and records 12 registrations. That result is recorded in section 4 of the umbrella README; the number depends on the density of the graph (who buys from whom), so it is not a constant.

## Gas cost

One NEAR function call uses about 10 to 30 TGas, which at the time of the ADR-17 decision was counted at about 0.004 to 0.013 dollars. This number is an estimate from the design notes, not a result we measured on mainnet; measure again before using it to compute a budget.

## Why it works this way

The decision is ADR-17 in the design note `x207 - Keputusan Desain`: registration per call makes the gas cost higher than the price of a cheap call, so x207 copies the `batch-settlement` pattern of x402 on EVM with cumulative vouchers. The seller's risk is only the difference of registrations that are not yet registered (see [Payment guarantees for sellers](seller-guarantees.md)). Registration per call (ADR-07) stays as a demo mode.
