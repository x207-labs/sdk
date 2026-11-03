// SD-029 dan SD-030: mode demo `register_voucher` per request dan kode non-terminal `settlement_pending` di /settle.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { signVoucher, type UnsignedVoucher } from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { loadConfig } from "../src/config.js";
import { PendingStore, createApp, createFacilitatorService, type NearRpc } from "../src/index.js";
import { RegistrationScheduler, type RegistrationChain } from "../src/scheduler.js";

const kA = Buffer.from(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8")).keys.kA.seed,
  "hex",
);
const KA_PUB = "ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";
const CONTRACT = "x207-circle.near";
const A = "a.x207-circle.near";
const B = "b.x207-circle.near";
const CIRCLE = defineCircleConfig({ network: "x207:agents-main", circleContract: CONTRACT });
const CUTOFF_NS = String(BigInt(Date.now() + 3_600_000) * 1_000_000n);
const REQ = {
  scheme: "batch-settlement", network: "x207:agents-main", amount: "20000", asset: "USD", payTo: B,
  maxTimeoutSeconds: 60, extra: { circleContract: CONTRACT, unit: "credit", decimals: 6, epoch: 42 },
};
const body = (seq: number) => {
  const { signature, ...voucher } = signVoucher(
    { circle: CONTRACT, payer: A, payee: B, epoch: 42, seq, cumulativeAmount: String(seq * 20000), unit: "credit", resource: "https://s.example/api" },
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
  headroom: () => "1000000",
  obligation: () => null,
};
const rpc = { view: async (_c: string, method: string, args: any) => viewOf(VIEWS, method)(args) } as unknown as NearRpc;

class Chain implements RegistrationChain {
  calls: Array<{ seq: number; mode: string }> = [];
  behave: (call: { seq: number; mode: string }) => Promise<void> = async () => {};
  async register(v: UnsignedVoucher, _s: string, mode: string) {
    const call = { seq: v.seq, mode };
    this.calls.push(call);
    await this.behave(call);
  }
  async lastSeq() {
    return 0;
  }
  async getEpoch() {
    return { epoch: 42, cutoff_at: CUTOFF_NS } as never;
  }
}

const stores: PendingStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

function setup(options: { timeoutMs?: number; mode?: "per_request" | "cumulative" } = {}) {
  const pending = new PendingStore(":memory:");
  stores.push(pending);
  const chain = new Chain();
  const scheduler = new RegistrationScheduler({ circleContract: CONTRACT, store: pending, chain, mode: options.mode ?? "per_request", log: () => {} });
  const service = createFacilitatorService({
    circles: [CIRCLE], rpc, pending,
    ...(options.mode === "cumulative" ? {} : { perRequest: { registerNow: (_c, key) => scheduler.registerNow(key), timeoutMs: options.timeoutMs ?? 10_000 } }),
  });
  const app = createApp(service);
  const settle = async (seq: number) => {
    const response = await app.request("/settle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(seq)) });
    return (await response.json()) as { success: boolean; errorReason?: string; extensions?: { x207?: { registration?: string; seq?: number } } };
  };
  return { pending, chain, scheduler, settle };
}
const err = (code: string) => new Error(`Smart contract panicked: ${code}: detail`);

describe("SD-029 mode per_request", () => {
  it("TC-SD-029-01 setiap /settle memanggil register_voucher satu kali dan menjawab registered", async () => {
    const { chain, settle, pending } = setup();
    for (const seq of [1, 2, 3]) {
      const r = await settle(seq);
      expect(r.success).toBe(true);
      expect(r.extensions?.x207?.registration).toBe("registered");
    }
    expect(chain.calls).toEqual([{ seq: 1, mode: "per_request" }, { seq: 2, mode: "per_request" }, { seq: 3, mode: "per_request" }]);
    expect(pending.listOpen(CONTRACT)).toEqual([]);
  });

  it("TC-SD-029-02 tanpa flag perilaku kumulatif tidak berubah: settle menjawab pending dan tidak mendaftarkan", async () => {
    const { chain, settle, pending } = setup({ mode: "cumulative" });
    const r = await settle(1);
    expect(r.success).toBe(true);
    expect(r.extensions?.x207?.registration).toBe("pending");
    expect(chain.calls).toEqual([]);
    expect(pending.listOpen(CONTRACT)).toHaveLength(1);
  });

  it("TC-SD-029-03 ERR_SEQ_GAP: jatuh ke register_cumulative, voucher tetap terdaftar", async () => {
    const { chain, settle } = setup();
    chain.behave = async (call) => {
      if (call.mode === "per_request") throw err("ERR_SEQ_GAP");
    };
    const r = await settle(1);
    expect(r.success).toBe(true);
    expect(r.extensions?.x207?.registration).toBe("registered");
    expect(chain.calls.map((c) => c.mode)).toEqual(["per_request", "cumulative"]);
  });

  it("TC-SD-029-04 konfigurasi: per_request butuh relayer, dan batas tunggu bisa diatur", () => {
    const base = { X207_CIRCLES: `agents-main=${CONTRACT}`, X207_REGISTER_MODE: "per_request" };
    expect(() => loadConfig(base)).toThrow(/butuh X207_RELAYER_ACCOUNT_ID/);
    const config = loadConfig({ ...base, X207_RELAYER_ACCOUNT_ID: "r.near", X207_RELAYER_PRIVATE_KEY: "ed25519:x", X207_SETTLE_TIMEOUT_MS: "3000" });
    expect(config).toMatchObject({ registerMode: "per_request", settleTimeoutMs: 3000 });
    expect(loadConfig({ X207_CIRCLES: `agents-main=${CONTRACT}` })).toMatchObject({ registerMode: "cumulative", settleTimeoutMs: 10_000 });
  });
});

describe("SD-030 settlement_pending", () => {
  it("TC-SD-030-01 registrasi belum final dalam batas waktu: success false, settlement_pending, registration pending", async () => {
    const { chain, settle } = setup({ timeoutMs: 30 });
    let release!: () => void;
    chain.behave = () => new Promise<void>((resolve) => { release = resolve; });
    const r = await settle(1);
    expect(r).toMatchObject({ success: false, errorReason: "settlement_pending", extensions: { x207: { registration: "pending", seq: 1 } } });
    release();
  });

  it("TC-SD-030-02 registrasi yang terlambat tetap selesai dan baris D3 menjadi registered", async () => {
    const { chain, settle, pending } = setup({ timeoutMs: 30 });
    let release!: () => void;
    chain.behave = () => new Promise<void>((resolve) => { release = resolve; });
    expect((await settle(1)).errorReason).toBe("settlement_pending");
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(pending.listOpen(CONTRACT)).toEqual([]);
  });

  it("TC-SD-030-03 kegagalan sementara (ERR_INSUFFICIENT_CREDIT) juga non-terminal dan baris diulang dengan backoff", async () => {
    const { chain, settle, pending } = setup();
    chain.behave = async () => { throw err("ERR_INSUFFICIENT_CREDIT"); };
    const r = await settle(1);
    expect(r).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(pending.listOpen(CONTRACT)).toHaveLength(1);
    expect(pending.listOpen(CONTRACT)[0]!.attempts).toBe(1);
  });

  it("TC-SD-030-04 kegagalan terminal (ERR_BAD_SIGNATURE) dikembalikan sebagai kode spec dan baris dibuang", async () => {
    const { chain, settle, pending } = setup();
    chain.behave = async () => { throw err("ERR_BAD_SIGNATURE"); };
    const r = await settle(1);
    expect(r).toMatchObject({ success: false, errorReason: "invalid_signature" });
    expect(pending.listOpen(CONTRACT)).toEqual([]);
  });

  it("TC-SD-030-05 mode kumulatif tidak pernah menjawab settlement_pending", async () => {
    const { settle } = setup({ mode: "cumulative" });
    for (const seq of [1, 2]) expect((await settle(seq)).errorReason).toBeUndefined();
  });
});
