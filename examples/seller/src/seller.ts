// Minimal x207 seller: one paid endpoint `/api/summarize` behind `x207Middleware` (through `EndpointAdapter`, the class D reference adapter).
// The 402 advertises the x207 voucher and `exact` near:mainnet, so members pay by voucher and non-members pay `exact`.
// With `baseSepolia` it adds `exact` on Base Sepolia (`eip155:84532`, USDC testnet) for EVM buyers outside the circle (SD-093).
import { Hono } from "hono";
import type { AccountId } from "@x207/core";
import { EndpointAdapter } from "@x207/scheme";

/** Base Sepolia USDC (testnet token, no real funds) and the public x402 testnet facilitator. */
export const BASE_SEPOLIA_NETWORK = "eip155:84532";
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const X402_PUBLIC_TESTNET_FACILITATOR = "https://x402.org/facilitator";

/** SD-093: a third `accepts` entry, `exact` on Base Sepolia, so an EVM buyer outside the circle can pay with USDC. */
export type BaseSepoliaExact = {
  /** The seller's `0x` address on Base Sepolia. */
  payTo: string;
  /** x402 facilitator that verifies and settles `exact` on `eip155:84532` (default: the public testnet one, no key needed). */
  facilitatorUrl?: string;
};

export type SellerOptions = {
  /** URL facilitator (`/verify`, `/settle`, `/supported`). */
  facilitatorUrl: string;
  /** Circle id, e.g. `agents-main` (network `x207:agents-main`). */
  circleId: string;
  /** The seller's NEAR account that receives payment. */
  payTo: AccountId;
  /** Price per call, e.g. `"$0.02"`. */
  price?: string;
  /** Also accept `exact` on Base Sepolia (SD-093). Members still pay by voucher; the 402 lists both. */
  baseSepolia?: BaseSepoliaExact;
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
      ...(options.baseSepolia
        ? {
            alsoAccept: [
              {
                network: BASE_SEPOLIA_NETWORK, asset: BASE_SEPOLIA_USDC, payTo: options.baseSepolia.payTo,
                facilitatorUrl: options.baseSepolia.facilitatorUrl ?? X402_PUBLIC_TESTNET_FACILITATOR,
                extra: { name: "USDC", version: "2" },
              },
            ],
          }
        : {}),
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
