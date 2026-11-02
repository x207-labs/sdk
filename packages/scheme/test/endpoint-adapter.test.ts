// SD-051: EndpointAdapter (kelas D). Lima fungsi adaptor, dan paywall()-nya menghasilkan 402 yang identik dengan x207Middleware langsung.
import { describe, expect, it } from "vitest";
import type { AccessAssetAdapter, AccessGrant } from "@x207/core";
import { EndpointAdapter, x207Middleware, type X207ExtraSource, type X207MiddlewareOptions } from "@x207/scheme";

const GRANTOR = "summarizer.x207-circle.near";
const GRANTEE = "translator.x207-circle.near";
const grant = (patch: Partial<AccessGrant> = {}): AccessGrant => ({
  grant_id: 4, asset_type: "x402:endpoint", grantor: GRANTOR, grantee: GRANTEE, class: "D",
  limits: { scope: "{}", quota: null, expires_at: "1793600000000000000" }, unit: "call", unit_price: "20000", operator: null,
  delivery_pubkey: null, status: "active", proof_hash: null, proof_kind: null, ...patch,
});
const extra = { get: async () => ({ circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42 }) } as unknown as X207ExtraSource;
const paywallOptions: X207MiddlewareOptions = {
  routes: { "/api/summarize": { price: "$0.02", description: "Ringkas teks" } },
  facilitatorUrl: "http://facilitator.invalid", circleId: "agents-main", payTo: GRANTOR, extra,
};

describe("SD-051 EndpointAdapter", () => {
  it("TC-SD-051-01 lima fungsi: price, prove, deliver, meter (payee pemberi), revoke mencatat dan memanggil onRevoke", async () => {
    const seen: string[] = [];
    const adapter: AccessAssetAdapter<{ endpoint: string }> = new EndpointAdapter({
      endpoint: "https://summarizer.example/api/summarize", paywall: paywallOptions, onRevoke: (g, reason) => void seen.push(`${g.grant_id}:${reason}`),
    });
    expect(adapter.assetClass).toBe("D");
    expect(await adapter.price(grant())).toEqual({ assetType: "x402:endpoint", unit: "call", unitPrice: "20000" });
    expect(await adapter.prove(grant())).toEqual({ valid: true });
    expect(await adapter.deliver(grant())).toEqual({ endpoint: "https://summarizer.example/api/summarize" });
    expect(await adapter.meter(grant(), { quantity: 3 })).toEqual({ payer: GRANTEE, payee: GRANTOR, amount: "60000", resource: "x207:grant:4" });
    await adapter.revoke(grant(), "defaulted");
    expect((adapter as EndpointAdapter).revoked).toEqual([{ grantId: 4, grantee: GRANTEE, reason: "defaulted" }]);
    expect(seen).toEqual(["4:defaulted"]);
  });

  it("TC-SD-051-02 paywall(): 402 dan header PAYMENT-REQUIRED identik dengan x207Middleware langsung", async () => {
    const direct = x207Middleware(paywallOptions);
    const wrapped = new EndpointAdapter({ endpoint: "/api/summarize", paywall: paywallOptions }).paywall();
    const next = () => new Response("unreachable");
    const request = () => new Request("http://seller.example/api/summarize");
    const a = await direct(request(), next);
    const b = await wrapped(request(), next);
    expect(b.status).toBe(402);
    expect(b.status).toBe(a.status);
    expect(b.headers.get("PAYMENT-REQUIRED")).toBe(a.headers.get("PAYMENT-REQUIRED"));
    expect(await b.text()).toBe(await a.text());
    // rute di luar daftar diteruskan tanpa 402, sama seperti langsung
    const free = await wrapped(new Request("http://seller.example/other"), () => new Response("ok"));
    expect(free.status).toBe(200);
  });
});
