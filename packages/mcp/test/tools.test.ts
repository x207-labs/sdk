import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createX207McpServer, toolsFor } from "../src/server.js";
import { BACKEND, mock, type Mock } from "./mock.js";

const NAMES = ["x207_circle_overview", "x207_member_inspect", "x207_epoch_report", "x207_simulate_clearing", "x207_search_listings", "x207_order_status"];

async function connect(m: Mock, transport: "stdio" | "http" = "stdio") {
  const server = createX207McpServer(m.config, transport);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    const text = r.content[0]!.text;
    let json: any = null;
    try {
      json = r.isError ? null : JSON.parse(text);
    } catch {
      // a cut answer is not JSON any more
    }
    return { isError: r.isError === true, text, json };
  };
  return { client, call };
}

describe("SD-081: the six read tools of @x207/mcp, mock RPC and read API", () => {
  it("TC-SD-081-01 the server lists exactly the six tools of table 6.3, all marked read-only", async () => {
    const { client } = await connect(mock());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.description!.length).toBeGreaterThan(40);
    }
    expect(toolsFor("http").map((t) => t.name).sort()).toEqual([...NAMES].sort());
  });

  it("TC-SD-081-02 x207_circle_overview reads get_circle, get_params and GET /members, and says where the members came from", async () => {
    const m = mock();
    m.backendAnswers["/members?limit=5"] = { items: [{ account: "alice.x207-v013.testnet", status: "active" }], nextCursor: null };
    const { call } = await connect(m);
    const r = await call("x207_circle_overview", { members_limit: 5 });
    expect(r.json).toMatchObject({ contract: "x207-v013.testnet", circleId: "agents-main", circle: { member_count: 3 }, params: { epoch_length: 600 }, members: { items: [{ account: "alice.x207-v013.testnet" }] }, membersSource: "read API", warnings: [] });
    expect(m.views.map(([name]) => name).sort()).toEqual(["get_circle", "get_params"]);
    expect(m.requests).toEqual(["GET /members?limit=5"]);
  });

  it("TC-SD-081-03 without a read API the overview uses the view list_members; a broken read API is a warning, not a failure", async () => {
    const m = mock({ backendUrl: null });
    const none = await (await connect(m)).call("x207_circle_overview");
    expect(none.json).toMatchObject({ members: [{ status: "active" }], membersSource: "contract view list_members", warnings: [] });
    expect(m.views.find(([n]) => n === "list_members")![1]).toEqual({ from_index: 0, limit: 20 });
    const down = mock();
    down.backendAnswers["/members?limit=20"] = 503;
    const r = await (await connect(down)).call("x207_circle_overview");
    expect(r.isError).toBe(false);
    expect(r.json.circle.circle_id).toBe("agents-main");
    expect(r.json.warnings[0]).toMatch(/members: read API \/members answered 503: boom: failed/);
  });

  it("TC-SD-081-04 x207_member_inspect: read API member and limits; contract views member and limit without it; a stranger is a tool error", async () => {
    const m = mock();
    m.backendAnswers["/members/alice.x207-v013.testnet"] = { account: "alice.x207-v013.testnet", status: "active" };
    m.backendAnswers["/members/alice.x207-v013.testnet/limits"] = { limit: "1600000", headroom: "1000000" };
    const a = await (await connect(m)).call("x207_member_inspect", { account: "alice.x207-v013.testnet" });
    expect(a.json).toMatchObject({ source: "read API", member: { status: "active" }, limits: { headroom: "1000000" } });
    const v = mock({ backendUrl: null });
    const b = await (await connect(v)).call("x207_member_inspect", { account: "alice.x207-v013.testnet" });
    expect(b.json).toMatchObject({ source: "contract views member and limit", member: { stake: "2000000" }, limit: "1600000" });
    expect(v.views).toEqual([["member", { account_id: "alice.x207-v013.testnet" }], ["limit", { account_id: "alice.x207-v013.testnet" }]]);
    const c = await (await connect(v)).call("x207_member_inspect", { account: "mallory.x207-v013.testnet" });
    expect(c).toMatchObject({ isError: true, text: "mallory.x207-v013.testnet is not a member of x207-v013.testnet" });
  });

  it("TC-SD-081-05 x207_epoch_report: the contract record, then epoch, metrics and settlements of that epoch; without epoch it is the current one", async () => {
    const m = mock();
    m.backendAnswers["/epochs/7"] = { epoch: 7, phase: "payment_window", participantCount: 4 };
    m.backendAnswers["/epochs/7/metrics"] = { clearedRatio: 0.62 };
    m.backendAnswers["/epochs/7/settlements?limit=20"] = { items: [] };
    const r = await (await connect(m)).call("x207_epoch_report");
    expect(m.views[0]).toEqual(["get_epoch", {}]);
    expect(r.json).toMatchObject({ epoch: 7, contract: { phase: "payment_window" }, summary: { participantCount: 4 }, metrics: { clearedRatio: 0.62 }, settlements: { items: [] }, warnings: [] });
    const two = await (await connect(m)).call("x207_epoch_report", { epoch: 7 });
    expect(m.views.at(-1)).toEqual(["get_epoch", { epoch: 7 }]);
    expect(two.json.epoch).toBe(7);
    const none = mock({ backendUrl: null });
    const c = await (await connect(none)).call("x207_epoch_report", { epoch: 3 });
    expect(c.json).toMatchObject({ epoch: 3, positions: [{ net: "-100" }], source: "contract views get_epoch and list_positions" });
    const gone = mock();
    gone.viewAnswers.get_epoch = null;
    expect((await (await connect(gone)).call("x207_epoch_report", { epoch: 99 })).text).toMatch(/epoch 99 is not on the contract/);
  });

  it("TC-SD-081-06 x207_simulate_clearing sends the epoch and the edges to the view simulate_clearing and changes nothing", async () => {
    const m = mock();
    const edges = [{ debtor: "a.x207-v013.testnet", creditor: "b.x207-v013.testnet", cleared: "300" }, { debtor: "b.x207-v013.testnet", creditor: "c.x207-v013.testnet", cleared: "300" }];
    const r = await (await connect(m)).call("x207_simulate_clearing", { epoch: 7, edges });
    expect(m.views).toEqual([["simulate_clearing", { epoch: 7, edges }]]);
    expect(r.json).toEqual({ epoch: 7, edgeCount: 2, result: { ok: true, cleared_total: "600" } });
    expect(m.requests).toEqual([]);
  });

  it("TC-SD-081-07 inputs are checked before any call: bad accounts, amounts that are not integers, no edges, too many edges", async () => {
    const m = mock();
    const { client } = await connect(m);
    const bad = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }))) as { isError?: boolean };
      return r.isError === true;
    };
    const e = { debtor: "a.near", creditor: "b.near", cleared: "1" };
    expect(await bad("x207_simulate_clearing", { epoch: 1, edges: [{ ...e, cleared: "-5" }] })).toBe(true);
    expect(await bad("x207_simulate_clearing", { epoch: 1, edges: [{ ...e, cleared: "1.5" }] })).toBe(true);
    expect(await bad("x207_simulate_clearing", { epoch: 1, edges: [] })).toBe(true);
    expect(await bad("x207_simulate_clearing", { epoch: 1, edges: Array(301).fill(e) })).toBe(true);
    expect(await bad("x207_simulate_clearing", { epoch: 1, edges: [{ ...e, debtor: "A B" }] })).toBe(true);
    expect(await bad("x207_member_inspect", { account: "../etc" })).toBe(true);
    expect(await bad("x207_order_status", { hash: "a/b" })).toBe(true);
    expect(await bad("x207_search_listings", { limit: 5000 })).toBe(true);
    expect(m.views).toEqual([]);
    expect(m.requests).toEqual([]);
  });

  it("TC-SD-081-08 x207_search_listings passes the filters to GET /listings and returns the page with its cursor", async () => {
    const m = mock();
    m.backendAnswers["/listings?account=alice.x207-v013.testnet&offerType=service%3Asummary&limit=2"] = { items: [{ listingHash: "h1" }], nextCursor: "abc" };
    const r = await (await connect(m)).call("x207_search_listings", { account: "alice.x207-v013.testnet", offerType: "service:summary", limit: 2 });
    expect(r.json).toEqual({ items: [{ listingHash: "h1" }], nextCursor: "abc" });
    expect(m.requests).toEqual(["GET /listings?account=alice.x207-v013.testnet&offerType=service%3Asummary&limit=2"]);
  });

  it("TC-SD-081-09 x207_order_status: one order by hash, a list without a hash, and a clear error for an unknown order", async () => {
    const m = mock();
    const hash = "a".repeat(64);
    m.backendAnswers[`/orders/${hash}`] = { orderHash: hash, status: "in_progress", milestones: [{ index: 0, status: "paid" }] };
    m.backendAnswers["/orders?party=alice.x207-v013.testnet&status=in_progress&limit=20"] = { items: [], nextCursor: null };
    const { call } = await connect(m);
    expect((await call("x207_order_status", { hash })).json).toMatchObject({ status: "in_progress", milestones: [{ status: "paid" }] });
    expect((await call("x207_order_status", { party: "alice.x207-v013.testnet", status: "in_progress" })).json).toEqual({ items: [], nextCursor: null });
    const missing = await call("x207_order_status", { hash: "b".repeat(64) });
    expect(missing).toMatchObject({ isError: true, text: `no order ${"b".repeat(64)} in circle agents-main` });
  });

  it("TC-SD-081-10 the tools that need the read API say so when none is configured, and nothing was sent", async () => {
    const m = mock({ backendUrl: null });
    const { call } = await connect(m);
    for (const [name, args] of [["x207_search_listings", {}], ["x207_order_status", { hash: "c".repeat(64) }]] as const) {
      const r = await call(name, args);
      expect(r).toMatchObject({ isError: true });
      expect(r.text).toMatch(/needs the x207 read API: set X207_BACKEND_URL/);
    }
    expect(m.requests).toEqual([]);
  });

  it("TC-SD-081-11 a failing contract view is a tool error that names the tool; a failing RPC too; the server keeps working", async () => {
    const m = mock();
    m.viewAnswers.get_params = undefined;
    const { call } = await connect(m);
    const r = await call("x207_circle_overview");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/x207_circle_overview failed: view get_params failed: MethodNotFound get_params/);
    expect((await call("x207_simulate_clearing", { epoch: 1, edges: [{ debtor: "a.near", creditor: "b.near", cleared: "1" }] })).isError).toBe(false);
    const down = mock({ fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    const d = await (await connect(down)).call("x207_epoch_report", { epoch: 1 });
    expect(d.text).toMatch(/x207_epoch_report failed: all RPC endpoints failed \(https:\/\/rpc\.mock\.test: ECONNREFUSED\)/);
  });

  it("TC-SD-081-12 a long answer is cut at the limit and says so", async () => {
    const m = mock();
    m.viewAnswers.list_members = Array.from({ length: 5000 }, (_, i) => ({ account_id: `member${i}.x207-v013.testnet`, status: "active", note: "x".repeat(20) }));
    const r = await (await connect({ ...m, config: { ...m.config, backendUrl: null } } as Mock)).call("x207_circle_overview", { members_limit: 200 });
    const text = r.text;
    expect(text.length).toBeLessThanOrEqual(100_000 + 200);
    expect(text).toMatch(/… cut at 100000 characters/);
    void BACKEND;
  });

  it("TC-SD-081-21 (security review batch 8) a read API that answers more than the limit is a tool error, not a read of the whole answer", async () => {
    const m = mock();
    const huge = { items: Array.from({ length: 200_000 }, (_, i) => ({ account: `member${i}.x207-v013.testnet`, pad: "x".repeat(20) })) };
    m.backendAnswers["/listings?limit=20"] = huge;
    const r = await (await connect(m)).call("x207_search_listings");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/answered more than 4194304 bytes/);
  });
});
