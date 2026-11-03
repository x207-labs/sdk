# Service order (SD-069, pipeline P6, ADR-45)

An order is the agreement of a buyer and a seller on work. On the chain there is only an ordinary voucher whose `resource` is `x207:order:<hash>`; the contract does not change. All of this is in `@x207/core` (`order.ts`).

| Piece | Function |
| --- | --- |
| Document, canonical JSON, sha256 | `serializeOrder`, `orderHash`, `normalizeOrder` |
| Resource of the voucher | `orderResource`, `parseOrderResource` |
| Budget (sum of the milestones) | `orderBudget` |
| Lock of the budget as a bundle, like SD-067 | `orderBundleTerms` |
| Voucher of a milestone after it is confirmed (needs `paid`, the milestones already paid) | `milestoneVoucher` |
| Ledger of the buyer for one order: remembers the milestones and proofs paid, also across a restart, and stops at the budget | `OrderLedger` (`payMilestone`, `payProofs`, `snapshot`, `restore`) |
| Voucher per on-chain proof (keeper, solver, delegate) | `payForProofs` |
| Mandate of a delegate order | `normalizeMandate`, `serializeMandate`, `mandateHash` |
| Claim of a delegate's transaction | `orderClaimNotice`, `signOrderClaim` |

Document keys, in this order: `circle, kind, buyer, seller, spec_hash, milestones[{amount, due_at}], sample_hash, target, proof{method, amount_per_tx}, nonce`; what is empty is `null`. A `delegate` order has one more key, `mandate_hash`, between `proof` and `nonce`; the other kinds do not carry it at all, so the hash of every order that existed before is unchanged.

## Kinds and patterns
`milestone` (paid per milestone after confirmation or after the dispute window, ADR-42): `prompt` #39, `research` #40, `translation` #41, `annotation` #42, `scraping` #43, `audit` #52, `loadtest` #53, `freelance` #83. `outcome` (paid per accepted result; each milestone is one place for a result): `lead` #51, `bug` #88. `proof` (paid per transaction of the provider that is visible on the chain): `keeper` #46 (`close_epoch` or `finalize_epoch`), `solver` #48 (`submit_clearing`). `delegate` #16 (SD-072, ADR-47): a token owner pays a delegate to research and vote on a DAO according to a public mandate; it is paid per vote that shows on the chain (see below). Monitoring (#54, per day) and consulting (#84, per minute) are metered like P5 and use a metered endpoint, not an order.

## Rules inside the document
- `prompt` needs `sample_hash`: a result that is easy to copy must have a locked sample, or it can be copied and then disputed.
- `loadtest` needs `target`, a public host name (no IP, `localhost`, `.local`, `.internal`). The backend checks that the buyer controls it (`/.well-known/x207-loadtest` or a DNS TXT with the hash of the order) before the order is accepted, so that x207 is not a market for DDoS.
- `keeper`, `solver` and `delegate` need `proof`; other kinds must not have one.
- `delegate` needs `mandate_hash` (`order_mandate_required`, a bad value is `order_bad_mandate`); other kinds must not have one (`order_mandate_forbidden`).
- 1 to 24 milestones, positive amounts, `due_at` increasing.

## Budget lock and the voucher of a milestone
The budget is locked as a bundle with two legs (buyer to seller for the amount, plus the one-unit counter leg the contract needs), as in SD-067. A bundle lives in one epoch only: milestones that fall due in different epochs need a bundle per epoch (`orderBundleTerms` takes the `amount` of the group; `epochForTime` maps `due_at` to an epoch).

The voucher of a milestone is built **after** the milestone is confirmed (or after the dispute window), from the real state of the pair (`milestoneVoucher`). A disputed milestone is not paid and leaves the state as it was, so the next voucher does not carry it. There is no chain of vouchers signed in advance for several milestones: a cumulative voucher cannot skip a milestone.

