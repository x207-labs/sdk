# Draft issue: a credit-backed binding of `batch-settlement` on NEAR (`x207:<circleId>`)

**Not sent.** Title proposal: `Discussion: credit-backed binding of batch-settlement (x207) with multi-party clearing`

## What we built

x207 is a binding of the existing `batch-settlement` scheme on a new network family, `x207:<circleId>`. It does not define a new scheme name. The 402 flow, the payment payload and the facilitator endpoints are the x402 ones. What differs is what backs a voucher:

- Members of a *credit circle* stake USDT on a NEAR contract and get a credit limit from the stake. A voucher is a cumulative, signed (ed25519, NEP-413 payload) promise per payer, payee and epoch; it is checked against the limit, not against an escrow channel.
- Vouchers are registered on chain once per pair and epoch. At the end of the epoch a solver removes debt cycles across all members in one transaction and only the net positions are settled in USDT.
- A seller advertises an `exact` entry next to the x207 entry in the same `accepts` list. A buyer without headroom, or outside the circle, pays through `exact`.

## What is in the repository

A reference facilitator (`/verify`, `/settle`, `/supported`), client, server and facilitator roles for the scheme, test vectors shared with the contract tests, and a conformance suite (`npm run conformance`) that another implementation can run. The spec is `spec/scheme_batch_settlement_x207.md`. Results so far come from a local NEAR sandbox, not from a public network.

## What we ask

1. Is a binding for a non-EVM network that backs vouchers with a credit limit rather than an escrow channel in scope for the `batch-settlement` scheme, or should it be a separate scheme name?
2. Is `x207:<circleId>` acceptable as a network identifier (we validate it against the CAIP-2 pattern; the circle contract account travels in `extra.circleContract`)?
3. Is the settle response `extensions` field the right place for per-voucher registration status (we use `extensions.x207`)?
4. Would the maintainers prefer the spec as a PR now, or a shorter proposal first?

## What we do not claim

That x402 lacks credit or clearing beyond what the `batch-settlement` documents we read describe (EVM escrow channels, one payer and one receiver). We did not review other x402 layers. We do not claim audited security, mainnet results, or adoption.
