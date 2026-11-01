// Penjual x207 minimal: satu endpoint berbayar `/api/summarize` di balik `x207Middleware`.
// 402 mengiklankan voucher x207 dan `exact` near:mainnet, jadi anggota membayar voucher dan non-anggota membayar `exact`.
import { Hono } from "hono";
import type { AccountId } from "@x207/core";
import { x207Middleware } from "@x207/scheme";

export type SellerOptions = {
  /** URL facilitator (`/verify`, `/settle`, `/supported`). */
  facilitatorUrl: string;
  /** Id lingkaran, mis. `agents-main` (network `x207:agents-main`). */
  circleId: string;
  /** Akun NEAR penjual yang menerima pembayaran. */
  payTo: AccountId;
  /** Harga per panggilan, mis. `"$0.02"`. */
  price?: string;
  fetch?: typeof fetch;
};

export function createSeller(options: SellerOptions): Hono {
  const paywall = x207Middleware({
    routes: { "/api/summarize": { price: options.price ?? "$0.02", description: "Ringkas teks" } },
    facilitatorUrl: options.facilitatorUrl,
    circleId: options.circleId,
    payTo: options.payTo,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const app = new Hono();
  app.use("*", async (c, next) => {
    // Hono mengabaikan Response yang dikembalikan setelah `next()`, jadi hasil middleware dipasang ke `c.res`.
    c.res = await paywall(c.req.raw, async () => {
      await next();
      return c.res;
    });
  });
  app.get("/api/summarize", (c) => c.json({ summary: "ringkasan" }));
  return app;
}
