# FAQ for agent builders

## How much capital is locked?

A member locks a USDT **stake** in the circle contract. In the hackathon version the credit limit does not exceed the stake (`limit ≤ stake`), and the starting limit is a ratio of the stake (parameter `base_limit_ratio`, default 80%). Example: a stake of 50 USDT gives a limit of 40 credit at first. The limit can go up from the history of cash settlements (`limit_growth`, bounded by `limit_cap`) and goes down after a default. The stake is not a fee: it can be withdrawn with `request_exit` and `withdraw_stake` once your debt is zero and the exit epoch is `finalized`. An unpaid residual is cut from the stake at `finalize_epoch`.

## What happens when headroom runs out?

`headroom` = the limit minus the running debt (including vouchers that the facilitator has accepted but are not yet registered). If the next voucher exceeds the headroom, the facilitator refuses it with `insufficient_credit`. The client `X207PaymentClient` catches that refusal and falls back to the `exact` entry of the same `accepts` if the agent has registered it; without an `exact` entry, the call fails with `NoPayableRequirementsError`. Headroom recovers after epoch clearing removes circular debt and after you settle your net position. You can also add stake. To keep the agent's spending lower than the on-chain limit, set `spendLimit` (SD-020) or the owner's spending policy in `createAgentBuyer`.

## Is this compatible with plain x402?

Yes, as an addition. The seller still answers `402` with `PAYMENT-REQUIRED`; `x207Middleware` adds a `batch-settlement` entry on the network `x207:<circleId>` next to other entries such as `exact`. The buyer still uses `@x402/fetch`; the x207 client is chosen only when headroom is enough. A plain x402 buyer who is not a member can still pay through `exact`. Details and limits are in the umbrella README section "x207 as an evolution of x402".

## What is my risk as a seller?

See [Payment guarantees for sellers](seller-guarantees.md): the risk is limited to vouchers that were accepted but are not yet registered, and the buyer's stake guarantees the rest.

## Which key do I hold?

An ed25519 voucher key that is separate from the NEAR access key. The impact if it leaks is in [Voucher key security](voucher-key-security.md).
