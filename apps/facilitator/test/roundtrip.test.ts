// SD-033: x402 round-trip in CI: x207Middleware, facilitator (createApp + createFacilitatorService), mock contract,
// @x402/fetch + x207 client. The whole network is served by one fetch function.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { describe, expect, it } from "vitest";
import { USDT_TOKEN_ID, type ContractAbi } from "@x207/core";
import { X207PaymentClient, X207SchemeClient, X207ExtraSource, defineCircleConfig, x207Middleware } from "@x207/scheme";
import { PendingStore, RegistrationScheduler, createApp, createFacilitatorService, type NearRpc, type RegistrationChain } from "../src/index.js";

const keys = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8"),
).keys;
const A = "translator.x207-circle.near";
const B = "summarizer.x207-circle.near";
const D = "cleaner.x207-circle.near";
const L = "image.x207-circle.near";
const CIRCLE = "x207-circle.near";
const NETWORK = "x207:agents-main";
const START = 1_800_000_000_000;
const CUTOFF_MS = START + 3_600_000;
const SEED = (name: string) => Buffer.from(keys[name].seed, "hex");

type World = ReturnType<typeof makeWorld>;

function makeWorld(options: { handlerStatus?: number } = {}) {
  const clock = { now: START };
  const state = {
    epoch: 42,
    cutoffMs: CUTOFF_MS,
    headroom: new Map<string, string>(),
    exiting: new Set<string>(),
    facilitatorDown: false,
    dropNextSellerResponse: false,
    handlerStatus: options.handlerStatus ?? 200,
    handlerCalls: 0,
    facilitatorCalls: [] as string[],
  };
  const pubkeys: Record<string, string> = {
    [A]: keys.kA.publicKey, [B]: keys.kB.publicKey, [D]: keys.kD.publicKey, [L]: keys.kC.publicKey,
  };
  const member = (account: string): ContractAbi.MemberView | null =>
    pubkeys[account]
      ? {
          account_id: account, admitted: false, exit_requested_epoch: state.exiting.has(account) ? state.epoch : null,
          joined_at: "1", last_active_epoch: state.epoch, limit: "1000000", pubkey_voucher: pubkeys[account]!,
          settled_history: "0", stake: "1000000", status: "active", terms_hash: "0".repeat(64),
        }
      : null;
  /** A view the mock does not know is an error that names it, not a TypeError (SD-074 follow-up). */
  const viewOf = (views: Record<string, (args: any) => unknown>, method: string): ((args: any) => unknown) =>
    views[method] ?? (() => { throw new Error(`mock RPC has no view ${method}`); });
  const VIEWS: Record<string, (args: any) => unknown> = {
    get_epoch: () => ({ epoch: state.epoch, cutoff_at: String(BigInt(state.cutoffMs) * 1_000_000n), phase: "open" }),
    member: ({ account_id }) => member(account_id),
    is_frozen: () => false,
    interface_version: () => "0.0.12",
    headroom: ({ account_id }) => state.headroom.get(account_id) ?? "1000000",
    obligation: () => null,
    last_seq: () => 0,
  };
  const rpc = { view: async (_c: string, method: string, args: any) => viewOf(VIEWS, method)(args) } as unknown as NearRpc;
  const pending = new PendingStore(":memory:", () => clock.now);
  const circle = defineCircleConfig({ network: NETWORK, circleContract: CIRCLE });
  const service = createFacilitatorService({ circles: [circle], rpc, pending, now: () => clock.now, verify: { now: () => clock.now } });
  const facilitator = createApp(service);

  let routed: typeof fetch;
  const seller = x207Middleware({
    routes: { "/api/summarize": { price: "$0.02", description: "Summarize text" } },
    facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B,
    fetch: (input, init) => routed(input, init),
    extra: new X207ExtraSource({ facilitatorUrl: "http://facilitator.test", fetch: (i, n) => routed(i, n), now: () => clock.now }),
  });
  routed = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const { hostname, pathname } = new URL(request.url);
    if (hostname === "rpc.test") {
      const { params } = (await request.json()) as any;
      const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
      return Response.json({ jsonrpc: "2.0", id: "x207", result: { result: [...Buffer.from(JSON.stringify(viewOf(VIEWS, params.method_name)(args)))] } });
    }
    if (hostname === "facilitator.test") {
      if (state.facilitatorDown) throw new TypeError("fetch failed");
      state.facilitatorCalls.push(pathname);
      if (request.method === "POST") {
        const body = (await request.clone().json()) as any;
        if (body.paymentRequirements?.scheme === "exact") {
          // Mock `exact` facilitator (SD-036 tests the real @x402/near path).
          return Response.json(
            pathname === "/verify" ? { isValid: true, payer: A } : { success: true, transaction: "EXACTTX", network: "near:mainnet", payer: A },
          );
        }
      }
      return facilitator.fetch(request);
    }
    if (hostname === "seller.test") {
      const response = await seller(request, async () => {
        state.handlerCalls += 1;
        return state.handlerStatus === 200 ? Response.json({ summary: "summary text" }) : new Response("failed", { status: state.handlerStatus });
      });
      if (state.dropNextSellerResponse && request.headers.has("PAYMENT-SIGNATURE")) {
        state.dropNextSellerResponse = false;
        throw new TypeError("connection dropped");
      }
      return response;
    }
    return new Response("unknown", { status: 404 });
  }) as typeof fetch;

  const exact = {
    scheme: "exact",
    findDefaultAsset: (asset: string) => (asset === USDT_TOKEN_ID ? { asset, decimals: 6, symbol: "USDT" } : undefined),
    createPaymentPayload: async (v: number) => ({ x402Version: v, payload: { signedDelegateAction: "AAAA" } }),
  };
  /** Complete buyer: x207 + mock `exact` for fallback. */
  const buyer = (payer: string, seed: Uint8Array) => {
    const client = new X207PaymentClient({
      payer, secretKey: seed, now: () => clock.now,
      headroom: async (_c, who) => {
        const response = await routed("http://rpc.test", {
          method: "POST",
          body: JSON.stringify({ params: { args_base64: Buffer.from(JSON.stringify({ account_id: who })).toString("base64"), method_name: "headroom" } }),
        });
        const body = (await response.json()) as any;
        return JSON.parse(Buffer.from(body.result.result).toString("utf8")) as string | null;
      },
    });
    client.register("near:*", exact as never);
    return { client, fetch: wrapFetchWithPayment(routed, client) };
  };
  const decode = (header: string | null) => (header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null);
  return { clock, state, pending, routed: () => routed, rpc, buyer, decode, service, circle };
}

