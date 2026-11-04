import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { generateVoucherKeypair, listingHash, termsHash, verifyListingSignature, verifyOfferSignature, voucherPublicKey, type ContractCall } from "@x207/core";
import { describe, expect, it } from "vitest";
import { Guards } from "../src/guards.js";
import { startHttpServer } from "../src/http.js";
import { createX207McpServer, toolsFor } from "../src/server.js";
import { WRITE_TOOLS, availableWriteTools, createWriteRuntime } from "../src/write-tools.js";
import { ConfigError } from "../src/config.js";
import { scrub, writeConfigFromEnv, type WriteConfig } from "../src/write-config.js";
import { mock, type Mock } from "./mock.js";

const AGENT = "agent.x207-v013.testnet";
const SELLER = "seller.x207-v013.testnet";
const voucher = generateVoucherKeypair();
const nearKey = generateVoucherKeypair(); // any ed25519 pair stands for the NEAR key in the unit tests
const h64 = (c: string) => c.repeat(64);

const cfg = (over: Partial<WriteConfig> = {}): WriteConfig => ({
  account: AGENT, voucherKey: voucher.secretKey, nearKey: null, maxSpendSession: 1_000_000n, maxPricePerCall: 100_000n, allowedCounterparties: [], allowOutflows: false, allowFullAccessKey: false, ...over,
});

/** Active members: the agent, the seller and a few others; `ghost` is not a member and `suspended` is not active. */
function world(over: Partial<Mock["viewAnswers"]> = {}): Mock {
  const m = mock();
  m.viewAnswers.member = (a: any) => (a.account_id === "ghost.x207-v013.testnet" ? null : { account_id: a.account_id, status: a.account_id.startsWith("suspended") ? "suspended" : "active" });
  m.viewAnswers.headroom = "5000000";
  m.viewAnswers.get_circle = { circle_id: "agents-main", usdt_token_id: "usdt.x207-deployer.testnet" };
  Object.assign(m.viewAnswers, over);
  return m;
}

