// Limits of the `exact` NEP-366 route (security review 3): sponsored gas, failed settlements per payer, rate limit per client.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USDT_TOKEN_ID } from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { KeyPair } from "@near-js/crypto";
import { ExactNearScheme as ExactNearClient, createClientNearSigner, type FacilitatorNearSigner } from "@x402/near";
import {
  EXACT_DEFAULT_MAX_SPONSORED_GAS, ExactSenderGuard, PendingStore, RateLimiter, createApp, createFacilitatorService, verifiedExactPayer, type NearRpc,
} from "../src/index.js";

const A = "a.x207-circle.near";
const B = "b.x207-circle.near";
const RELAYER = "relayer.x207-circle.near";
const CIRCLE = defineCircleConfig({ network: "x207:agents-main", circleContract: "x207-circle.near" });
const rpc = { view: async () => null } as unknown as NearRpc;

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

const servers: Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.closeAllConnections?.() ?? s.close());
});

/** A real signed delegate action from the standard client, against a fake RPC that only answers block and access key. */
async function signedBody(account = A) {
  const fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const { method, id } = JSON.parse(raw);
      const result = method === "block"
        ? { header: { height: 1_000, hash: "11111111111111111111111111111111" } }
        : method === "query" ? { nonce: 0, permission: "FullAccess", block_height: 1_000, block_hash: "11111111111111111111111111111111" } : {};
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  servers.push(fake);
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const requirements = { scheme: "exact", network: "near:mainnet", amount: "20000", asset: USDT_TOKEN_ID, payTo: B, maxTimeoutSeconds: 60, extra: {} };
  const client = new ExactNearClient(createClientNearSigner({ accountId: account, secretKey: KeyPair.fromRandom("ed25519").toString() as never, rpcUrls: { "near:mainnet": url } }));
  const created = await client.createPaymentPayload(2, requirements as never);
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, resource: { url: "https://s.example/api" }, accepted: requirements, payload: created.payload },
    paymentRequirements: requirements,
  };
}
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const serviceOf = (options: Partial<Parameters<typeof createFacilitatorService>[0]> = {}) =>
  createFacilitatorService({ circles: [CIRCLE], rpc, pending: new PendingStore(":memory:"), signers: [RELAYER], exactSigner: exactSigner(), ...options });
const failed = { transaction: "TX", innerReceipt: { kind: "failure", error: "ft_transfer failed" } } as never;

