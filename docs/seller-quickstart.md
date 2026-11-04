# Seller quickstart

Moved from the README of the sdk repository.

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

Tested example: [`examples/seller`](../examples/seller). Payment guarantees for sellers: [Payment guarantees](seller-guarantees.md).