## payForProofs
`alreadyPaid` and `alreadySpent` are required (review BE-062, F4): a call that does not say what was paid before is refused, because an agent that runs again with the same proofs would pay them again. The easy way is `OrderLedger`. `verifyTx` is optional: it asks the chain whether a proof is a real transaction of that provider and method; a proof it denies is `unverified`.

For a `keeper` or `solver` order the buyer's agent takes the proofs from the backend (`GET orders/{hash}/onchain-proofs`) and signs one voucher per proof of `proof.amount_per_tx`. A proof is refused (not paid) when it was signed by another account (`wrong_signer`), uses another method (`wrong_method`), was paid before (`already_paid`, also inside one list), or would pass the budget of the order (`over_budget`). The vouchers continue the state of the pair in the epoch given.

## Errors (`OrderError.code`)
`order_bad_kind`, `order_bad_account`, `order_same_party`, `order_bad_hash`, `order_sample_required`, `order_target_required`, `order_target_forbidden`, `order_bad_target`, `order_bad_milestones`, `order_bad_amount`, `order_bad_proof`, `order_bad_nonce`, `order_bad_resource`, `order_not_proof_kind`, `order_bad_state`.

## Delegate order (SD-072)
The owner of a token pays a delegate for research and for votes cast according to a **public mandate**: `DelegateMandate {circle, dao, kinds, rules_hash}`, canonical JSON with those keys and `kinds` sorted, `mandate_hash = mandateHash(mandate)`. `dao` is the account of the DAO, `kinds` are the proposal kinds the delegate may be paid for (the variants of `ProposalKind` of Sputnik v2 in snake_case, for example `transfer`, `function_call`, `vote`; each matches `^[a-z][a-z0-9_]{1,31}$`, at most 16), `rules_hash` is the sha256 of the text of the rules, which stays off the chain. The backend receives the mandate with the order and checks `mandateHash(mandate) == mandate_hash`.

`proof.amount_per_tx` is the **price of one vote**, not of one transaction. The vote is on the DAO, not on the x207 contract, so the indexer does not see it: the delegate claims each transaction with a signed notice (`orderClaimNotice`, keys `circle, order_hash, actor, action: "claim", at, tx_hash`, signed by `signOrderClaim`) sent to `POST orders/{hash}/claims`, the backend checks the transaction through RPC, and `onchain-proofs` then lists it with `receiver`, `proposal_id`, `action` and `proposal_kind`.

`payForProofs` (or `OrderLedger.payProofs`) needs the `mandate` for a delegate order and pays a proof only if all of these hold, in this order of refusal:
1. `signer` is the seller (`wrong_signer`);
2. `receiver` is `mandate.dao` (`wrong_receiver`);
3. `method` is the one of the order (`wrong_method`); the default is `PROOF_METHODS.delegate = ["act_proposal"]`, and a DAO that uses another method passes `options: { delegateMethods }` to `normalizeOrder`, `serializeOrder`, `orderHash` and `payForProofs` (the method of veNEAR has not been checked yet);
4. `action` is `VoteApprove` or `VoteReject` (`not_a_vote`): `act_proposal` is also used for `Finalize`, `VoteRemove` and others, which are not paid;
5. `proposal_kind` is in `mandate.kinds` (`kind_not_in_mandate`);
6. the `proposal_id` was not paid before (`already_paid`): a proposal is paid **once**, however many transactions the delegate sends on it (the ledger stores `proposal:<id>`);
7. the budget of the order is not passed (`over_budget`).

The delegation can be revoked at any time: the buyer stops paying (the ledger has nothing more to pay), and the DAO side is closed by the `dao-vote` adapter of the broker (BE-061).

Limits: the SDK trusts the proofs that the backend lists; `verifyTx` is the hook to ask the chain again. The mandate says which kinds are paid, not how the delegate should vote: `rules_hash` is evidence of what was promised, and a dispute over it is not decided here.
