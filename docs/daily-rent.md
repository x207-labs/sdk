# Daily rent of an access (SD-071, pipeline P2, ADR-47)

An access (a repository, a role, an SSH key, a cloud role) is rented per day. The lessee pays one day in advance and signs the voucher of the next day **only if the access still works**, so each side loses one day at most. The pattern is the one of `BuyerMeter` (SD-068): the check is on the side of the payer, and without it no voucher is signed.

| Piece | Where |
| --- | --- |
| `checkAccessBeforeNextDay({ grantId, view, nowMs, directCheck? })`: the broker says `active`, the paid day is not over, and the direct check of the provider (a login, a request) passes | `@x207/core` (`rent-check.ts`), also used by the rent page of the frontend |
| `DailyRent`: `checkBeforeNextDay`, `signDay` (one voucher per day, `resource` `x207:grant:<id>`), `checkBill` and `signBill` (real cost of the day up to `daily_cap`, `resource` `x207:grant:<id>:cost`), `stop` | `@x207/scheme` (`client/daily-rent.ts`) |
| Proof of the `grantee_ref`: `near-gist`, `ssh-signature`, `oauth` | `@x207/core` (`grantee-proof.ts`) |

The `view` is the answer of the broker `GET /grants/{id}/access` (BE-060). Costly access (cloud roles, an org with a spending limit) is billed at the real cost of the day, taken from the provider by the broker; a bill above the `daily_cap` of the scope is **not signed** and the rent stops (`rent_bill_over_cap`). An access with no cap is not billed for real cost at all.

## Errors (`RentError.code`)
`rent_access_not_active` (the broker says `revoked` or `revoke_pending`), `rent_access_expired` (the paid day is over), `rent_direct_check_failed`, `rent_bill_over_cap`, `rent_bad_cap`, `rent_day_already_paid`, `rent_stopped`, `rent_bad_state`.

## Proof of the `grantee_ref`
The reference is fixed on the chain when the grant is made, so a grant cannot be moved to another account, and a renter must show it controls the account it names. The challenge is a fixed text that binds the circle, the grant, the reference and a nonce of the broker (`granteeChallenge`), so a proof of one grant is worth nothing for another.
- `near-gist`: the renter puts `buildGistContent(...)` (the challenge signed with its voucher key, the NEP-413 scheme of every notice) in a public gist; the owner of the gist must be the `grantee_ref` (a GitHub login). `verifyNearGistProof` takes the gist through an injected `GistFetcher`.
- `ssh-signature`: the `grantee_ref` is an OpenSSH `ssh-ed25519` line; the proof is the ed25519 signature of the challenge by the private key (`signSshChallenge`, `verifySshProof`).
- `oauth`: the provider says whose the token is (`verifyOAuthProof`); the SDK carries the form and checks the subject against the reference. The token is short-lived and is not stored.

`encodeGranteeProof` and `parseGranteeProof` give the text that the renter sends as `proof` (at most 2048 bytes). Errors (`GranteeProofError.code`): `grantee_proof_bad_format`, `grantee_proof_wrong_challenge`, `grantee_proof_bad_signature`, `grantee_proof_owner_mismatch`, `grantee_proof_unverifiable`.

## Limits
- `ssh-signature` is a raw ed25519 signature over the text of the challenge, not the SSHSIG format of `ssh-keygen -Y sign`; only ed25519 keys.
- A `near-gist` proof depends on GitHub answering, and trusts GitHub on who owns a gist.
- The check before the next day cannot see an access that the provider closed in the minutes after the check: the loss is at most the day that was paid.
- A presigned URL or an STS session cannot be taken back; `revoke` only forgets it, and the loss is the paid day.
