# Proposal to the x402 Foundation (SD-046): local drafts only

Status: **drafts, nothing sent.** Opening an issue or a pull request in `x402-foundation/x402` is an outward action that a human owner does or confirms. No link exists yet, so none is recorded in the README of this repository.

| File | What it is |
| --- | --- |
| `issue-draft.md` | Discussion issue: what x207 binds, what it asks the maintainers |
| `pr-draft.md` | Pull request description for the spec `specs/schemes/batch-settlement/scheme_batch_settlement_x207.md` |

Checked against `CONTRIBUTING.md` of the x402 repository on 2026-11-02:

- The recommended path for a new scheme is a PR that contains the spec; an issue is for concrete proposals. Chain-specific specs live at `specs/schemes/<scheme>/scheme_<scheme>_<chain>.md` and must give the payload structure, verification logic and settlement logic. Merging is at the maintainers' discretion and implementation starts after the spec is merged.
- All commits must be signed. AI-assisted contributions need human review before a non-draft PR, and significant AI use should be disclosed in the PR description.

Before sending, a human must:

1. Translate `spec/scheme_batch_settlement_x207.md` into English (it is written in Indonesian) and add the `bundleId` payload field described in `spec/barter-format.md`, section "Voucher leg bundle". The spec already holds the grant endpoint rule (`extra.grantId`, `grant_resource_mismatch`, SD-053). Checked against the spec and the suite on 2026-11-02: the drafts follow the current format (54 conformance cases; contract interface 0.0.7 adds escrow methods and events that the binding does not use). Keep the filename and folder the x402 repository expects.
2. Read `specs/CONTRIBUTING.md` and `specs/scheme_template.md` of the x402 repository again; this checklist was written from a summary.
3. Decide the account and signed commits to use, review the text, and confirm the claims in the drafts still hold.
