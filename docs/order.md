# Service order (SD-069, pipeline P6, ADR-45)

An order is the agreement of a buyer and a seller on work. On the chain there is only an ordinary voucher whose `resource` is `x207:order:<hash>`; the contract does not change. All of this is in `@x207/core` (`order.ts`).

| Piece | Function |
| --- | --- |
| Document, canonical JSON, sha256 | `serializeOrder`, `orderHash`, `normalizeOrder` |
| Resource of the voucher | `orderResource`, `parseOrderResource` |
| Budget (sum of the milestones) | `orderBudget` |
| Lock of the budget as a bundle, like SD-067 | `orderBundleTerms` |
| Voucher of a milestone after it is confirmed | `milestoneVoucher` |
| Voucher per on-chain proof (keeper, solver) | `payForProofs` |

Document keys, in this order: `circle, kind, buyer, seller, spec_hash, milestones[{amount, due_at}], sample_hash, target, proof{method, amount_per_tx}, nonce`; what is empty is `null`.

## Kinds and patterns
`milestone` (paid per milestone after confirmation or after the dispute window, ADR-42): `prompt` #39, `research` #40, `translation` #41, `annotation` #42, `scraping` #43, `audit` #52, `loadtest` #53, `freelance` #83. `outcome` (paid per accepted result; each milestone is one place for a result): `lead` #51, `bug` #88. `proof` (paid per transaction of the provider that is visible on the chain): `keeper` #46 (`close_epoch` or `finalize_epoch`), `solver` #48 (`submit_clearing`). Monitoring (#54, per day) and consulting (#84, per minute) are metered like P5 and use a metered endpoint, not an order.

## Rules inside the document
- `prompt` needs `sample_hash`: a result that is easy to copy must have a locked sample, or it can be copied and then disputed.
- `loadtest` needs `target`, a public host name (no IP, `localhost`, `.local`, `.internal`). The backend checks that the buyer controls it (`/.well-known/x207-loadtest` or a DNS TXT with the hash of the order) before the order is accepted, so that x207 is not a market for DDoS.
- `keeper` and `solver` need `proof`; other kinds must not have one.
- 1 to 24 milestones, positive amounts, `due_at` increasing.

## Budget lock and the voucher of a milestone
The budget is locked as a bundle with two legs (buyer to seller for the amount, plus the one-unit counter leg the contract needs), as in SD-067. A bundle lives in one epoch only: milestones that fall due in different epochs need a bundle per epoch (`orderBundleTerms` takes the `amount` of the group; `epochForTime` maps `due_at` to an epoch).

The voucher of a milestone is built **after** the milestone is confirmed (or after the dispute window), from the real state of the pair (`milestoneVoucher`). A disputed milestone is not paid and leaves the state as it was, so the next voucher does not carry it. There is no chain of vouchers signed in advance for several milestones: a cumulative voucher cannot skip a milestone.

## payForProofs
For a `keeper` or `solver` order the buyer's agent takes the proofs from the backend (`GET orders/{hash}/onchain-proofs`) and signs one voucher per proof of `proof.amount_per_tx`. A proof is refused (not paid) when it was signed by another account (`wrong_signer`), uses another method (`wrong_method`), was paid before (`already_paid`, also inside one list), or would pass the budget of the order (`over_budget`). The vouchers continue the state of the pair in the epoch given.

## Errors (`OrderError.code`)
`order_bad_kind`, `order_bad_account`, `order_same_party`, `order_bad_hash`, `order_sample_required`, `order_target_required`, `order_target_forbidden`, `order_bad_target`, `order_bad_milestones`, `order_bad_amount`, `order_bad_proof`, `order_bad_nonce`, `order_bad_resource`, `order_not_proof_kind`, `order_bad_state`.
