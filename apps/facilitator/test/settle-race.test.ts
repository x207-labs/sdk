// A-SD-03: two concurrent /settle calls of one payer/payee pair with seq N and N+1 and the SAME cumulative amount.
// Each one alone is valid against the stored base (increment = amount), but together they pay once and serve twice.
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
const C = "c.x207-circle.near";
const CIRCLE = defineCircleConfig({ network: "x207:agents-main", circleContract: "x207-circle.near" });
const NOW = Date.now();
const CUTOFF_NS = String(BigInt(NOW + 3_600_000) * 1_000_000n);

const requirements = (payTo: string) => ({
  scheme: "batch-settlement", network: "x207:agents-main", amount: "20000", asset: "USD", payTo,
  maxTimeoutSeconds: 60, extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42 },
});
const bodyOf = (payee: string, seq: number, cumulative: number) => {
  const { signature, ...voucher } = signVoucher(
    { circle: "x207-circle.near", payer: A, payee, epoch: 42, seq, cumulativeAmount: String(cumulative), unit: "credit", resource: "https://s.example/api" },
    kA,
  );
  const req = requirements(payee);
  return { x402Version: 2, paymentPayload: { x402Version: 2, resource: { url: "https://s.example/api" }, accepted: req, payload: { voucher, signature } }, paymentRequirements: req };
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
  headroom: () => "30000", // room for ONE payment of 20000, not two
  obligation: () => null,
};
// a real RPC takes time per view: the await lets the second request run its checks before the first one has stored its voucher
const rpc = { view: async (_c: string, method: string, args: any) => { await new Promise((r) => setTimeout(r, 1)); return (VIEWS[method] ?? (() => { throw new Error(`no view ${method}`); }))(args); } } as unknown as NearRpc;

const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/settle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function setup() {
  const pending = new PendingStore(":memory:");
  const app = createApp({
    verify: createVerify([CIRCLE], rpc, pending),
    settle: createSettle([CIRCLE], rpc, pending),
    supported: async () => ({ kinds: [], extensions: [], signers: {} }),
  });
  return { pending, app };
}

describe("A-SD-03 concurrent settle of one pair", () => {
  it("TC-SD-106-01 seq 1 and seq 2 with the same cumulative amount: exactly one of two concurrent /settle succeeds", async () => {
    const { app, pending } = setup();
    const results = await Promise.all([post(app, bodyOf(B, 1, 20000)), post(app, bodyOf(B, 2, 20000))]);
    const bodies = await Promise.all(results.map((r) => r.json() as Promise<{ success: boolean; errorReason?: string }>));
    expect(bodies.filter((b) => b.success), JSON.stringify(bodies)).toHaveLength(1);
    // what is stored is one payment of 20000, never a second increment without money behind it
    const row = pending.get({ circleContract: "x207-circle.near", payer: A, payee: B, epoch: 42 });
    expect(row?.cumulativeAmount).toBe("20000");
  });

  it("TC-SD-106-02 two payees at once (A-SD-04): the headroom of the payer covers one payment, so only one succeeds", async () => {
    const { app } = setup();
    const results = await Promise.all([post(app, bodyOf(B, 1, 20000)), post(app, bodyOf(C, 1, 20000))]);
    const bodies = await Promise.all(results.map((r) => r.json() as Promise<{ success: boolean; errorReason?: string }>));
    expect(bodies.filter((b) => b.success), JSON.stringify(bodies)).toHaveLength(1);
  });

  it("TC-SD-106-03 sequential vouchers of the normal protocol still work (seq 1, then seq 2 with cumulative 40000)", async () => {
    const { app } = setup();
    expect((await (await post(app, bodyOf(B, 1, 20000))).json() as { success: boolean }).success).toBe(true);
    const second = (await (await post(app, bodyOf(B, 2, 40000))).json()) as { success: boolean; errorReason?: string };
    // headroom is 30000 in this mock, so the second payment of 20000 is refused: the point is that the refusal is for credit, not for a broken sequence
    expect(second.errorReason).toBe("insufficient_credit");
  });
});
