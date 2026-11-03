import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signVoucher } from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { PendingStore, createApp, createSettle, createVerify, type NearRpc } from "../src/index.js";

const kA = Buffer.from(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8")).keys.kA.seed,
  "hex",
);
const KA_PUB = "ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";
const A = "a.x207-circle.near";
const B = "b.x207-circle.near";
const CIRCLE = defineCircleConfig({ network: "x207:agents-main", circleContract: "x207-circle.near" });
const NOW = Date.now();
const CUTOFF_NS = String(BigInt(NOW + 3_600_000) * 1_000_000n);

const REQ = {
  scheme: "batch-settlement", network: "x207:agents-main", amount: "20000", asset: "USD", payTo: B,
  maxTimeoutSeconds: 60, extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42 },
};
const bodyOf = (seq: number) => {
  const { signature, ...voucher } = signVoucher(
    { circle: "x207-circle.near", payer: A, payee: B, epoch: 42, seq, cumulativeAmount: String(seq * 20000), unit: "credit", resource: "https://s.example/api" },
    kA,
  );
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, resource: { url: "https://s.example/api" }, accepted: REQ, payload: { voucher, signature } },
    paymentRequirements: REQ,
  };
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
  interface_version: () => "0.0.12",
  headroom: () => "1000000",
  obligation: () => null,
};
const rpc = { view: async (_c: string, method: string, args: any) => viewOf(VIEWS, method)(args) } as unknown as NearRpc;

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function setup() {
  const pending = new PendingStore(":memory:");
  const app = createApp({
    verify: createVerify([CIRCLE], rpc, pending),
    settle: createSettle([CIRCLE], rpc, pending),
    supported: async () => ({ kinds: [], extensions: [], signers: {} }),
  });
  return { pending, app };
}

describe("SD-026 /settle di facilitator", () => {
  it("TC-SD-026-01/04 menyimpan voucher ke pending store SQLite dan menjawab commitment id", async () => {
    const { app, pending } = setup();
    const res = await post(app, "/settle", bodyOf(1));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true, transaction: `${A}:${B}:42:1`, network: "x207:agents-main", payer: A,
      extensions: { x207: { epoch: 42, seq: 1, cumulativeAmount: "20000", registration: "pending" } },
    });
    expect(pending.get({ circleContract: "x207-circle.near", payer: A, payee: B, epoch: 42 })).toMatchObject({
      seq: 1, cumulativeAmount: "20000", attempts: 0,
    });
  });

  it("TC-SD-022-09 voucher pending bertahan di /verify berikutnya", async () => {
    const { app } = setup();
    await post(app, "/settle", bodyOf(1));
    expect(await (await post(app, "/verify", bodyOf(1))).json()).toMatchObject({ isValid: false, invalidReason: "seq_not_increasing" });
    expect(await (await post(app, "/verify", bodyOf(2))).json()).toEqual({ isValid: true, payer: A });
  });

  it("TC-SD-026-07 /settle sama dua kali: respons identik, satu baris", async () => {
    const { app, pending } = setup();
    const first = await (await post(app, "/settle", bodyOf(1))).json();
    const second = await (await post(app, "/settle", bodyOf(1))).json();
    expect(second).toEqual(first);
    expect(pending.listByPayer("x207-circle.near", A, 42)).toHaveLength(1);
  });

  it("network yang tidak dikonfigurasi dijawab invalid_network", async () => {
    const { app } = setup();
    const body = bodyOf(1);
    const other = { ...REQ, network: "x207:other-circle" };
    const res = await post(app, "/settle", { ...body, paymentRequirements: other });
    expect(await res.json()).toMatchObject({ success: false, errorReason: "invalid_network", transaction: "" });
  });
});
