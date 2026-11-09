import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wrapFetchWithPayment } from "@x402/fetch";
import { describe, expect, it } from "vitest";
import { USDT_TOKEN_ID } from "@x207/core";
import { X207PaymentClient } from "@x207/scheme";
import { PendingStore, createApp, createFacilitatorService, type NearRpc } from "../../../apps/facilitator/src/index.js";
import { defineCircleConfig } from "@x207/scheme";
import { createSeller } from "../src/seller.js";

const keys = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8"),
).keys;
const A = "translator.x207-circle.near";
const B = "summarizer.x207-circle.near";
const NETWORK = "x207:agents-main";
const CUTOFF_NS = String(BigInt(Date.now() + 3_600_000) * 1_000_000n);
const member = (account: string, pubkey: string) => ({
  account_id: account, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 42,
  limit: "1000000", pubkey_voucher: pubkey, settled_history: "0", stake: "1000000", status: "active", terms_hash: "0".repeat(64),
});
/** A view the mock does not know is an error that names it, not a TypeError (SD-074 follow-up). */
const viewOf = (views: Record<string, (args: any) => unknown>, method: string): ((args: any) => unknown) =>
  views[method] ?? (() => { throw new Error(`mock RPC has no view ${method}`); });
const VIEWS: Record<string, (args: any) => unknown> = {
  get_epoch: () => ({ epoch: 42, cutoff_at: CUTOFF_NS, phase: "open" }),
  member: ({ account_id }) => (account_id === A ? member(A, keys.kA.publicKey) : account_id === B ? member(B, keys.kB.publicKey) : null),
  is_frozen: () => false,
  interface_version: () => "0.0.12",
  headroom: () => "1000000",
  obligation: () => null,
  last_seq: () => 0,
};

function world() {
  const rpc = { view: async (_c: string, method: string, args: any) => viewOf(VIEWS, method)(args) } as unknown as NearRpc;
  const facilitator = createApp(
    createFacilitatorService({
      circles: [defineCircleConfig({ network: NETWORK, circleContract: "x207-circle.near" })], rpc, pending: new PendingStore(":memory:"),
    }),
  );
  let routed: typeof fetch;
  const seller = createSeller({ facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B, fetch: (i, n) => routed(i, n) });
  routed = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const { hostname } = new URL(request.url);
    if (hostname === "facilitator.test") {
      if (request.method === "POST") {
        const body = (await request.clone().json()) as any;
        if (body.paymentRequirements?.scheme === "exact") {
          return Response.json(
            new URL(request.url).pathname === "/verify"
              ? { isValid: true, payer: "outsider.near" }
              : { success: true, transaction: "EXACTTX", network: "near:mainnet", payer: "outsider.near" },
          );
        }
      }
      return facilitator.fetch(request);
    }
    if (hostname === "rpc.test") {
      const { params } = (await request.json()) as any;
      const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
      return Response.json({ jsonrpc: "2.0", id: "x", result: { result: [...Buffer.from(JSON.stringify(viewOf(VIEWS, params.method_name)(args)))] } });
    }
    return seller.fetch(request);
  }) as typeof fetch;
  return routed;
}

const URL_ = "https://seller.test/api/summarize";
const decode = (header: string | null) => JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
const exact = {
  scheme: "exact",
  findDefaultAsset: (asset: string) => (asset === USDT_TOKEN_ID ? { asset, decimals: 6, symbol: "USDT" } : undefined),
  createPaymentPayload: async (v: number) => ({ x402Version: v, payload: { signedDelegateAction: "AAAA" } }),
};

describe("SD-036 seller example", () => {
  it("TC-SD-036-01 no payment: 402 with x207 and exact entries", async () => {
    const response = await world()(URL_);
    expect(response.status).toBe(402);
    const required = decode(response.headers.get("PAYMENT-REQUIRED"));
    expect(required.accepts.map((a: any) => `${a.scheme}@${a.network}`)).toEqual([`batch-settlement@${NETWORK}`, "exact@near:mainnet"]);
    expect(required.accepts[0]).toMatchObject({ payTo: B, amount: "20000", extra: { epoch: 42, circleContract: "x207-circle.near" } });
  });

  it("TC-UM-187-01 the 402 carries the x402 Bazaar discovery extension: info.input, info.output and a schema that requires input", async () => {
    const response = await world()(URL_);
    expect(response.status).toBe(402);
    const required = decode(response.headers.get("PAYMENT-REQUIRED"));
    expect(Object.keys(required.extensions)).toEqual(["bazaar"]);
    const bazaar = required.extensions.bazaar;
    expect(bazaar.info.input).toMatchObject({ type: "http", method: "GET" });
    expect(bazaar.info.output).toMatchObject({ example: { summary: "summary text" } });
    expect(bazaar.schema).toMatchObject({ $schema: "https://json-schema.org/draft/2020-12/schema", required: expect.arrayContaining(["input"]) });
    // the JSON body of the 402 holds the same extension as the header
    expect(((await response.json()) as { extensions: unknown }).extensions).toEqual(required.extensions);
  });

  it("TC-SD-036-02 a member pays with a voucher: 200 and x207 PAYMENT-RESPONSE", async () => {
    const routed = world();
    const client = new X207PaymentClient({
      payer: A, secretKey: Buffer.from(keys.kA.seed, "hex"),
      headroom: async () => "1000000",
    });
    const response = await wrapFetchWithPayment(routed, client)(URL_);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: "summary text" });
    expect(decode(response.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: true, network: NETWORK, transaction: `${A}:${B}:42:1` });
  });

  it("TC-SD-036-03 a non-member pays exact: 200 and exact PAYMENT-RESPONSE", async () => {
    const routed = world();
    const client = new X207PaymentClient({
      payer: "outsider.near", secretKey: Buffer.from(keys.kZ.seed, "hex"), headroom: async () => null,
    });
    client.register("near:*", exact as never);
    const response = await wrapFetchWithPayment(routed, client)(URL_);
    expect(response.status).toBe(200);
    expect(decode(response.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: true, network: "near:mainnet", transaction: "EXACTTX" });
  });
});
