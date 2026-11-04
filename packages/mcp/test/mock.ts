// A fetch that plays the NEAR RPC (call_function views of the circle) and the x207 read API, for the tests of the MCP server (SD-081).
import type { McpConfig } from "../src/config.js";

export const RPC = "https://rpc.mock.test";
export const BACKEND = "https://api.mock.test";
export const CONTRACT = "x207-v013.testnet";

export interface Mock {
  config: McpConfig;
  /** Views called, in order: `[method, args]`. */
  views: Array<[string, any]>;
  /** Read API requests: `METHOD path?query`. */
  requests: string[];
  /** View answers by method; a function gets the args; `Error` makes the contract panic. */
  viewAnswers: Record<string, unknown>;
  /** Read API answers by `path` (with the query); a number is an HTTP status for an empty error body. */
  backendAnswers: Record<string, unknown>;
}

export function mock(over: Partial<McpConfig> = {}): Mock {
  const m: Mock = {
    views: [], requests: [],
    viewAnswers: {
      get_circle: { circle_id: "agents-main", owner: "x207v8.sputnikv2.testnet", member_count: 3 },
      get_params: { epoch_length: 600, payment_window: 900, proposal_window: 60 },
      list_members: [{ account_id: "alice.x207-v013.testnet", status: "active" }],
      member: (a: any) => (a.account_id === "alice.x207-v013.testnet" ? { account_id: a.account_id, status: "active", stake: "2000000" } : null),
      limit: "1600000",
      get_epoch: (a: any) => ({ epoch: a.epoch ?? 7, phase: "payment_window", cutoff_at: "1" }),
      list_positions: [{ account_id: "alice.x207-v013.testnet", net: "-100" }],
      simulate_clearing: (a: any) => ({ ok: a.edges.length > 0, cleared_total: a.edges.reduce((s: number, e: any) => s + Number(e.cleared), 0).toString() }),
    },
    backendAnswers: {},
    config: {
      circleContract: CONTRACT, circleId: "agents-main", rpcUrls: [RPC], backendUrl: BACKEND, timeoutMs: 2000,
      fetch: (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith(RPC)) {
          const body = JSON.parse(String(init?.body));
          const method = body.params.method_name as string;
          const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString("utf8"));
          m.views.push([method, args]);
          let answer = m.viewAnswers[method];
          if (answer === undefined) return Response.json({ jsonrpc: "2.0", id: "x207", result: { result: [], error: `MethodNotFound ${method}` } });
          if (typeof answer === "function") answer = (answer as (a: unknown) => unknown)(args);
          return Response.json({ jsonrpc: "2.0", id: "x207", result: { result: [...Buffer.from(JSON.stringify(answer))] } });
        }
        if (url.startsWith(BACKEND)) {
          const u = new URL(url);
          const key = `${u.pathname.replace("/x207/circles/agents-main", "")}${u.search}`;
          m.requests.push(`${init?.method ?? "GET"} ${key}`);
          const a = m.backendAnswers[key];
          if (a === undefined) return Response.json({ error: { code: "not_found", message: `no ${key}` } }, { status: 404 });
          if (typeof a === "number") return Response.json({ error: { code: "boom", message: "failed" } }, { status: a });
          return Response.json(a);
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch,
      ...over,
    },
  };
  return m;
}
