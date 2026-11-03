import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { signVoucher } from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { NearRpc, PendingStore, createApp, createVerify, type FacilitatorService } from "../src/index.js";

const kA = Buffer.from(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8")).keys.kA.seed,
  "hex",
);
const KA_PUB = "ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";
const A = "a.x207-circle.near";
const B = "b.x207-circle.near";
const CIRCLE = defineCircleConfig({ network: "x207:agents-main", circleContract: "x207-circle.near" });
const CUTOFF_NS = String(BigInt(Date.now() + 3_600_000) * 1_000_000n);

const REQ = {
  scheme: "batch-settlement", network: "x207:agents-main", amount: "20000", asset: "USD", payTo: B,
  maxTimeoutSeconds: 60, extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42 },
};
const { signature, ...voucher } = signVoucher(
  { circle: "x207-circle.near", payer: A, payee: B, epoch: 42, seq: 1, cumulativeAmount: "20000", unit: "credit", resource: "https://s.example/api" },
  kA,
);
const BODY = {
  x402Version: 2,
  paymentPayload: { x402Version: 2, resource: { url: "https://s.example/api" }, accepted: REQ, payload: { voucher, signature } },
  paymentRequirements: REQ,
};

const member = (account: string, pubkey: string) => ({
  account_id: account, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 42,
  limit: "1000000", pubkey_voucher: pubkey, settled_history: "0", stake: "1000000", status: "active", terms_hash: "0".repeat(64),
});
/** A view the mock does not know is an error that names it, not a TypeError (SD-074 follow-up). */
const viewOf = (views: Record<string, (args: any) => unknown>, method: string): ((args: any) => unknown) =>
  views[method] ?? (() => { throw new Error(`mock RPC has no view ${method}`); });
const VIEWS: Record<string, (args: any) => unknown> = {
  get_epoch: () => ({ epoch: 42, cutoff_at: CUTOFF_NS, phase: "open" }),
  member: ({ account_id }) => member(account_id, account_id === A ? KA_PUB : "ed25519:9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu"),
  is_frozen: () => false,
  headroom: () => "1000000",
  obligation: () => null,
};

const servers: Server[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.closeAllConnections?.() ?? s.close()); });
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const chainNode = (req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const { params } = JSON.parse(raw);
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
    const value = viewOf(VIEWS, params.method_name)(args);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: "x207", result: { result: [...Buffer.from(JSON.stringify(value))] } }));
  });
};
const down = (_req: IncomingMessage, res: ServerResponse) => { res.statusCode = 503; res.end("down"); };

const appFor = (rpcUrl: string, pending = new PendingStore(":memory:")) => {
  const verify = createVerify([CIRCLE], new NearRpc({ urls: [rpcUrl], timeoutMs: 1000 }), pending);
  const service = { verify } as unknown as FacilitatorService;
  return createApp(service);
};
const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("SD-024 /verify di apps/facilitator", () => {
  it("jalur sukses lewat RPC dan pending store nyata", async () => {
    const app = appFor(await listen(chainNode));
    const res = await post(app, BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isValid: true, payer: A });
  });

  it("baris pending dihitung: voucher yang sama setelah settle ditolak seq_not_increasing", async () => {
    const pending = new PendingStore(":memory:");
    pending.upsert("x207-circle.near", voucher as never, signature as never);
    const res = await post(appFor(await listen(chainNode), pending), BODY);
    expect(await res.json()).toMatchObject({ isValid: false, invalidReason: "seq_not_increasing" });
  });

  it("network x207 yang tidak dikonfigurasi menjawab invalid_network", async () => {
    const other = { ...REQ, network: "x207:other-circle" };
    const body = { ...BODY, paymentRequirements: other, paymentPayload: { ...BODY.paymentPayload, accepted: other } };
    const res = await post(appFor(await listen(chainNode)), body);
    expect(await res.json()).toMatchObject({ isValid: false, invalidReason: "invalid_network" });
  });

  it("TC-SD-024-32 kedua RPC gagal: HTTP 503 chain_unavailable, bukan isValid false", async () => {
    const res = await post(appFor(await listen(down)), BODY);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toMatchObject({ error: "chain_unavailable" });
  });

  it("TC-SD-024-31 verify tidak menambah baris pending", async () => {
    const pending = new PendingStore(":memory:");
    const app = appFor(await listen(chainNode), pending);
    for (let i = 0; i < 3; i++) await post(app, BODY);
    expect(pending.listByPayer("x207-circle.near", A, 42)).toEqual([]);
  });
});
