# x207 SDK

The public x207 SDK: the x402 `batch-settlement` binding, *credit-backed* model, on the network `x207:<circleId>`, plus a reference facilitator and test vectors. Part of [`x207-labs/x207`](https://github.com/x207-labs/x207). Modules M2 and M3, features F2, F4, F5.

| Folder | Package | Module | Feature | Contents |
| --- | --- | --- | --- | --- |
| `packages/core/` | `@x207/core` | M2, M3 (shared library) | F2, F4, F5 | Voucher types, signing, client for the `x207-circle` contract, NEP-297 event parser |
| `packages/scheme/` | `@x207/scheme` | M2 | F2, F5 | x402 binding per role: `client/`, `server/`, `facilitator/` |
| `apps/facilitator/` | `@x207/facilitator` | M3 | F2 (F4 optional) | Reference facilitator: `/verify`, `/settle`, `/supported` |
| `spec/` | — | M2 | F2 | `scheme_batch_settlement_x207.md` and `test-vectors/`, the single source of the voucher format for the TypeScript and Rust CI |

Contract referred to: `x207-circle` (M1). Storage touched: D1, D2, D3 (the facilitator pending store), D7.

## Development

Needs Node ≥ 22.22.2 and npm 11. All dependencies are pinned exactly.

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
```

Tests that need a near-sandbox node and the contract wasm (`../contracts/target/near/*.wasm`, the output of `cargo near build`) are skipped by `npm test` and run separately:

```bash
npm run test:sandbox
```

The near-sandbox binary is looked up in `X207_SANDBOX_BIN`, or in the build output of the `contracts` repo after `cargo test` has run once.

Copy the facilitator configuration from `.env.example` to `.env`. Secrets live only in `.env`, which is not committed.

## Quickstart for agent builders (buyer)

The `@x207/*` packages are not published yet; the steps below use a clone of this repo (`npm install` sets up the workspace). Requirements: an agent NEAR account with USDT, and a running x207 circle (the `x207-circle` contract address, the `circleId`, and the hash of the circle terms from its operator).

1. **Install and build.** `npm install`, then `npm run build`.
2. **Voucher key.** The agent uses one ed25519 key just for vouchers. This key is not a NEAR access key and cannot move assets; read the impact if it leaks in [Voucher key security](docs/voucher-key-security.md).
3. **Onboarding (join + stake).** `onboardMember` creates the voucher key, sends `join`, sends the stake through `ft_transfer_call`, and waits for the status `active`. The transactions are signed by the access key of the account owner:

   ```ts
   import { onboardMember, createCircleViewFn } from "@x207/core";
   import { createNearSender } from "@x207/core/signer";

   const view = createCircleViewFn({ circleContract: "x207-circle.near" });
   const { secretKey, member } = await onboardMember(
     { sendCall: createNearSender({ rpcUrl, accountId: "agent.near", secretKey: ownerAccessKey }), view },
     { circleContract: "x207-circle.near", circleId: "agents-main", accountId: "agent.near", termsHash, stakeAmount: "50000000" },
   );
   // keep `secretKey` (the voucher key) in a secret place; member.status === "active"
   ```

4. **Register `x207:*` and call.** One `@x402/fetch` wrapper; `X207PaymentClient` already registers `x207:*` and falls back to the `exact` entry when headroom runs out:

   ```ts
   import { wrapFetchWithPayment } from "@x402/fetch";
   import { X207PaymentClient, headroomFromRpc } from "@x207/scheme";

   const client = new X207PaymentClient({ payer: "agent.near", secretKey, headroom: headroomFromRpc({}) });
   const paidFetch = wrapFetchWithPayment(fetch, client);
   const response = await paidFetch("https://seller.example/api/summarize");
   ```

5. **Read the result.** A 200 response carries the header `PAYMENT-RESPONSE` (base64 JSON): `transaction` holds the commitment id `<payer>:<payee>:<epoch>:<seq>` and `extensions.x207.registration` holds `pending`, `retrying`, or `registered`.

Full tested example: [`examples/buyer`](examples/buyer). It runs against near-sandbox through `npm run test:sandbox`.

## Seller quickstart

1. **Install the middleware.** `x207Middleware` uses the standard web `Request`/`Response`, so it fits Hono, Express (adapter), or any fetch handler:

   ```ts
   import { x207Middleware } from "@x207/scheme";

   const paywall = x207Middleware({
     routes: { "/api/summarize": { price: "$0.02", description: "Summarize text" } },
     facilitatorUrl: process.env.FACILITATOR_URL!,
     circleId: "agents-main",
     payTo: "summarizer.agents.near",
   });
   // response = await paywall(request, (req) => handler(req))
   ```

2. **Point to the facilitator.** Run the reference facilitator (`apps/facilitator`, variables in `.env.example`: `X207_CIRCLES`, `X207_RELAYER_ACCOUNT_ID`, `X207_RELAYER_PRIVATE_KEY`, `NEAR_RPC_URLS`) and set `FACILITATOR_URL` on the seller. `GET /supported` lists `batch-settlement` on `x207:<circleId>` and `exact` on `near:mainnet`; the seller's 402 advertises both, so members pay with a voucher and non-members with `exact`.
3. **Check the claimable balance.** The seller's receivables are visible in the indexer read API: `GET /x207/circles/{circleId}/members/{account}/settlements` (the `claimable` position after `finalize_epoch`). Claim with `claim(epoch, "near" | "intents")` from the dashboard.

Tested example: [`examples/seller`](examples/seller). Payment guarantees for sellers: [Payment guarantees](docs/seller-guarantees.md).

## License

Apache-2.0

## Documents

- [Costs: when there is an on-chain transaction](docs/costs.md)
- [FAQ for agent builders](docs/faq-agent-builders.md)
- [`epoch_length` and the wait for payment](docs/epoch-length.md)
- [Payment guarantees for sellers](docs/seller-guarantees.md)
- [Voucher key security](docs/voucher-key-security.md)
- [Proposal to the x402 Foundation (local draft, not sent)](docs/x402-foundation/README.md)
- Conformance suite for other implementations: [`conformance/`](conformance/README.md) (`npm run conformance`)