async function connect(m: Mock, write: WriteConfig | null, extra: { send?: (c: ContractCall) => Promise<unknown>; now?: () => number } = {}, transport: "stdio" | "http" = "stdio") {
  const server = createX207McpServer(m.config, transport, { write, ...extra });
  const client = new Client({ name: "write-test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const text = r.content[0]!.text;
    let json: any = null;
    try {
      json = r.isError ? null : JSON.parse(text);
    } catch {
      // not JSON
    }
    return { isError: r.isError === true, text, json };
  };
  return { client, names, call };
}

const REQ = (amount: string, payTo = SELLER) => ({
  scheme: "batch-settlement", network: "x207:agents-main", amount, asset: "USD", payTo, maxTimeoutSeconds: 60,
  extra: { circleContract: "x207-v013.testnet", unit: "credit", decimals: 6, epoch: 7 },
});
/** A seller: 402 with an x207 requirement until a PAYMENT-SIGNATURE comes, then 200. */
function seller(m: Mock, amount: string, payTo = SELLER) {
  const hits: string[] = [];
  m.other = (url, init) => {
    if (!url.startsWith("https://seller.test/")) return undefined;
    const signed = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
    hits.push(signed ? "paid" : "probe");
    if (!signed) {
      const required: PaymentRequired = { x402Version: 2, resource: { url }, accepts: [REQ(amount, payTo) as never] };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } });
    }
    return new Response(JSON.stringify({ summary: "done" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return hits;
}

/** A listing as the book gives it, with the hash that belongs to its content (the tool checks it). */
const listingView = (over: Record<string, unknown> = {}) => {
  const v = rawListing(over);
  const { listingHash: _drop, ...rest } = v;
  void _drop;
  const listing = { circle: "x207-v013.testnet", account: v.account, offer: { asset_type: v.offer.assetType, asset_class: v.offer.assetClass, quantity: v.offer.quantity, value: v.offer.value }, want: { asset_type: v.want.assetType, asset_class: v.want.assetClass, quantity: v.want.quantity, value: v.want.value }, terms: v.terms, detail: v.detail, expires_at: Math.floor(Date.parse(v.expiresAt) / 1000), discount_bps: v.discountBps, accept_payment: v.acceptPayment, discoverable: v.discoverable, nonce: v.nonce } as never;
  return { ...rest, listingHash: listingHash(listing) };
};
const rawListing = (over: Record<string, unknown> = {}) => ({
  listingHash: h64("a"), account: SELLER, offer: { assetType: "service:summary", assetClass: "B", quantity: 1, value: "50000" }, want: { assetType: "usdc", assetClass: "A", quantity: 1, value: "50000" },
  terms: "t", detail: "d", expiresAt: "2099-01-01T00:00:00Z", discountBps: 0, acceptPayment: true, discoverable: true, nonce: "n1", status: "open", ...over,
}) as any;

describe("SD-082: which write tools exist", () => {
  it("TC-SD-082-01 without X207_MCP_WRITE=1 the server is read-only; on HTTP it stays read-only whatever the configuration says", async () => {
    const m = world();
    const read = (await connect(m, null)).names;
    expect(await read()).toHaveLength(6);
    expect(await (await connect(m, cfg(), {}, "http")).names()).toHaveLength(6);
    const http = await startHttpServer(m.config, { port: 0 });
    try {
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const c = new Client({ name: "h", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(http.url)));
      expect((await c.listTools()).tools.map((t) => t.name).sort().filter((n) => WRITE_TOOLS.some((w) => w.name === n))).toEqual([]);
      await c.close();
    } finally {
      await http.close();
    }
    expect(toolsFor("http").every((t) => t.access === "read")).toBe(true);
  });

  it("TC-SD-082-02 the risky tools are off by default: join and settle need X207_ALLOW_OUTFLOWS, all three NEAR tools need a full-access key switch", async () => {
    const names = async (over: Partial<WriteConfig>) => (await (await connect(world(), cfg(over))).names()).filter((n) => WRITE_TOOLS.some((w) => w.name === n));
    expect(await names({})).toEqual(["x207_accept_offer", "x207_confirm_milestone", "x207_list_offer", "x207_make_offer", "x207_pay_request"]);
    expect(await names({ nearKey: nearKey.secretKey })).not.toContain("x207_claim");
    expect(await names({ nearKey: nearKey.secretKey, allowFullAccessKey: true })).toEqual(expect.arrayContaining(["x207_claim"]));
    expect(await names({ nearKey: nearKey.secretKey, allowFullAccessKey: true })).not.toContain("x207_settle");
    expect(await names({ nearKey: nearKey.secretKey, allowFullAccessKey: true, allowOutflows: true })).toEqual(expect.arrayContaining(["x207_join", "x207_settle", "x207_claim"]));
    expect(await names({ voucherKey: null })).toEqual([]); // no voucher key, no NEAR key: nothing to sign with
    const noBook = mock({ backendUrl: null });
    expect((await (await connect(noBook, cfg())).names()).filter((n) => WRITE_TOOLS.some((w) => w.name === n))).toEqual(["x207_pay_request"]);
  });

  it("TC-SD-082-03 the configuration is read from the environment and a bad value stops the server without showing a key", () => {
    expect(writeConfigFromEnv({})).toBeNull();
    expect(writeConfigFromEnv({ X207_MCP_WRITE: "0" })).toBeNull();
    expect(() => writeConfigFromEnv({ X207_MCP_WRITE: "1" })).toThrow(/X207_AGENT_ACCOUNT/);
    const bad = "ed25519:notakey";
    let message = "";
    try {
      writeConfigFromEnv({ X207_MCP_WRITE: "1", X207_AGENT_ACCOUNT: AGENT, X207_AGENT_VOUCHER_KEY: bad });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/X207_AGENT_VOUCHER_KEY is not an ed25519 secret key/);
    expect(message).not.toContain(bad);
    expect(() => writeConfigFromEnv({ X207_MCP_WRITE: "1", X207_AGENT_ACCOUNT: AGENT, X207_MAX_SPEND_SESSION: "-5" })).toThrow(ConfigError);
    expect(() => writeConfigFromEnv({ X207_MCP_WRITE: "1", X207_AGENT_ACCOUNT: AGENT, X207_ALLOWED_COUNTERPARTIES: "ok.near, bad name" })).toThrow(/X207_ALLOWED_COUNTERPARTIES/);
    const c = writeConfigFromEnv({ X207_MCP_WRITE: "1", X207_AGENT_ACCOUNT: AGENT, X207_AGENT_VOUCHER_KEY: voucher.secretKey, X207_ALLOWED_COUNTERPARTIES: "a.near,b.near" })!;
    expect(c).toMatchObject({ maxSpendSession: 1_000_000n, maxPricePerCall: 100_000n, allowOutflows: false, allowFullAccessKey: false, allowedCounterparties: ["a.near", "b.near"] });
    expect(scrub(`boom ${voucher.secretKey} and ${nearKey.secretKey}`, c)).toBe("boom [key] and [key]");
  });
});

describe("SD-082: the guards, one by one", () => {
  it("TC-SD-082-04 guard price per call: a payment above X207_MAX_PRICE_PER_CALL is refused before anything is signed, whatever the 402 says", async () => {
    const m = world();
    const hits = seller(m, "100001");
    const r = await (await connect(m, cfg())).call("x207_pay_request", { url: "https://seller.test/api" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/price of the request of 100001 is above X207_MAX_PRICE_PER_CALL \(100000\)/);
    expect(hits).toEqual(["probe"]); // the payment was never sent
  });

  it("TC-SD-082-05 guard budget of the session: payments add up, the one that does not fit is refused, and a refused one costs nothing", async () => {
    const m = world();
    const hits = seller(m, "60000");
    const { call } = await connect(m, cfg({ maxSpendSession: 130_000n }));
    const one = await call("x207_pay_request", { url: "https://seller.test/api" });
    expect(one.json).toMatchObject({ status: 200, paid: false, session: { spent: "60000", remaining: "70000" } });
    expect(JSON.parse(one.json.body)).toEqual({ summary: "done" });
    const two = await call("x207_pay_request", { url: "https://seller.test/api" });
    expect(two.json.session).toEqual({ spent: "120000", remaining: "10000" });
    const three = await call("x207_pay_request", { url: "https://seller.test/api" });
    expect(three.isError).toBe(true);
    expect(three.text).toMatch(/would take this session to 180000, above X207_MAX_SPEND_SESSION \(130000\); 10000 left/);
    expect(hits.filter((h) => h === "paid")).toHaveLength(2);
  });

  it("TC-SD-082-06 guard counterparties: a payee that is not a member, not active, not on the operator's list, or the agent itself is refused", async () => {
    for (const [payTo, list, want] of [
      ["ghost.x207-v013.testnet", [], /ghost.x207-v013.testnet is not an active member/],
      ["suspended.x207-v013.testnet", [], /suspended.x207-v013.testnet is not an active member/],
      [SELLER, ["other.x207-v013.testnet"], /not in X207_ALLOWED_COUNTERPARTIES/],
      [AGENT, [], /cannot deal with itself/],
    ] as const) {
      const m = world();
      const hits = seller(m, "1000", payTo);
      const r = await (await connect(m, cfg({ allowedCounterparties: list }))).call("x207_pay_request", { url: "https://seller.test/api" });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(want);
      expect(hits).toEqual(["probe"]);
    }
    const ok = world();
    seller(ok, "1000");
    expect((await (await connect(ok, cfg({ allowedCounterparties: [SELLER] }))).call("x207_pay_request", { url: "https://seller.test/api" })).json.status).toBe(200);
  });

  it("TC-SD-082-07 the URL of x207_pay_request must be http or https without credentials", async () => {
    const m = world();
    const { call } = await connect(m, cfg());
    expect((await call("x207_pay_request", { url: "file:///etc/passwd" })).isError).toBe(true);
    expect((await call("x207_pay_request", { url: "https://user:pw@seller.test/api" })).text).toMatch(/must not carry credentials/);
  });

  it("TC-SD-082-08 guard outflows: x207_join and x207_settle refuse without X207_ALLOW_OUTFLOWS=1 and send nothing", async () => {
    const m = world();
    const sent: ContractCall[] = [];
    const rt = createWriteRuntime(m.config, cfg({ nearKey: nearKey.secretKey, allowFullAccessKey: true }), async () => null, { post: null, send: async (c) => (sent.push(c), undefined) });
    const ctx = { view: async () => null, backend: null, circleContract: "x207-v013.testnet", circleId: "agents-main", write: rt };
    const join = WRITE_TOOLS.find((t) => t.name === "x207_join")!;
    const settle = WRITE_TOOLS.find((t) => t.name === "x207_settle")!;
    await expect(join.handler({ terms_hash: h64("a"), stake_amount: "1000" } as never, ctx)).rejects.toThrow(/moves funds out of the agent account; set X207_ALLOW_OUTFLOWS=1/);
    await expect(settle.handler({ epoch: 1 } as never, ctx)).rejects.toThrow(/X207_ALLOW_OUTFLOWS=1/);
    expect(sent).toEqual([]);
    expect(availableWriteTools(rt, true).map((t) => t.name)).not.toContain("x207_join");
  });

  it("TC-SD-082-09 guard keys: a function-call key cannot attach a deposit, a full-access key needs its own switch, a key that is not on the account is refused", () => {
    const g = (over: Partial<WriteConfig>) => new Guards(cfg({ nearKey: nearKey.secretKey, ...over }), async () => null);
    expect(() => g({}).nearKey("function-call", "x207_claim")).toThrow(/function-call key, which cannot attach the deposit that x207_claim needs/);
    expect(() => g({}).nearKey("full-access", "x207_claim")).toThrow(/X207_ALLOW_FULL_ACCESS_KEY=1/);
    expect(() => g({ allowFullAccessKey: true }).nearKey("full-access", "x207_claim")).not.toThrow();
    expect(() => g({ allowFullAccessKey: true }).nearKey("unknown", "x207_claim")).toThrow(/not a key of agent/);
    expect(() => g({ nearKey: null }).nearKey("none", "x207_claim")).toThrow(/needs X207_AGENT_NEAR_KEY/);
  });

  it("TC-SD-082-10 a NEAR tool with a function-call key on the account sends no transaction", async () => {
    const m = world();
    m.other = (url, init) => {
      if (!url.startsWith("https://rpc.mock.test")) return undefined;
      return undefined;
    };
    const sent: ContractCall[] = [];
    const baseFetch = m.config.fetch!;
    m.config.fetch = (async (input: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.params?.request_type === "view_access_key") return Response.json({ jsonrpc: "2.0", id: "x207", result: { nonce: 1, permission: { FunctionCall: { allowance: "1", receiver_id: "x207-v013.testnet", method_names: [] } } } });
      return baseFetch(input, init);
    }) as typeof fetch;
    m.viewAnswers.net_position = { account_id: AGENT, role: "creditor", status: "claimable", amount: "5", epoch: 3 };
    const { call } = await connect(m, cfg({ nearKey: nearKey.secretKey, allowFullAccessKey: true }), { send: async (c) => (sent.push(c), undefined) });
    const r = await call("x207_claim", { epoch: 3 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/function-call key, which cannot attach the deposit that x207_claim needs; no transaction was sent/);
    expect(sent).toEqual([]);
  });
});

describe("SD-082: the marketplace and order tools, mock book", () => {
  it("TC-SD-082-11 x207_list_offer signs a listing with the voucher key (a verifiable signature) and posts it with the agent as the lister", async () => {
    const m = world();
    m.postAnswers["/listings"] = (b: any) => ({ listingHash: listingHash(b.listing), status: "open" });
    const { call } = await connect(m, cfg(), { now: () => 1_800_000_000_000 });
    const r = await call("x207_list_offer", { offer_asset_type: "service:translation", offer_class: "B", offer_quantity: 10, offer_value: "50000", want_asset_type: "service:summary", want_class: "B", want_quantity: 10, want_value: "50000", expires_in_hours: 24 });
    expect(r.isError).toBe(false);
    const sent = m.posts[0]!.body;
    expect(sent.listing).toMatchObject({ circle: "x207-v013.testnet", account: AGENT, expires_at: 1_800_000_000 + 86_400, offer: { asset_type: "service:translation", quantity: 10 } });
    expect(verifyListingSignature(sent.listing, sent.signature, voucherPublicKey(voucher.secretKey))).toBe(true);
    expect(r.json.listingHash).toBe(listingHash(sent.listing));
  });

  it("TC-SD-082-12 x207_make_offer signs an offer on a listing; a price above the cap, a stranger as lister, the agent's own listing and a listing that does not match its hash are refused with nothing posted", async () => {
    const m = world();
    const L = listingView();
    m.backendAnswers[`/listings/${L.listingHash}`] = L;
    m.postAnswers[`/listings/${L.listingHash}/offers`] = { offerHash: "x", status: "pending" };
    const { call } = await connect(m, cfg(), { now: () => 1_800_000_000_000 });
    const ok = await call("x207_make_offer", { listing_hash: L.listingHash, mode: "pay", value: "50000", quantity: 1 });
    expect(ok.isError).toBe(false);
    const posted = m.posts[0]!.body;
    expect(posted.offer).toMatchObject({ proposer: AGENT, round: 1, mode: "pay", value: "50000", listing_hash: L.listingHash });
    expect(verifyOfferSignature(posted.offer, posted.signature, voucherPublicKey(voucher.secretKey))).toBe(true);
    m.posts.length = 0;
    expect((await call("x207_make_offer", { listing_hash: L.listingHash, mode: "pay", value: "100001" })).text).toMatch(/above X207_MAX_PRICE_PER_CALL/);
    const G = listingView({ account: "ghost.x207-v013.testnet" });
    m.backendAnswers[`/listings/${G.listingHash}`] = G;
    expect((await call("x207_make_offer", { listing_hash: G.listingHash, mode: "pay", value: "1000" })).text).toMatch(/ghost.x207-v013.testnet is not an active member/);
    const S = listingView({ account: AGENT });
    m.backendAnswers[`/listings/${S.listingHash}`] = S;
    expect((await call("x207_make_offer", { listing_hash: S.listingHash, mode: "pay", value: "1000" })).text).toMatch(/cannot deal with itself/);
    m.backendAnswers[`/listings/${h64("f")}`] = L; // the book answers with another listing than the hash asked for
    expect((await call("x207_make_offer", { listing_hash: h64("f"), mode: "pay", value: "1000" })).text).toMatch(/does not hash to/);
    expect(m.posts).toEqual([]);
  });

  it("TC-SD-082-13 x207_accept_offer previews, checks what the agent would pay, signs a bundle with the voucher key, and a failed post gives the budget back", async () => {
    const m = world();
    const base = `/listings/${h64("a")}/offers/${h64("d")}`;
    const terms = { circle: "x207-v013.testnet", epoch: 7, legs: [{ payer: AGENT, payee: SELLER, max_amount: "60000" }, { payer: SELLER, payee: AGENT, max_amount: "10000" }] };
    m.postAnswers[`${base}/preview`] = { kind: "bundle", epoch: 7, payment: null, bundle: { termsHash: termsHash(terms as never), terms, participants: [AGENT, SELLER] } };
    m.postAnswers[`${base}/accept`] = new Error("epoch closed");
    const { call } = await connect(m, cfg({ maxSpendSession: 100_000n }));
    const failed = await call("x207_accept_offer", { listing_hash: h64("a"), offer_hash: h64("d") });
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/epoch closed/);
    m.postAnswers[`${base}/accept`] = { match: { kind: "bundle" }, result: { kind: "bundle" } };
    const ok = await call("x207_accept_offer", { listing_hash: h64("a"), offer_hash: h64("d") });
    expect(ok.json).toMatchObject({ kind: "bundle", outgoing: "60000", session: { spent: "60000", remaining: "40000" } });
    const accepted = m.posts.at(-1)!.body;
    expect(accepted).toMatchObject({ account: AGENT, epoch: 7 });
    expect(accepted.signature).toMatch(/^ed25519:/);
    // the second acceptance of 60000 does not fit the 100000 of the session
    const again = await call("x207_accept_offer", { listing_hash: h64("a"), offer_hash: h64("d") });
    expect(again.text).toMatch(/would take this session to 120000, above X207_MAX_SPEND_SESSION \(100000\)/);
    const accepts = m.posts.filter((p) => p.path.endsWith("/accept"));
    expect(accepts).toHaveLength(2); // the failed one and the good one; the refused third was never posted
  });

  it("TC-SD-082-14 x207_accept_offer refuses a payment above the price cap and a bundle with a stranger in it", async () => {
    const m = world();
    const base = `/listings/${h64("a")}/offers/${h64("e")}`;
    m.postAnswers[`${base}/preview`] = { kind: "payment", epoch: 7, bundle: null, payment: { payer: AGENT, payee: SELLER, amount: "150000" } };
    const { call } = await connect(m, cfg({ maxSpendSession: 10_000_000n }));
    expect((await call("x207_accept_offer", { listing_hash: h64("a"), offer_hash: h64("e") })).text).toMatch(/what the agent would pay by accepting of 150000 is above X207_MAX_PRICE_PER_CALL/);
    m.postAnswers[`${base}/preview`] = { kind: "payment", epoch: 7, bundle: null, payment: { payer: AGENT, payee: "ghost.x207-v013.testnet", amount: "1000" } };
    expect((await call("x207_accept_offer", { listing_hash: h64("a"), offer_hash: h64("e") })).text).toMatch(/ghost.x207-v013.testnet is not an active member/);
    m.postAnswers[`${base}/preview`] = { kind: "bundle", epoch: 7, payment: null, bundle: { termsHash: h64("0"), terms: { circle: "x207-v013.testnet", epoch: 7, legs: [{ payer: AGENT, payee: SELLER, max_amount: "10" }, { payer: SELLER, payee: AGENT, max_amount: "5" }] }, participants: [AGENT, SELLER] } };
    expect((await call("x207_accept_offer", { listing_hash: h64("a"), offer_hash: h64("e") })).text).toMatch(/terms_hash of the backend does not match the bundle terms/);
    expect(m.posts.filter((p) => p.path.endsWith("/accept"))).toEqual([]);
  });

  it("TC-SD-082-15 x207_confirm_milestone signs a notice; confirming commits the milestone amount under the caps; a stranger's order is refused; seller actions need their fields", async () => {
    const m = world();
    const order = { buyer: AGENT, seller: SELLER, milestones: [{ index: 1, amount: "90000", status: "delivered" }, { index: 2, amount: "500000", status: "open" }] };
    m.backendAnswers[`/orders/${"o".repeat(64)}`] = order;
    m.postAnswers[`/orders/${"o".repeat(64)}/milestones/1`] = { status: "confirmed" };
    const { call } = await connect(m, cfg({ maxSpendSession: 200_000n }), { now: () => 1_800_000_000_000 });
    const ok = await call("x207_confirm_milestone", { order_hash: "o".repeat(64), index: 1, action: "confirmed" });
    expect(ok.json).toMatchObject({ action: "confirmed", committed: "90000", session: { spent: "90000" } });
    const body = m.posts[0]!.body;
    expect(body.notice).toEqual({ circle: "x207-v013.testnet", order_hash: "o".repeat(64), milestone: 1, actor: AGENT, action: "confirmed", at: 1_800_000_000, deliverable_hash: null, reason: null });
    expect(body.signature).toMatch(/^ed25519:/);
    expect((await call("x207_confirm_milestone", { order_hash: "o".repeat(64), index: 2, action: "confirmed" })).text).toMatch(/the milestone 2 of 500000 is above X207_MAX_PRICE_PER_CALL/);
    expect((await call("x207_confirm_milestone", { order_hash: "o".repeat(64), index: 1, action: "disputed" })).text).toMatch(/disputed needs a reason/);
    m.backendAnswers[`/orders/${"p".repeat(64)}`] = { ...order, buyer: "x.near", seller: "y.near" };
    expect((await call("x207_confirm_milestone", { order_hash: "p".repeat(64), index: 1, action: "confirmed" })).text).toMatch(/neither buyer nor seller/);
  });
});

describe("SD-082: the NEAR tools with a sender that records", () => {
  const near = (over: Partial<WriteConfig> = {}) => cfg({ nearKey: nearKey.secretKey, allowFullAccessKey: true, allowOutflows: true, ...over });
  const withKeyKind = (m: Mock, kind: "FullAccess" | "FC") => {
    const base = m.config.fetch!;
    m.config.fetch = (async (input: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.params?.request_type === "view_access_key") return Response.json({ jsonrpc: "2.0", id: "x207", result: { nonce: 1, permission: kind === "FullAccess" ? "FullAccess" : { FunctionCall: {} } } });
      return base(input, init);
    }) as typeof fetch;
  };

  it("TC-SD-082-16 x207_settle pays at most the amount due with ft_transfer_call and the settle message, and counts it against the session", async () => {
    const m = world({ net_position: { account_id: AGENT, role: "debtor", status: "due", amount: "80000", epoch: 3 } });
    withKeyKind(m, "FullAccess");
    const sent: ContractCall[] = [];
    const { call } = await connect(m, near({ maxSpendSession: 100_000n }), { send: async (c) => (sent.push(c), undefined) });
    expect((await call("x207_settle", { epoch: 3, amount: "80001" })).text).toMatch(/80001 is more than the 80000 due/);
    const ok = await call("x207_settle", { epoch: 3 });
    expect(ok.json).toMatchObject({ paid: "80000", due: "80000", session: { spent: "80000", remaining: "20000" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ receiverId: "usdt.x207-deployer.testnet", methodName: "ft_transfer_call", deposit: 1n, args: { receiver_id: "x207-v013.testnet", amount: "80000", msg: JSON.stringify({ action: "settle", epoch: 3 }) } });
    expect((await call("x207_settle", { epoch: 3 })).text).toMatch(/would take this session to 160000, above X207_MAX_SPEND_SESSION/);
    expect(sent).toHaveLength(1);
  });

  it("TC-SD-082-17 x207_settle and x207_claim refuse a position that is not theirs; x207_claim sends claim with 1 yocto and the minimum gas to the agent's own destination", async () => {
    const m = world({ net_position: { account_id: AGENT, role: "creditor", status: "claimable", amount: "5000", epoch: 4 } });
    withKeyKind(m, "FullAccess");
    const sent: ContractCall[] = [];
    const { call } = await connect(m, near(), { send: async (c) => (sent.push(c), undefined) });
    expect((await call("x207_settle", { epoch: 4 })).text).toMatch(/owes nothing for epoch 4 \(creditor, claimable\)/);
    const ok = await call("x207_claim", { epoch: 4, destination: "intents" });
    expect(ok.json).toMatchObject({ epoch: 4, claimable: "5000", destination: "intents" });
    expect(sent).toEqual([{ receiverId: "x207-v013.testnet", methodName: "claim", args: { epoch: 4, destination: "intents" }, deposit: 1n, gas: 100_000_000_000_000n }]);
    m.viewAnswers.net_position = null;
    expect((await call("x207_claim", { epoch: 5 })).text).toMatch(/nothing to claim for epoch 5 \(no position\)/);
  });

  it("TC-SD-082-18 x207_join sends join and the stake once the guards pass, and the stake counts against the session", async () => {
    const m = world();
    withKeyKind(m, "FullAccess");
    let joined = false;
    m.viewAnswers.member = (a: any) => (a.account_id === AGENT ? (joined ? { account_id: AGENT, status: "active", stake: "50000", pubkey_voucher: voucherPublicKey(voucher.secretKey) } : null) : { account_id: a.account_id, status: "active" });
    const sent: ContractCall[] = [];
    const { call } = await connect(m, near({ maxSpendSession: 60_000n }), { send: async (c) => (sent.push(c), c.methodName === "ft_transfer_call" && (joined = true), undefined) });
    const r = await call("x207_join", { terms_hash: h64("b"), stake_amount: "50000" });
    expect(r.text.slice(0, 400)).not.toMatch(/^x207_join failed|refused/);
    expect(r.isError).toBe(false);
    expect(sent.map((c) => c.methodName)).toEqual(["join", "ft_transfer_call"]);
    expect(sent[0]).toMatchObject({ receiverId: "x207-v013.testnet", args: { circle_id: "agents-main", pubkey_voucher: voucherPublicKey(voucher.secretKey), terms_hash: h64("b") } });
    expect(sent[0]!.deposit).toBe(350_000_000_000_000_000_000_000n);
    expect(sent[1]).toMatchObject({ receiverId: "usdt.x207-deployer.testnet", deposit: 1n, args: { amount: "50000" } });
    expect(r.json).toMatchObject({ account: AGENT, voucherPublicKey: voucherPublicKey(voucher.secretKey), session: { spent: "50000", remaining: "10000" } });
  });

  it("TC-SD-082-19 no result and no error of any tool ever holds a key, even when the chain call throws one", async () => {
    const m = world({ net_position: { account_id: AGENT, role: "debtor", status: "due", amount: "10", epoch: 3 } });
    withKeyKind(m, "FullAccess");
    const { call } = await connect(m, near(), { send: async () => { throw new Error(`rpc rejected the key ${nearKey.secretKey} and ${voucher.secretKey}`); } });
    const r = await call("x207_settle", { epoch: 3 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("[key]");
    for (const secret of [nearKey.secretKey, voucher.secretKey, nearKey.secretKey.slice(8), voucher.secretKey.slice(8)]) expect(r.text).not.toContain(secret);
  });
});