describe("exact route limits", () => {
  it("TC-SR3-20 the default cap of sponsored gas is the 30 Tgas the standard client asks, and a lower configured cap refuses the same payment", async () => {
    expect(EXACT_DEFAULT_MAX_SPONSORED_GAS).toBe(30_000_000_000_000n);
    const body = await signedBody();
    expect(await (await post(createApp(serviceOf(), { rateLimit: false }), "/verify", body)).json()).toMatchObject({ isValid: true });
    const low = createApp(serviceOf({ exactMaxSponsoredGas: 10_000_000_000_000n }), { rateLimit: false });
    expect(await (await post(low, "/verify", body)).json()).toMatchObject({ isValid: false, invalidReason: "invalid_exact_near_payload_gas_limit_exceeded" });
  });

  it("TC-SR3-21 a payer whose settlements fail three times is refused before anything is submitted, and the relayer is not asked again", async () => {
    const submit = vi.fn(async () => failed);
    const app = createApp(serviceOf({ exactSigner: exactSigner({ submitSignedDelegateAction: submit }) }), { rateLimit: false });
    const body = await signedBody();
    for (let i = 0; i < 3; i += 1) expect(await (await post(app, "/settle", body)).json()).toMatchObject({ success: false, errorReason: "settlement_failed", payer: A });
    expect(submit).toHaveBeenCalledTimes(3);
    expect(await (await post(app, "/settle", body)).json()).toMatchObject({ success: false, errorReason: "payer_paused", payer: A });
    expect(submit).toHaveBeenCalledTimes(3);
    // another payer is not paused
    const other = await signedBody("c.x207-circle.near");
    await post(app, "/settle", other);
    expect(submit).toHaveBeenCalledTimes(4);
  });

  it("TC-SR3-22 a forged payload that names a victim does not pause the victim, and does not reach the relayer", async () => {
    const submit = vi.fn(async () => failed);
    const app = createApp(serviceOf({ exactSigner: exactSigner({ submitSignedDelegateAction: submit }), exactGuard: { failureLimit: 1 } }), { rateLimit: false });
    const real = await signedBody();
    const forged = structuredClone(real);
    const raw = Buffer.from((forged.paymentPayload.payload as { signedDelegateAction: string }).signedDelegateAction, "base64");
    raw[raw.length - 1]! ^= 0xff; // break the signature, the sender id stays the victim's
    (forged.paymentPayload.payload as { signedDelegateAction: string }).signedDelegateAction = raw.toString("base64");
    expect(verifiedExactPayer(forged.paymentPayload)).toBeUndefined();
    for (let i = 0; i < 3; i += 1) await post(app, "/settle", forged);
    expect(submit).not.toHaveBeenCalled();
    // the real payer can still settle (its first failure pauses it only afterwards, limit 1)
    expect(await (await post(app, "/settle", real)).json()).toMatchObject({ errorReason: "settlement_failed" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("TC-SR3-23 a successful settlement clears the failures of the payer", async () => {
    let ok = false;
    const submit = vi.fn(async () => (ok ? { transaction: "TX", innerReceipt: { kind: "success", value: "" } } : failed));
    const app = createApp(serviceOf({ exactSigner: exactSigner({ submitSignedDelegateAction: submit as never }) }), { rateLimit: false });
    const body = await signedBody();
    await post(app, "/settle", body);
    await post(app, "/settle", body);
    ok = true;
    expect(await (await post(app, "/settle", body)).json()).toMatchObject({ success: true });
    ok = false;
    await post(app, "/settle", body);
    await post(app, "/settle", body);
    expect(await (await post(app, "/settle", body)).json()).toMatchObject({ errorReason: "settlement_failed" }); // third failure after the reset, not yet paused before it
  });

  it("TC-SR3-24 the guard: pause after the limit, end of the pause, failures outside the window do not count", () => {
    let now = 0;
    const guard = new ExactSenderGuard({ failureLimit: 2, failureWindowMs: 1_000, pauseMs: 5_000, now: () => now });
    guard.recordFailure("x");
    now = 1_500;
    guard.recordFailure("x");
    expect(guard.pausedFor("x")).toBe(0);
    guard.recordFailure("x");
    expect(guard.pausedFor("x")).toBe(5_000);
    now += 4_999;
    expect(guard.pausedFor("x")).toBe(1);
    now += 1;
    expect(guard.pausedFor("x")).toBe(0);
    expect(() => new ExactSenderGuard({ failureLimit: 0 })).toThrow();
  });

  it("TC-SR3-25 the rate limit answers 429 with Retry-After on /verify and /settle after max requests per client, and not on /supported", async () => {
    let now = 0;
    const app = createApp(serviceOf(), { rateLimit: { windowMs: 60_000, max: 2, now: () => now } });
    const body = await signedBody();
    expect((await post(app, "/verify", body)).status).toBe(200);
    expect((await post(app, "/settle", body)).status).toBe(200);
    const limited = await post(app, "/verify", body);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    expect((await app.request("/supported")).status).not.toBe(429); // not limited (the fake RPC has no epoch, so it answers 500 itself)
    now = 60_001;
    expect((await post(app, "/verify", body)).status).toBe(200);
  });

  it("TC-SR3-26 the limiter counts per client; x-forwarded-for is read only with trustProxy", async () => {
    const hit = async (trustProxy: boolean, ip: string) => {
      const app = createApp(serviceOf(), { rateLimit: { max: 1 }, trustProxy });
      return async () => (await app.request("/verify", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: "{}" })).status;
    };
    const trusted = await hit(true, "1.1.1.1");
    expect(await trusted()).toBe(400); // allowed through to the parser, which refuses the empty body
    expect(await trusted()).toBe(429);
    const untrusted = await hit(false, "2.2.2.2");
    await untrusted();
    expect(await untrusted()).toBe(429); // one socket: the header does not give a new key
    const limiter = new RateLimiter({ max: 1 });
    expect(limiter.hit("a")).toBe(0);
    expect(limiter.hit("b")).toBe(0);
    expect(limiter.hit("a")).toBeGreaterThan(0);
  });

  it("TC-SD-111-01 behind a proxy the client cannot pick its key: the last x-forwarded-for entry counts, a faked first entry does not", async () => {
    const app = createApp(serviceOf(), { rateLimit: { max: 1 }, trustProxy: true });
    const send = async (xff: string) => (await app.request("/verify", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": xff }, body: "{}" })).status;
    expect(await send("9.9.9.1, 7.7.7.7")).toBe(400);
    expect(await send("9.9.9.2, 7.7.7.7")).toBe(429); // same proxy-seen address, a different fake first entry
    expect(await send("7.7.7.8")).toBe(400); // another real client
  });

  it("TC-SD-111-02 a flood of new keys does not reset the count of a client that is over the limit", () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000, now: () => now });
    expect(limiter.hit("abuser")).toBe(0);
    expect(limiter.hit("abuser")).toBeGreaterThan(0);
    for (let i = 0; i < RateLimiter.MAX_KEYS + 5; i++) limiter.hit(`k${i}`);
    // the oldest keys went (the abuser was the oldest): a limiter that stays bounded may forget it, but it must never forget everybody at once
    expect(limiter.hit(`k${RateLimiter.MAX_KEYS + 4}`)).toBeGreaterThan(0);
    now = 120_000;
    expect(limiter.hit("abuser")).toBe(0); // expired windows are dropped normally
  });
});
