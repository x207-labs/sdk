// SD-093: the seller answers 402 with three entries (x207, exact near:mainnet, exact eip155:84532). A member pays by voucher at the x207 facilitator,
// an EVM buyer outside the circle pays `exact` on Base Sepolia at its own (mock) x402 facilitator. No keys, no network, no funds.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wrapFetchWithPayment } from "@x402/fetch";
import { describe, expect, it } from "vitest";
import { X207PaymentClient, defineCircleConfig } from "@x207/scheme";
import { PendingStore, createApp, createFacilitatorService, type NearRpc } from "../../../apps/facilitator/src/index.js";
import { BASE_SEPOLIA_NETWORK, BASE_SEPOLIA_USDC, createSeller } from "../src/seller.js";

const keys = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8"),
).keys;
const A = "translator.x207-circle.near";
const B = "summarizer.x207-circle.near";
const NETWORK = "x207:agents-main";
const SELLER_EVM = "0x1111111111111111111111111111111111111111";
const BUYER_EVM = "0x2222222222222222222222222222222222222222";
const CUTOFF_NS = String(BigInt(Date.now() + 3_600_000) * 1_000_000n);
const member = (account: string, pubkey: string) => ({
  account_id: account, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 42,
  limit: "1000000", pubkey_voucher: pubkey, settled_history: "0", stake: "1000000", status: "active", terms_hash: "0".repeat(64),
});
const VIEWS: Record<string, (args: any) => unknown> = {
  get_epoch: () => ({ epoch: 42, cutoff_at: CUTOFF_NS, phase: "open" }),
  member: ({ account_id }) => (account_id === A ? member(A, keys.kA.publicKey) : account_id === B ? member(B, keys.kB.publicKey) : null),
  is_frozen: () => false,
  interface_version: () => "0.0.14",
  headroom: () => "1000000",
  obligation: () => null,
  last_seq: () => 0,
};

type Seen = { host: string; path: string; body: any };

function world(withBase = true) {
  const seen: Seen[] = [];
  const rpc = { view: async (_c: string, method: string, args: any) => (VIEWS[method] ?? (() => { throw new Error(`no view ${method}`); }))(args) } as unknown as NearRpc;
  const facilitator = createApp(
    createFacilitatorService({
      circles: [defineCircleConfig({ network: NETWORK, circleContract: "x207-circle.near" })], rpc, pending: new PendingStore(":memory:"),
    }),
  );
  let routed: typeof fetch;
  const seller = createSeller({
    facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B,
    ...(withBase ? { baseSepolia: { payTo: SELLER_EVM, facilitatorUrl: "http://base.facilitator.test" } } : {}),
    fetch: (i, n) => routed(i, n),
  });
  routed = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const { hostname, pathname } = new URL(request.url);
    if (hostname === "base.facilitator.test") {
      const body = (await request.json()) as any;
      seen.push({ host: hostname, path: pathname, body });
      return Response.json(
        pathname === "/verify"
          ? { isValid: true, payer: BUYER_EVM }
          : { success: true, transaction: "0xBASETX", network: BASE_SEPOLIA_NETWORK, payer: BUYER_EVM },
      );
    }
    if (hostname === "facilitator.test") {
      if (request.method === "POST") seen.push({ host: hostname, path: pathname, body: await request.clone().json() });
      return facilitator.fetch(request);
    }
    return seller.fetch(request);
  }) as typeof fetch;
  return { routed, seen };
}

const URL_ = "https://seller.test/api/summarize";
const decode = (header: string | null) => JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
/** A stand-in for `ExactEvmScheme` of `@x402/evm`: it does not sign (no key), it returns the shape of an EIP-3009 payload. */
const exactEvm = {
  scheme: "exact",
  // the real scheme knows the USDC of the network; x402Client uses this to check the spend limit (default $1)
  findDefaultAsset: (asset: string) => (asset.toLowerCase() === BASE_SEPOLIA_USDC.toLowerCase() ? { asset, decimals: 6, symbol: "USDC" } : undefined),
  createPaymentPayload: async (version: number, requirements: any) => ({
    x402Version: version,
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: { from: BUYER_EVM, to: requirements.payTo, value: requirements.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
    },
  }),
};

describe("SD-093 seller with exact on Base Sepolia", () => {
  it("TC-SD-093-01 the 402 lists x207, exact near:mainnet and exact eip155:84532", async () => {
    const { routed } = world();
    const response = await routed(URL_);
    expect(response.status).toBe(402);
    const required = decode(response.headers.get("PAYMENT-REQUIRED"));
    expect(required.accepts.map((a: any) => `${a.scheme}@${a.network}`)).toEqual([`batch-settlement@${NETWORK}`, "exact@near:mainnet", `exact@${BASE_SEPOLIA_NETWORK}`]);
    expect(required.accepts[2]).toMatchObject({ asset: BASE_SEPOLIA_USDC, payTo: SELLER_EVM, amount: "20000", extra: { name: "USDC", version: "2" } });
  });

  it("TC-SD-093-02 a circle member pays by voucher; the Base Sepolia facilitator is not called", async () => {
    const { routed, seen } = world();
    const client = new X207PaymentClient({ payer: A, secretKey: Buffer.from(keys.kA.seed, "hex"), headroom: async () => "1000000" });
    client.register("eip155:*", exactEvm as never);
    const response = await wrapFetchWithPayment(routed, client)(URL_);
    expect(response.status).toBe(200);
    expect(decode(response.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: true, network: NETWORK });
    expect(seen.filter((s) => s.host === "base.facilitator.test")).toEqual([]);
  });

  it("TC-SD-093-03 an EVM buyer outside the circle pays exact on Base Sepolia at its own facilitator", async () => {
    const { routed, seen } = world();
    const client = new X207PaymentClient({ payer: BUYER_EVM, secretKey: Buffer.from(keys.kZ.seed, "hex"), headroom: async () => null });
    client.register("eip155:*", exactEvm as never);
    const response = await wrapFetchWithPayment(routed, client)(URL_);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: "summary text" });
    expect(decode(response.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: true, network: BASE_SEPOLIA_NETWORK, transaction: "0xBASETX" });
    const base = seen.filter((s) => s.host === "base.facilitator.test");
    expect(base.map((s) => s.path)).toEqual(["/verify", "/settle"]);
    expect(base[0]!.body.paymentRequirements).toMatchObject({ scheme: "exact", network: BASE_SEPOLIA_NETWORK, payTo: SELLER_EVM, amount: "20000", asset: BASE_SEPOLIA_USDC });
    expect(base[0]!.body.paymentPayload.payload.authorization).toMatchObject({ from: BUYER_EVM, to: SELLER_EVM, value: "20000" });
    // the x207 facilitator saw no payment of this buyer
    expect(seen.filter((s) => s.host === "facilitator.test" && (s.path === "/verify" || s.path === "/settle"))).toEqual([]);
  });

  it("TC-SD-093-04 the seller without baseSepolia keeps two entries", async () => {
    const response = await world(false).routed(URL_);
    const required = decode(response.headers.get("PAYMENT-REQUIRED"));
    expect(required.accepts.map((a: any) => `${a.scheme}@${a.network}`)).toEqual([`batch-settlement@${NETWORK}`, "exact@near:mainnet"]);
  });
});
