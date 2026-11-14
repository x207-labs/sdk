# Proposal to the x402 Foundation (SD-046)

Status: **the issue is open upstream, not accepted yet:** [x402-foundation/x402#4131](https://github.com/x402-foundation/x402/issues/4131) (opened 2026-11-04, state `OPEN` on 2026-11-14). No pull request with the spec has been opened; `pr-draft.md` stays a local draft. The checklist below is what a human does before that pull request.

| File | What it is |
| --- | --- |
| `issue-draft.md` | Discussion issue: what x207 binds, what it asks the maintainers |
| [`../../spec/scheme_batch_settlement_x207.md`](../../spec/scheme_batch_settlement_x207.md) | The spec itself (English, includes the `bundleId` section); the single source, and the file for the pull request |
| `pr-draft.md` | Pull request description for the spec `specs/schemes/batch-settlement/scheme_batch_settlement_x207.md` |

Checked against `CONTRIBUTING.md` of the x402 repository on 2026-11-02:

- The recommended path for a new scheme is a PR that contains the spec; an issue is for concrete proposals. Chain-specific specs live at `specs/schemes/<scheme>/scheme_<scheme>_<chain>.md` and must give the payload structure, verification logic and settlement logic. Merging is at the maintainers' discretion and implementation starts after the spec is merged.
- All commits must be signed. AI-assisted contributions need human review before a non-draft PR, and significant AI use should be disclosed in the PR description.

Before sending, a human must:

1. Read `spec/scheme_batch_settlement_x207.md` against the code. The spec already holds the grant endpoint rule (`extra.grantId`, `grant_resource_mismatch`, SD-053) and the `bundleId` section. Checked against the spec and the suite on 2026-11-02: the drafts follow the current format (54 conformance cases; contract interface 0.0.7 adds escrow methods and events that the binding does not use). Keep the filename and folder the x402 repository expects when it goes into the pull request.
2. Read `specs/CONTRIBUTING.md` and `specs/scheme_template.md` of the x402 repository again; this checklist was written from a summary.
3. Decide the account and signed commits to use, review the text, and confirm the claims in the drafts still hold.
