// Penjual x207 minimal: satu endpoint berbayar `/api/summarize` di balik `x207Middleware` (lewat `EndpointAdapter`, adaptor referensi kelas D).
// 402 mengiklankan voucher x207 dan `exact` near:mainnet, jadi anggota membayar voucher dan non-anggota membayar `exact`.
import { Hono } from "hono";
import type { AccountId } from "@x207/core";
import { EndpointAdapter } from "@x207/scheme";

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
  // Kelas D (F8): endpoint x402 dibungkus `EndpointAdapter`; `paywall()` adalah `x207Middleware` yang sama, jadi 402 dan alur F2 tidak berubah.
  const adapter = new EndpointAdapter({
    endpoint: "/api/summarize",
    paywall: {
      routes: { "/api/summarize": { price: options.price ?? "$0.02", description: "Ringkas teks" } },
      facilitatorUrl: options.facilitatorUrl,
      circleId: options.circleId,
      payTo: options.payTo,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
  });
  const paywall = adapter.paywall();

  const app = new Hono();
  app.use("*", async (c, next) => {
    // Hono mengabaikan Response yang dikembalikan setelah `next()`, jadi hasil middleware dipasang ke `c.res`.
    c.res = await paywall(c.req.raw, async () => {
      await next();
      return c.res;
    });
  });
  app.get("/api/summarize", (c) => c.json({ summary: "summary text" }));
  return app;
}
