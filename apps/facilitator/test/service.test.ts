import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USDT_TOKEN_ID, signVoucher } from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { KeyPair } from "@near-js/crypto";
import { ExactNearScheme as ExactNearClient, createClientNearSigner, type FacilitatorNearSigner } from "@x402/near";
import * as ExactFacilitator from "@x402/near/exact/facilitator";
import { PendingStore, createApp, createFacilitatorService, type NearRpc } from "../src/index.js";

const kA = Buffer.from(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8")).keys.kA.seed,
  "hex",
);
const KA_PUB = "ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";
const CIRCLE_ACCOUNT = "x207-circle.near";
const A = "a.x207-circle.near";
const B = "b.x207-circle.near";
const CIRCLE = defineCircleConfig({ network: "x207:agents-main", circleContract: CIRCLE_ACCOUNT });
const NOW = Date.now();
const CUTOFF_NS = String(BigInt(NOW + 3_600_000) * 1_000_000n);

const REQ = {
  scheme: "batch-settlement", network: "x207:agents-main", amount: "20000", asset: "USD", payTo: B,
  maxTimeoutSeconds: 60, extra: { circleContract: CIRCLE_ACCOUNT, unit: "credit", decimals: 6, epoch: 42 },
};
const x207Body = (seq: number) => {
  const { signature, ...voucher } = signVoucher(
    { circle: CIRCLE_ACCOUNT, payer: A, payee: B, epoch: 42, seq, cumulativeAmount: String(seq * 20000), unit: "credit", resource: "https://s.example/api" },
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

let epochNumber = 42;
let obligationOf: (args: { debtor: string; creditor: string }) => unknown = () => null;
const VIEWS: Record<string, (args: any) => unknown> = {
  get_epoch: () => ({ epoch: epochNumber, cutoff_at: CUTOFF_NS, phase: "open" }),
  member: ({ account_id }) => member(account_id, account_id === A ? KA_PUB : "ed25519:9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu"),
  headroom: () => "1000000",
  obligation: (args) => obligationOf(args),
};
const rpc = { view: async (_c: string, method: string, args: any) => VIEWS[method]!(args) } as unknown as NearRpc;

const RELAYER = "relayer.x207-circle.near";
const exactSigner = (overrides: Partial<FacilitatorNearSigner> = {}): FacilitatorNearSigner => ({
  getRelayerIds: () => [RELAYER],
  getCurrentBlockHeight: async () => 1_000n,
  viewAccount: async () => ({ codeHash: "9sVzUfNSpErDDvn1ZRQMeZyDQ4ZeqYMoY6yQhWbP1cMA" }),
  viewAccessKey: async () => ({ nonce: 0n, permissionKind: "FullAccess" }),
  ftBalanceOf: async () => 10_000_000n,
  storageBalanceOf: async () => ({ supported: true, registered: true }),
  submitSignedDelegateAction: async () => ({ transaction: "TXHASH", innerReceipt: { kind: "success", value: "" } }),
  ...overrides,
});

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const appOf = (options: Partial<Parameters<typeof createFacilitatorService>[0]> = {}) => {
  const pending = options.pending ?? new PendingStore(":memory:");
  const service = createFacilitatorService({
    circles: [CIRCLE], rpc, pending, signers: [RELAYER], exactSigner: exactSigner(), ...options,
  });
  return { app: createApp(service), pending };
};

const servers: Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.closeAllConnections?.() ?? s.close());
  epochNumber = 42;
  obligationOf = () => null;
  vi.restoreAllMocks();
});

