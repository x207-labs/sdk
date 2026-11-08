import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyVoucher, voucherPublicKey, type X207Payload } from "@x207/core";
import {
  MemoryVoucherStateStore,
  X207SchemeClient,
  X207_NETWORK_FAMILY,
  type VoucherPairKey,
} from "@x207/scheme";

const vectorPath = (path: string) =>
  fileURLToPath(new URL(`../../../spec/test-vectors/${path}`, import.meta.url));
const readVector = (path: string) => JSON.parse(readFileSync(vectorPath(path), "utf8")) as any;

const SEED = Buffer.from(readVector("keys.json").keys.kA.seed, "hex");
const PUBKEY = voucherPublicKey(SEED);
const PAYER = "translator.x207-circle.near";
const PAYEE_B = "summarizer.x207-circle.near";
const RESOURCE = "https://summarizer.example/api/summarize";

const req = (overrides: { payTo?: string; epoch?: number; amount?: string } = {}) =>
  ({
    scheme: "batch-settlement",
    network: "x207:agents-main",
    amount: overrides.amount ?? "20000",
    asset: "USD",
    payTo: overrides.payTo ?? PAYEE_B,
    maxTimeoutSeconds: 60,
    extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: overrides.epoch ?? 42 },
  }) satisfies PaymentRequirements;

const key = (epoch = 42, payee = PAYEE_B): VoucherPairKey => ({ payer: PAYER, payee, epoch });

function setup(options: { confirmTimeoutMs?: number; accept?: ConstructorParameters<typeof X207SchemeClient>[0]["accept"] } = {}) {
  const store = new MemoryVoucherStateStore();
  const scheme = new X207SchemeClient({ payer: PAYER, secretKey: SEED, store, ...options });
  const client = new x402Client().register(X207_NETWORK_FAMILY, scheme);
  const pay = (requirements: PaymentRequirements = req(), url = RESOURCE) =>
    client.createPaymentPayload({ x402Version: 2, resource: { url }, accepts: [requirements] });
  const respond = (
    paymentPayload: PaymentPayload,
    result: { settleResponse?: any; error?: Error },
  ) => client.handlePaymentResponse({ paymentPayload, requirements: paymentPayload.accepted, ...result });
  const ok = (paymentPayload: PaymentPayload) =>
    respond(paymentPayload, {
      settleResponse: { success: true, transaction: "x", network: paymentPayload.accepted.network },
    });
  return { store, scheme, client, pay, respond, ok };
}

const voucherOf = (payload: PaymentPayload) => (payload.payload as unknown as X207Payload).voucher;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => {
  vi.useRealTimers();
});

