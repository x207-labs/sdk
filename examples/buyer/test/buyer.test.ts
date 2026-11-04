import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp, createSettle, createVerify, PendingStore, type NearRpc } from "../../../apps/facilitator/src/index.js";
import { defineCircleConfig, x207Middleware } from "@x207/scheme";
import { createBuyerFetch } from "../src/buyer.js";
import { readBuyerEnv } from "../src/env.js";

const keys = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8"),
).keys;
const A = "translator.x207-circle.near";
const B = "summarizer.x207-circle.near";
const CIRCLE = "x207-circle.near";
const NETWORK = "x207:agents-main";
const CUTOFF_NS = String(BigInt(Date.now() + 3_600_000) * 1_000_000n);
const EXTRA = { circleContract: CIRCLE, unit: "credit", decimals: 6, epoch: 42 };

const member = (account: string, pubkey: string) => ({
  account_id: account, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 42,
  limit: "1000000", pubkey_voucher: pubkey, settled_history: "0", stake: "1000000", status: "active", terms_hash: "0".repeat(64),
});
/** A view the mock does not know is an error that names it, not a TypeError (SD-074 follow-up). */
const viewOf = (views: Record<string, (args: any) => unknown>, method: string): ((args: any) => unknown) =>
  views[method] ?? (() => { throw new Error(`mock RPC has no view ${method}`); });
const VIEWS: Record<string, (args: any) => unknown> = {
  get_epoch: () => ({ epoch: 42, cutoff_at: CUTOFF_NS, phase: "open" }),
  member: ({ account_id }: { account_id: string }) => member(account_id, account_id === A ? keys.kA.publicKey : keys.kB.publicKey),
  is_frozen: () => false,
  interface_version: () => "0.0.12",
  headroom: () => "1000000",
  obligation: () => null,
};

/** Local world without a network: RPC, facilitator, and seller are served by one fetch function. */
function world() {
  const pending = new PendingStore(":memory:");
  const rpc = { view: async (_c: string, method: string, args: any) => viewOf(VIEWS, method)(args) } as unknown as NearRpc;
  const circle = defineCircleConfig({ network: NETWORK, circleContract: CIRCLE });
  const facilitator = createApp({
    verify: createVerify([circle], rpc, pending),
    settle: createSettle([circle], rpc, pending),
    supported: async () => ({
      kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK, extra: EXTRA }], extensions: [], signers: {},
    }),
  });
  let routerFetch: typeof fetch;
  const seller = x207Middleware({
    routes: { "/api/summarize": { price: "$0.02", description: "Summarize text" } },
    facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B,
    fetch: (input, init) => routerFetch(input, init),
  });
  routerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const { hostname } = new URL(request.url);
    if (hostname === "rpc.test") {
      const { params } = (await request.json()) as any;
      const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
      const result = [...Buffer.from(JSON.stringify(viewOf(VIEWS, params.method_name)(args)))];
      return Response.json({ jsonrpc: "2.0", id: "x207", result: { result } });
    }
    if (hostname === "facilitator.test") return facilitator.fetch(request);
    if (hostname === "seller.test") {
      return seller(request, async () => Response.json({ summary: "summary text" }));
    }
    return new Response("unknown", { status: 404 });
  }) as typeof fetch;
  return { pending, fetch: routerFetch };
}

describe("SD-035 buyer example", () => {
  it("pays a paid call with a voucher and reads PAYMENT-RESPONSE", async () => {
    const { fetch: routed, pending } = world();
    const paidFetch = createBuyerFetch({
      accountId: A, secretKey: Buffer.from(keys.kA.seed, "hex"), rpcUrls: ["http://rpc.test"], fetch: routed,
    });

    const first = await paidFetch("https://seller.test/api/summarize");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ summary: "summary text" });
    const settled = JSON.parse(Buffer.from(first.headers.get("PAYMENT-RESPONSE")!, "base64").toString("utf8"));
    expect(settled).toMatchObject({
      success: true, transaction: `${A}:${B}:42:1`, network: NETWORK,
      extensions: { x207: { seq: 1, cumulativeAmount: "20000", registration: "pending" } },
    });
    expect(pending.get({ circleContract: CIRCLE, payer: A, payee: B, epoch: 42 })).toMatchObject({ seq: 1, cumulativeAmount: "20000" });

    const second = await paidFetch("https://seller.test/api/summarize");
    expect(second.status).toBe(200);
    expect(pending.get({ circleContract: CIRCLE, payer: A, payee: B, epoch: 42 })).toMatchObject({ seq: 2, cumulativeAmount: "40000" });
  });

  it("TC-SD-035-02 minimal code: one @x402/fetch wrapper and no direct signVoucher", () => {
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const source = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(`${dir}${f}`, "utf8")).join("\n");
    expect(source.match(/wrapFetchWithPayment\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/signVoucher/);
  });

  it("TC-SD-035-03 a missing variable: the message names the variable", () => {
    const base = { ACCOUNT_ID: A, VOUCHER_SECRET_KEY: `ed25519:${"1".repeat(44)}`, SELLER_URL: "http://seller.test/x" };
    for (const name of Object.keys(base)) {
      expect(() => readBuyerEnv({ ...base, [name]: undefined })).toThrow(new RegExp(name));
    }
    expect(() => readBuyerEnv({ ...base, VOUCHER_SECRET_KEY: "abc" })).toThrow(/VOUCHER_SECRET_KEY/);
    expect(readBuyerEnv({ ...base, NEAR_RPC_URLS: "http://a, http://b" }).rpcUrls).toEqual(["http://a", "http://b"]);
  });
});