const URL_ = "https://seller.test/api/summarize";
const key = (payer: string, payee = B, epoch = 42) => ({ circleContract: CIRCLE, payer, payee, epoch });
const sig = (w: World, response: Response) => w.decode(response.headers.get("PAYMENT-RESPONSE"));
const raw402 = (w: World) => w.routed()(URL_);

describe("SD-033 round-trip x402", () => {
  it("TC-SD-033-01 402, then pay, then 200 with commitment id and registration pending", async () => {
    const w = makeWorld();
    const challenge = await raw402(w);
    expect(challenge.status).toBe(402);
    const required = w.decode(challenge.headers.get("PAYMENT-REQUIRED"));
    expect(required.accepts.map((a: any) => `${a.scheme}@${a.network}`)).toEqual([`batch-settlement@${NETWORK}`, "exact@near:mainnet"]);

    const { fetch: paid } = w.buyer(A, SEED("kA"));
    const response = await paid(URL_);
    expect(response.status).toBe(200);
    expect(sig(w, response)).toMatchObject({
      success: true, transaction: `${A}:${B}:42:1`, extensions: { x207: { registration: "pending" } },
    });
    expect(w.state.facilitatorCalls).toEqual(expect.arrayContaining(["/supported", "/verify", "/settle"]));
  });

  it("TC-SD-033-02 two calls in a row: seq 1 then seq 2 with the cumulative rising", async () => {
    const w = makeWorld();
    const { fetch: paid } = w.buyer(A, SEED("kA"));
    expect(sig(w, await paid(URL_)).extensions.x207).toMatchObject({ seq: 1, cumulativeAmount: "20000" });
    expect(sig(w, await paid(URL_)).extensions.x207).toMatchObject({ seq: 2, cumulativeAmount: "40000" });
  });

  it("TC-SD-033-03 a signature with another key is rejected and the handler is not called", async () => {
    const w = makeWorld();
    const { fetch: paid } = w.buyer(A, SEED("kZ"));
    const response = await paid(URL_);
    expect(response.status).toBe(402);
    expect(w.decode(response.headers.get("PAYMENT-REQUIRED")).error).toBe("invalid_signature");
    expect(w.state.handlerCalls).toBe(0);
  });

  it("TC-SD-033-04 replay of the PAYMENT-SIGNATURE header is rejected with seq_not_increasing", async () => {
    const w = makeWorld();
    const seen: string[] = [];
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const header = request.headers.get("PAYMENT-SIGNATURE");
      if (header) seen.push(header);
      return w.routed()(request);
    }) as typeof fetch;
    const client = w.buyer(A, SEED("kA")).client;
    await wrapFetchWithPayment(spy, client)(URL_);
    expect(seen).toHaveLength(1);
    w.state.handlerCalls = 0;
    const replay = await w.routed()(URL_, { headers: { "PAYMENT-SIGNATURE": seen[0]! } });
    expect(replay.status).toBe(402);
    expect(w.decode(replay.headers.get("PAYMENT-REQUIRED")).error).toBe("seq_not_increasing");
    expect(w.state.handlerCalls).toBe(0);
  });

  it("TC-SD-033-05 near cutoff: epoch_closing and accepts still holds exact", async () => {
    const w = makeWorld();
    const lateFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.headers.has("PAYMENT-SIGNATURE")) w.clock.now = CUTOFF_MS - 60_000;
      return w.routed()(request);
    }) as typeof fetch;
    const response = await wrapFetchWithPayment(lateFetch, w.buyer(A, SEED("kA")).client)(URL_);
    expect(response.status).toBe(402);
    const challenge = w.decode(response.headers.get("PAYMENT-REQUIRED"));
    expect(challenge.error).toBe("epoch_closing");
    expect(challenge.accepts.some((a: any) => a.scheme === "exact")).toBe(true);
    expect(w.state.handlerCalls).toBe(0);
  });

  it("TC-SD-033-06 headroom used up: insufficient_credit, then the client pays exact and the final result is 200", async () => {
    const w = makeWorld();
    w.state.headroom.set(D, "30000");
    const { fetch: paid } = w.buyer(D, SEED("kD"));
    expect((await paid(URL_)).status).toBe(200);
    w.state.headroom.set(D, "30000");
    const second = await paid(URL_);
    expect(second.status).toBe(200);
    expect(sig(w, second)).toMatchObject({ success: true, transaction: "EXACTTX", network: "near:mainnet" });
  });

  it("TC-SD-033-07 payer is exiting: member_exiting, then the client falls back to exact", async () => {
    const w = makeWorld();
    w.state.exiting.add(L);
    const { fetch: paid } = w.buyer(L, SEED("kC"));
    const response = await paid(URL_);
    expect(response.status).toBe(200);
    expect(sig(w, response)).toMatchObject({ network: "near:mainnet" });
  });

  it("TC-SD-033-08 registration failing twice rejects new vouchers until registration recovers", async () => {
    const w = makeWorld();
    let failing = true;
    const chain: RegistrationChain = {
      register: async () => { if (failing) throw new Error("RPC timeout"); },
      lastSeq: async () => 0,
      getEpoch: async () => ({ epoch: 42, cutoff_at: String(BigInt(CUTOFF_MS) * 1_000_000n) } as ContractAbi.EpochView),
    };
    const scheduler = new RegistrationScheduler({
      circleContract: CIRCLE, store: w.pending, chain, now: () => w.clock.now, log: () => {}, registerThreshold: 1n,
    });
    const { client } = w.buyer(A, SEED("kA"));
    const paid = wrapFetchWithPayment(w.routed(), client);
    expect((await paid(URL_)).status).toBe(200);
    await scheduler.tick();
    w.clock.now += 5_000;
    await scheduler.tick();
    expect(w.pending.get(key(A))).toMatchObject({ attempts: 2, state: "retrying" });

    const second = await paid(URL_);
    expect(second.status).toBe(402);
    expect(w.decode(second.headers.get("PAYMENT-REQUIRED"))?.error).toBe("registration_retry_pending");

    failing = false;
    w.clock.now += 10_000;
    await scheduler.tick();
    expect(w.pending.get(key(A))).toMatchObject({ attempts: 0, state: "registered" });
    expect((await paid(URL_)).status).toBe(200);
  });

  it("TC-SD-033-09 handler 500: no /settle and the next seq stays 1", async () => {
    const w = makeWorld({ handlerStatus: 500 });
    const { fetch: paid } = w.buyer(A, SEED("kA"));
    const failed = await paid(URL_);
    expect(failed.status).toBe(500);
    expect(w.state.facilitatorCalls).not.toContain("/settle");
    expect(w.pending.get(key(A))).toBeNull();
    w.state.handlerStatus = 200;
    const next = await paid(URL_);
    expect(sig(w, next).extensions.x207).toMatchObject({ seq: 1, cumulativeAmount: "20000" });
  });

  it("TC-SD-033-10 response lost: the client resyncs through pair-state and succeeds with the next seq", async () => {
    const w = makeWorld();
    const client = new x402Client();
    client.register("x207:*", new X207SchemeClient({ payer: A, secretKey: SEED("kA"), confirmTimeoutMs: 50 }));
    const paid = wrapFetchWithPayment(w.routed(), client);
    w.state.dropNextSellerResponse = true;
    await expect(paid(URL_)).rejects.toThrow();
    expect(w.pending.get(key(A))).toMatchObject({ seq: 1 });

    await new Promise((r) => setTimeout(r, 80));
    const recovered = await paid(URL_);
    expect(recovered.status).toBe(200);
    expect(sig(w, recovered).extensions.x207).toMatchObject({ seq: 2, cumulativeAmount: "40000" });
  });

  it("TC-SD-033-11 after a successful registration, the same settle is answered with registration registered", async () => {
    const w = makeWorld();
    const headers: string[] = [];
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const header = request.headers.get("PAYMENT-SIGNATURE");
      if (header) headers.push(header);
      return w.routed()(request);
    }) as typeof fetch;
    const chain: RegistrationChain = {
      register: async () => {},
      lastSeq: async () => 0,
      getEpoch: async () => ({ epoch: 42, cutoff_at: String(BigInt(CUTOFF_MS) * 1_000_000n) } as ContractAbi.EpochView),
    };
    const scheduler = new RegistrationScheduler({ circleContract: CIRCLE, store: w.pending, chain, now: () => w.clock.now, log: () => {}, registerThreshold: 1n });
    const response = await wrapFetchWithPayment(spy, w.buyer(A, SEED("kA")).client)(URL_);
    expect(sig(w, response).extensions.x207.registration).toBe("pending");
    await scheduler.tick();
    expect(w.pending.get(key(A))).toMatchObject({ state: "registered", registeredSeq: 1 });

    const payload = w.decode(headers[0]!);
    const again = await w.service.settle({ x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted });
    expect(again).toMatchObject({ success: true, extensions: { x207: { seq: 1, registration: "registered" } } });
  });

  it("TC-SD-033-12 epoch change: the new challenge holds extra.epoch 43 and the voucher seq 1", async () => {
    const w = makeWorld();
    const { fetch: paid } = w.buyer(A, SEED("kA"));
    expect(sig(w, await paid(URL_)).extensions.x207).toMatchObject({ epoch: 42, seq: 1 });
    w.state.epoch = 43;
    w.clock.now += 61_000;
    const challenge = w.decode((await raw402(w)).headers.get("PAYMENT-REQUIRED"));
    expect(challenge.accepts[0].extra.epoch).toBe(43);
    const next = await paid(URL_);
    expect(sig(w, next).extensions.x207).toMatchObject({ epoch: 43, seq: 1, cumulativeAmount: "20000" });
  });

  it("TC-SD-033-13 facilitator down: 503 with Retry-After 5", async () => {
    const w = makeWorld();
    w.state.facilitatorDown = true;
    const response = await raw402(w);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
  });
});