describe("SD-018 client createPaymentPayload", () => {
  it("TC-SD-018-01 first voucher of the epoch", async () => {
    const { pay } = setup();
    const payload = await pay();
    expect(voucherOf(payload)).toEqual({
      circle: "x207-circle.near",
      payer: PAYER,
      payee: PAYEE_B,
      epoch: 42,
      seq: 1,
      cumulativeAmount: "20000",
      unit: "credit",
      resource: RESOURCE,
    });
  });

  it("TC-SD-018-02 two requests in a row", async () => {
    const { pay, ok } = setup();
    await ok(await pay());
    const second = voucherOf(await pay());
    expect(second.seq).toBe(2);
    expect(second.cumulativeAmount).toBe("40000");
  });

  it("TC-SD-018-03 commit only after success", async () => {
    const { pay, respond, store } = setup();
    const first = await pay();
    await respond(first, { error: new Error("koneksi putus") });
    expect(await store.get(key())).toEqual({ seq: 0, cumulativeAmount: "0" });
    const retry = voucherOf(await pay());
    expect([retry.seq, retry.cumulativeAmount]).toEqual([1, "20000"]);
  });

  it("TC-SD-018-03 no response at all: the queue is released after the timeout", async () => {
    vi.useFakeTimers();
    const { pay, store } = setup({ confirmTimeoutMs: 60_000 });
    await pay();
    const second = pay();
    await vi.advanceTimersByTimeAsync(59_999);
    let settled = false;
    void second.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(voucherOf(await second).seq).toBe(1);
    expect(await store.get(key())).toEqual({ seq: 0, cumulativeAmount: "0" });
  });

  it("TC-SD-018-04 a new epoch resets", async () => {
    const { pay, store } = setup();
    await store.commit(key(42), { seq: 5, cumulativeAmount: "100000" });
    const voucher = voucherOf(await pay(req({ epoch: 43 })));
    expect([voucher.epoch, voucher.seq, voucher.cumulativeAmount]).toEqual([43, 1, "20000"]);
  });

  it("TC-SD-018-05 state per payee", async () => {
    const { pay, store } = setup();
    await store.commit(key(42, PAYEE_B), { seq: 3, cumulativeAmount: "60000" });
    const voucher = voucherOf(await pay(req({ payTo: "scraper.x207-circle.near" })));
    expect([voucher.seq, voucher.cumulativeAmount]).toEqual([1, "20000"]);
    expect(await store.get(key(42, PAYEE_B))).toEqual({ seq: 3, cumulativeAmount: "60000" });
  });

  it("TC-SD-018-06 valid signature", async () => {
    const { pay } = setup();
    const payload = await pay();
    const { voucher, signature } = payload.payload as unknown as X207Payload;
    expect(verifyVoucher({ ...voucher, signature }, PUBKEY)).toBe(true);
  });

  it("TC-SD-018-07 matches the vector", async () => {
    const vector = readVector("payload/client_seq1_seq2.json");
    const { pay, ok } = setup();
    const first = await pay(vector.input.requirements, vector.input.resource);
    expect(first).toEqual(vector.expected.seq1.paymentPayload);
    expect(encodePaymentSignatureHeader(first)).toBe(vector.expected.seq1.header);
    await ok(first);
    const second = await pay(vector.input.requirements, vector.input.resource);
    expect(second).toEqual(vector.expected.seq2.paymentPayload);
    expect(encodePaymentSignatureHeader(second)).toBe(vector.expected.seq2.header);
  });

  it("TC-SD-018-08 one unconfirmed voucher per (payer, payee)", async () => {
    const { pay, ok } = setup();
    const firstPromise = pay();
    const secondPromise = pay();
    const first = await firstPromise;
    let secondDone = false;
    void secondPromise.then(() => (secondDone = true));
    await tick();
    expect(secondDone).toBe(false);
    expect(voucherOf(first).seq).toBe(1);
    await ok(first);
    const second = await secondPromise;
    expect([voucherOf(second).seq, voucherOf(second).cumulativeAmount]).toEqual([2, "40000"]);
  });

  it("TC-SD-018-08 different payees do not wait for each other", async () => {
    const { pay } = setup();
    await pay(req({ payTo: PAYEE_B }));
    const other = await Promise.race([
      pay(req({ payTo: "scraper.x207-circle.near" })),
      tick().then(() => null),
    ]);
    expect(other).not.toBeNull();
  });

  const resync = (epoch = 42) => ({
    success: false,
    errorReason: "seq_not_increasing",
    transaction: "",
    network: "x207:agents-main",
    payer: PAYER,
    extensions: { x207: { epoch, lastSeq: 137, lastCumulativeAmount: "2740000" } },
  });

  it("TC-SD-018-09 resync: one retry", async () => {
    const { pay, respond, store } = setup();
    const rejected = await pay();
    const recovered = await respond(rejected, { settleResponse: resync() });
    expect(recovered).toEqual({ recovered: true });
    expect(await store.get(key())).toEqual({ seq: 137, cumulativeAmount: "2740000" });

    const retry = await pay();
    const voucher = voucherOf(retry);
    expect([voucher.seq, voucher.cumulativeAmount]).toEqual([138, "2760000"]);

    const second = await respond(retry, { settleResponse: resync() });
    expect(second).toBeUndefined();
  });

  it("TC-SD-018-09 an ordinary rejection does not change state and does not trigger a retry", async () => {
    const { pay, respond, store } = setup();
    const payload = await pay();
    const result = await respond(payload, {
      settleResponse: { success: false, errorReason: "insufficient_credit", transaction: "", network: "x207:agents-main" },
    });
    expect(result).toBeUndefined();
    expect(await store.get(key())).toEqual({ seq: 0, cumulativeAmount: "0" });
  });

  it("TC-SD-018-10 big arithmetic", async () => {
    const { pay, store } = setup();
    await store.commit(key(), { seq: 9, cumulativeAmount: "9007199254740993" });
    const voucher = voucherOf(await pay());
    expect([voucher.seq, voucher.cumulativeAmount]).toEqual([10, "9007199254760993"]);
  });

  it("rejects requirements that are not x207 or an amount that is not valid", async () => {
    const { pay } = setup();
    await expect(pay({ ...req(), amount: "0" })).rejects.toThrow();
    await expect(pay({ ...req(), asset: "usdt.tether-token.near" })).rejects.toThrow();
  });

  it("a signing failure releases the queue", async () => {
    const { pay, scheme } = setup();
    await expect(pay(req(), "https://münchen.example/ü")).rejects.toThrow(/ASCII/);
    const voucher = voucherOf(await pay());
    expect(voucher.seq).toBe(1);
    expect(scheme.scheme).toBe("batch-settlement");
  });

  it("TC-AG-045-01 accept: a circle, payee or epoch the buyer did not choose is refused before any voucher is signed (A-AG-08, A-AG-09)", async () => {
    let open: number | null = 42;
    const { pay, scheme, ok } = setup({ accept: { circles: ["x207-circle.near"], payees: [PAYEE_B], currentEpoch: async () => open } });
    const first = await pay();
    expect(voucherOf(first).payee).toBe(PAYEE_B);
    await ok(first);
    await expect(pay(req({ payTo: "evil.x207-circle.near" }))).rejects.toThrow(/not one that this buyer pays/);
    await expect(pay({ ...req(), extra: { ...req().extra, circleContract: "other-circle.near" } })).rejects.toThrow(/is not one that this buyer pays in/);
    await expect(pay(req({ epoch: 43 }))).rejects.toThrow(/not the open epoch 42/);
    expect(scheme.spentInEpoch(43)).toBe(0n); // nothing was reserved for the refused epoch
    open = null; // epoch unknown: not checked
    expect(voucherOf(await pay(req({ epoch: 43 }))).epoch).toBe(43);
  });
});
