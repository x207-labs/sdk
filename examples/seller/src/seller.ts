// Minimal x207 seller: one paid endpoint `/api/summarize` behind `x207Middleware` (through `EndpointAdapter`, the class D reference adapter).
// The 402 advertises the x207 voucher and `exact` near:mainnet, so members pay by voucher and non-members pay `exact`.
import { Hono } from "hono";
import type { AccountId } from "@x207/core";
import { EndpointAdapter } from "@x207/scheme";

export type SellerOptions = {
  /** URL facilitator (`/verify`, `/settle`, `/supported`). */
  facilitatorUrl: string;
  /** Circle id, e.g. `agents-main` (network `x207:agents-main`). */
  circleId: string;
  /** The seller's NEAR account that receives payment. */
  payTo: AccountId;
  /** Price per call, e.g. `"$0.02"`. */
  price?: string;
  fetch?: typeof fetch;
};

export function createSeller(options: SellerOptions): Hono {
  // Class D (F8): the x402 endpoint is wrapped by `EndpointAdapter`; `paywall()` is the same `x207Middleware`, so the 402 and the F2 flow do not change.
  const adapter = new EndpointAdapter({
    endpoint: "/api/summarize",
    paywall: {
      routes: { "/api/summarize": { price: options.price ?? "$0.02", description: "Summarize text" } },
      facilitatorUrl: options.facilitatorUrl,
      circleId: options.circleId,
      payTo: options.payTo,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
  });
  const paywall = adapter.paywall();

  const app = new Hono();
  app.use("*", async (c, next) => {
    // Hono ignores a Response returned after `next()`, so the middleware result is set on `c.res`.
    c.res = await paywall(c.req.raw, async () => {
      await next();
      return c.res;
    });
  });
  app.get("/api/summarize", (c) => c.json({ summary: "summary text" }));
  return app;
}
