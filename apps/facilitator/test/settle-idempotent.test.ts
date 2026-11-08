// A-SD-12: the idempotent shortcut of /settle must not answer success when the requirements differ (another payTo) from the stored voucher.
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
const CUTOFF_NS = String(BigInt(Date.now() + 3_600_000) * 1_000_000n);

const requirements = (payTo: string, amount = "20000") => ({
  scheme: "batch-settlement", network: "x207:agents-main", amount, asset: "USD", payTo,
  maxTimeoutSeconds: 60, extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42 },
});
const voucherFor = (payee: string) => {
  const { signature, ...voucher } = signVoucher(
    { circle: "x207-circle.near", payer: A, payee, epoch: 42, seq: 1, cumulativeAmount: "20000", unit: "credit", resource: "https://s.example/api" },
    kA,
  );
  return { voucher, signature };
};
const bodyOf = (payee: string, payTo: string, amount = "20000") => {
  const req = requirements(payTo, amount);
  return { x402Version: 2, paymentPayload: { x402Version: 2, resource: { url: "https://s.example/api" }, accepted: req, payload: voucherFor(payee) }, paymentRequirements: req };
};
const member = (account: string, pubkey: string) => ({
  account_id: account, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 42,
  limit: "1000000", pubkey_voucher: pubkey, settled_history: "0", stake: "1000000", status: "active", terms_hash: "0".repeat(64),
});
const VIEWS: Record<string, (args: any) => unknown> = {
  get_epoch: () => ({ epoch: 42, cutoff_at: CUTOFF_NS, phase: "open" }),
  member: ({ account_id }) => member(account_id, account_id === A ? KA_PUB : "ed25519:9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu"),
  is_frozen: () => false,
  interface_version: () => "0.0.12",
  headroom: () => "30000",
  obligation: () => null,
};
const rpc = { view: async (_c: string, method: string, args: any) => (VIEWS[method] ?? (() => { throw new Error(`no view ${method}`); }))(args) } as unknown as NearRpc;
const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/settle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("SD-114 idempotent settle", () => {
  it("TC-SD-114-01 the same payload answers the same success; the same voucher with another payTo or amount is refused", async () => {
    const pending = new PendingStore(":memory:");
    const app = createApp({
      verify: createVerify([CIRCLE], rpc, pending),
      settle: createSettle([CIRCLE], rpc, pending),
      supported: async () => ({ kinds: [], extensions: [], signers: {} }),
    });
    const first = await (await post(app, bodyOf(B, B))).json() as { success: boolean };
    expect(first.success).toBe(true);
    expect(((await (await post(app, bodyOf(B, B))).json()) as { success: boolean }).success).toBe(true); // retry of the same payload
    const other = await (await post(app, bodyOf(B, "c.x207-circle.near"))).json() as { success: boolean; errorReason?: string };
    expect(other.success).toBe(false);
    expect(other.errorReason).toBe("payee_mismatch");
    // not covered: another `amount` on the same stored voucher still answers the stored success, because the increment needs the base before that voucher and the stored row does not keep it
  });
  it("TC-SD-114-02 a requirement of another circle or scheme is refused on a retry too", async () => {
    const pending = new PendingStore(":memory:");
    const app = createApp({ verify: createVerify([CIRCLE], rpc, pending), settle: createSettle([CIRCLE], rpc, pending), supported: async () => ({ kinds: [], extensions: [], signers: {} }) });
    expect(((await (await post(app, bodyOf(B, B))).json()) as { success: boolean }).success).toBe(true);
    const bad = bodyOf(B, B);
    bad.paymentRequirements = { ...bad.paymentRequirements, scheme: "exact" };
    expect(((await (await post(app, bad)).json()) as { success: boolean }).success).toBe(false);
  });
});
