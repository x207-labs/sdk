# Payment guarantees for sellers

A seller receives a voucher that is not necessarily on chain yet when the response is sent. The following four things keep the risk small and bounded.

1. **Facilitator verification before the handler.** `/verify` runs 19 ordered checks (voucher signature, `active` member, epoch and `cutoff`, increase of `seq` and cumulative, headroom including vouchers that are not yet registered) and stops at the first refusal. The middleware calls the handler only when `isValid` is `true`, and calls `/settle` only when the handler succeeds (status < 400).
2. **Registration before `cutoff`.** The facilitator stores the latest voucher of each pair, then sends `register_cumulative` when the cumulative difference passes the threshold (default 1 credit) and at `cutoff_at − 120 seconds`. Failures are retried after 5, 10, 20, 40, then 60 seconds until `cutoff_at`. A new voucher from a payer whose registration failed twice is refused (`registration_retry_pending`).
3. **MVP invariant `limit ≤ stake`.** A member's credit limit never exceeds its stake, so a registered obligation always has a guarantee. An unpaid residual is cut from the stake at `finalize_epoch`.
4. **Risk limited to the registration gap.** What the contract does not yet guarantee is only the difference `cumulative_amount − registered_cumulative` per pair: vouchers that were accepted but are not (or failed to be) registered. That difference is written to the facilitator log if registration still fails by `cutoff` (the `failed` line).

Basis of the decision: ADR-17 (cumulative registration and threshold) and ADR-18 (stake guarantee) in the design note `x207 - Keputusan Desain`; ADR-23 for retries and the refusal of new vouchers.