describe("SD-032 rangkaian facilitator", () => {
  it("TC-SD-032-01 /supported memuat batch-settlement x207 dan exact near:mainnet beserta signers", async () => {
    const res = await appOf().app.request("/supported");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kinds: unknown[]; signers: Record<string, string[]> };
    expect(body.kinds).toContainEqual({
      x402Version: 2, scheme: "batch-settlement", network: "x207:agents-main",
      extra: { circleContract: CIRCLE_ACCOUNT, unit: "credit", decimals: 6, epoch: 42 },
    });
    expect(body.kinds).toContainEqual({ x402Version: 2, scheme: "exact", network: "near:mainnet" });
    expect(Object.keys(body.signers).sort()).toEqual(["near:*", "x207:*"]);
    expect(body.signers["x207:*"]).toEqual([RELAYER]);
  });

  it("TC-SD-032-02 extra.epoch dari kontrak: dipakai ulang <60 detik, dibaca ulang sesudahnya", async () => {
    let now = NOW;
    const { app } = appOf({ now: () => now });
    const epochOf = async () =>
      ((await (await app.request("/supported")).json()) as { kinds: Array<{ extra?: { epoch: number } }> }).kinds[0]!.extra!.epoch;
    expect(await epochOf()).toBe(42);
    epochNumber = 43;
    now += 59_000;
    expect(await epochOf()).toBe(42);
    now += 2_000;
    expect(await epochOf()).toBe(43);
  });

  it("TC-SD-032-03 /verify lalu /settle voucher contoh", async () => {
    const { app, pending } = appOf();
    expect(await (await post(app, "/verify", x207Body(1))).json()).toEqual({ isValid: true, payer: A });
    const settled = await (await post(app, "/settle", x207Body(1))).json();
    expect(settled).toMatchObject({ success: true, transaction: `${A}:${B}:42:1`, network: "x207:agents-main" });
    expect(pending.get({ circleContract: CIRCLE_ACCOUNT, payer: A, payee: B, epoch: 42 })).toMatchObject({ seq: 1 });
  });

  it("TC-SD-032-04 pembayaran exact near:mainnet nominal kecil diproses @x402/near", async () => {
    const hits: string[] = [];
    const fake = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const { method, params, id } = JSON.parse(raw);
        hits.push(method);
        const result =
          method === "block"
            ? { header: { height: 1_000, hash: "11111111111111111111111111111111" } }
            : method === "query"
              ? { nonce: 0, permission: "FullAccess", block_height: 1_000, block_hash: "11111111111111111111111111111111" }
              : {};
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
        void params;
      });
    });
    servers.push(fake);
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    const payerKey = KeyPair.fromRandom("ed25519");
    const requirements = {
      scheme: "exact", network: "near:mainnet", amount: "20000", asset: USDT_TOKEN_ID, payTo: B, maxTimeoutSeconds: 60, extra: {},
    };
    const client = new ExactNearClient(
      createClientNearSigner({ accountId: A, secretKey: payerKey.toString() as never, rpcUrls: { "near:mainnet": url } }),
    );
    const created = await client.createPaymentPayload(2, requirements as never);
    const body = {
      x402Version: 2,
      paymentPayload: { x402Version: 2, resource: { url: "https://s.example/api" }, accepted: requirements, payload: created.payload },
      paymentRequirements: requirements,
    };
    const { app } = appOf({
      exactSigner: exactSigner({
        viewAccessKey: async () => ({ nonce: 0n, permissionKind: "FullAccess" }),
      }),
    });
    const verified = await (await post(app, "/verify", body)).json();
    expect(verified).toMatchObject({ isValid: true });
    const settled = await (await post(app, "/settle", body)).json();
    expect(settled).toMatchObject({ success: true, network: "near:mainnet", transaction: "TXHASH" });
  });

  it("TC-SD-032-05 routing per network: scheme x207 hanya menerima x207, exact hanya near:mainnet", async () => {
    const x207Verify = vi.spyOn((await import("@x207/scheme")).X207SchemeFacilitator.prototype, "verify");
    const exactVerify = vi.spyOn(ExactFacilitator.ExactNearScheme.prototype, "verify");
    const { app } = appOf();
    await post(app, "/verify", x207Body(1));
    expect(x207Verify).toHaveBeenCalledTimes(1);
    expect(exactVerify).not.toHaveBeenCalled();

    const exactRequirements = { scheme: "exact", network: "near:mainnet", amount: "20000", asset: USDT_TOKEN_ID, payTo: B, maxTimeoutSeconds: 60, extra: {} };
    await post(app, "/verify", {
      x402Version: 2,
      paymentPayload: { x402Version: 2, resource: { url: "https://s.example/api" }, accepted: exactRequirements, payload: { signedDelegateAction: "AAAA" } },
      paymentRequirements: exactRequirements,
    });
    expect(exactVerify).toHaveBeenCalledTimes(1);
    expect(x207Verify).toHaveBeenCalledTimes(1);
  });

  it("TC-SD-032-06 network x207 yang tidak dikonfigurasi menjawab invalid_network", async () => {
    const other = { ...REQ, network: "x207:other-circle" };
    const body = { ...x207Body(1), paymentRequirements: other };
    const res = await post(appOf().app, "/verify", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isValid: false, invalidReason: "invalid_network" });
    expect(await (await post(appOf().app, "/settle", body)).json()).toMatchObject({ success: false, errorReason: "invalid_network" });
  });

  it("TC-SD-032-07 GET /x207/pair-state: pending, onchain, none, dan 400", async () => {
    const { app, pending } = appOf();
    const query = (payer: string, payee = B) =>
      `/x207/pair-state?network=x207:agents-main&payer=${payer}&payee=${payee}&epoch=42`;

    expect(await (await app.request(query(A))).json()).toEqual({
      network: "x207:agents-main", payer: A, payee: B, epoch: 42, lastSeq: 0, lastCumulativeAmount: "0", source: "none",
    });

    obligationOf = ({ debtor, creditor }) =>
      debtor === A && creditor === B ? { epoch: 42, debtor: A, creditor: B, cumulative: "100000", last_seq: 5, obligation: "100000", cleared: "0" } : null;
    expect(await (await app.request(query(A))).json()).toMatchObject({ source: "onchain", lastSeq: 5, lastCumulativeAmount: "100000" });

    const { signature, ...voucher } = signVoucher(
      { circle: CIRCLE_ACCOUNT, payer: A, payee: B, epoch: 42, seq: 137, cumulativeAmount: "2740000", unit: "credit", resource: "https://s.example/api" },
      kA,
    );
    pending.upsert(CIRCLE_ACCOUNT, voucher, signature);
    const before = pending.get({ circleContract: CIRCLE_ACCOUNT, payer: A, payee: B, epoch: 42 });
    expect(await (await app.request(query(A))).json()).toMatchObject({ source: "pending", lastSeq: 137, lastCumulativeAmount: "2740000" });
    expect(pending.get({ circleContract: CIRCLE_ACCOUNT, payer: A, payee: B, epoch: 42 })).toEqual(before);

    const missing = await app.request(`/x207/pair-state?network=x207:agents-main&payee=${B}&epoch=42`);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "invalid_request" });
    expect((await app.request(`/x207/pair-state?network=x207:agents-main&payer=${A}&payee=${B}&epoch=abc`)).status).toBe(400);
  });
});
