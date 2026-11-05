// The read tools of the x207 MCP server (SD-081). Tool names, contract view methods and read API endpoints are the ones of the spec (Pusaka analysis, table 6.3); nothing here signs or sends.
//
//   x207_circle_overview    get_circle, get_params, GET /members                     (members from the contract view list_members when there is no read API)
//   x207_member_inspect     GET /members/{account}, GET /members/{account}/limits     (the views member and limit when there is no read API)
//   x207_epoch_report       get_epoch, GET /epochs/{n} (`summary`), /epochs/{n}/metrics, /epochs/{n}/settlements   (list_positions when there is no read API)
//   x207_simulate_clearing  simulate_clearing
//   x207_search_listings    GET /listings
//   x207_order_status       GET /orders/{hash}  (GET /orders without a hash)
import type { CircleViewFn } from "@x207/core";
import { z } from "zod";
import { BackendError, seg, type BackendGet } from "./backend.js";
import type { WriteRuntime } from "./write-tools.js";

export interface ToolContext {
  view: CircleViewFn;
  /** `null` when no read API is configured. */
  backend: BackendGet | null;
  circleContract: string;
  circleId: string;
  /** Present only on stdio with X207_MCP_WRITE=1 (SD-082). */
  write?: WriteRuntime;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** `read` tools run on every transport; a `write` tool would run on stdio only (SD-082). */
  access: "read" | "write";
  inputSchema: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<unknown>;
}

/** What a tool says when it cannot do its job: shown to the model as the text of an error result. */
export class ToolError extends Error {}

const ACCOUNT = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, "a NEAR account id, e.g. alice.x207-v013.testnet");
const HASH = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "the hash of the object, as the read API gives it");
const LIMIT = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt).describe(`How many items, 1 to ${max} (default ${dflt}).`);
const EPOCH = z.number().int().min(0).max(4_294_967_295);

const needBackend = (ctx: ToolContext, what: string): BackendGet => {
  if (ctx.backend === null) throw new ToolError(`${what} needs the x207 read API: set X207_BACKEND_URL (the server answers from the contract only without it).`);
  return ctx.backend;
};

/** Runs the pieces of one answer side by side: the first failure of a piece that is not optional rejects, an optional one becomes a warning. */
async function gather<T extends Record<string, () => Promise<unknown>>>(required: T, optional: Record<string, () => Promise<unknown>> = {}): Promise<{ data: Record<string, unknown>; warnings: string[] }> {
  const keys = [...Object.keys(required), ...Object.keys(optional)];
  const settled = await Promise.allSettled([...Object.values(required), ...Object.values(optional)].map((f) => f()));
  const data: Record<string, unknown> = {};
  const warnings: string[] = [];
  settled.forEach((r, i) => {
    const key = keys[i] as string;
    if (r.status === "fulfilled") data[key] = r.value;
    else if (key in required) throw r.reason;
    else warnings.push(`${key}: ${(r.reason as Error).message}`);
  });
  return { data, warnings };
}

export const READ_TOOLS: ToolDef[] = [
  {
    name: "x207_circle_overview",
    title: "x207 circle overview",
    description:
      "Start here: the circle itself, i.e. its record and rules (get_circle, get_params) plus a page of its members (read API GET /members, or the contract view list_members when no read API is set). Use x207_member_inspect for one member in detail and x207_epoch_report for one epoch. Returns {contract, circleId, circle, params, members, membersSource, warnings}; amounts are strings in the smallest unit (6 decimals). If the members part fails it shows up in `warnings` and the rest is still returned; an unreachable contract RPC is an error.",
    access: "read",
    inputSchema: { members_limit: LIMIT(200, 20).describe("Size of the members page, 1 to 200 (default 20); the circle may have more members than this."), members_status: z.string().min(1).max(32).optional().describe("Keep only members with this status, e.g. active, suspended or exiting. Read API only; ignored on the contract fallback.") },
    handler: async (args, ctx) => {
      const { data, warnings } = await gather(
        { circle: () => ctx.view("get_circle", {}), params: () => ctx.view("get_params", {}) },
        {
          members: () =>
            ctx.backend !== null
              ? ctx.backend("/members", { limit: args.members_limit as number, status: args.members_status as string | undefined })
              : ctx.view("list_members", { from_index: 0, limit: args.members_limit }),
        },
      );
      return { contract: ctx.circleContract, circleId: ctx.circleId, ...data, membersSource: ctx.backend !== null ? "read API" : "contract view list_members", warnings };
    },
  },
  {
    name: "x207_member_inspect",
    title: "Inspect a circle member",
    description:
      "One member of the circle: status, stake, outstanding debt and credit limit (read API GET /members/{account} and /limits, or the contract views member and limit when no read API is set). Use it after x207_circle_overview has shown the account ids, or before paying a member; for epoch-level amounts use x207_epoch_report. Returns {account, member, limits|limit, source, warnings}. An account that is not a member is an error (\"not a member\" or a 404 from the read API); a failed limits lookup is only a warning.",
    access: "read",
    inputSchema: { account: ACCOUNT.describe("The member to look up: its NEAR account id, or for an EVM agent its lower-case 0x address.") },
    handler: async (args, ctx) => {
      const account = args.account as string;
      if (ctx.backend !== null) {
        const b = ctx.backend;
        const { data, warnings } = await gather({ member: () => b(`/members/${seg(account)}`) }, { limits: () => b(`/members/${seg(account)}/limits`) });
        return { account, ...data, source: "read API", warnings };
      }
      const { data, warnings } = await gather({ member: () => ctx.view("member", { account_id: account }) }, { limit: () => ctx.view("limit", { account_id: account }) });
      if (data.member === null) throw new ToolError(`${account} is not a member of ${ctx.circleContract}`);
      return { account, ...data, source: "contract views member and limit", warnings };
    },
  },
  {
    name: "x207_epoch_report",
    title: "Epoch report (report 207)",
    description:
      "One epoch of the circle: its phase and deadlines from the contract (get_epoch), and from the read API the summary, the metrics (cleared ratio: the share of debt that netting removed, so only the net cash moves) and the settlements, i.e. who owes whom what in cash. Use it after an epoch closed; use x207_simulate_clearing to test a proposal before it is submitted. Returns {epoch, contract, summary, metrics, settlements, source, warnings}. An epoch that does not exist is an error; if the read API is down the contract record is still returned, with the failures in `warnings`.",
    access: "read",
    inputSchema: { epoch: EPOCH.optional().describe("Epoch number, 0 or more. Leave out for the current epoch, which is still open and has no settlements yet."), settlements_limit: LIMIT(200, 20).describe("How many settlement rows to return, 1 to 200 (default 20). A busy epoch has more; raise it to see them all.") },
    handler: async (args, ctx) => {
      const record = (await ctx.view("get_epoch", args.epoch === undefined ? {} : { epoch: args.epoch })) as { epoch?: unknown } | null;
      if (record === null || typeof record.epoch !== "number") throw new ToolError(`epoch ${args.epoch ?? "(current)"} is not on the contract`);
      const n = record.epoch;
      if (ctx.backend === null) {
        const { data, warnings } = await gather({}, { positions: () => ctx.view("list_positions", { epoch: n, from_index: 0, limit: args.settlements_limit }) });
        return { epoch: n, contract: record, ...data, source: "contract views get_epoch and list_positions", warnings };
      }
      const b = ctx.backend;
      const { data, warnings } = await gather(
        {},
        { summary: () => b(`/epochs/${seg(n)}`), metrics: () => b(`/epochs/${seg(n)}/metrics`), settlements: () => b(`/epochs/${seg(n)}/settlements`, { limit: args.settlements_limit as number }) },
      );
      return { epoch: n, contract: record, ...data, source: "contract view get_epoch and read API", warnings };
    },
  },
  {
    name: "x207_simulate_clearing",
    title: "Simulate a clearing proposal",
    description:
      "Dry run of a netting proposal: asks the contract (view simulate_clearing) whether the edges would be accepted for an epoch and how much debt they would cancel. Use it to check a proposal before a solver submits it; to see what a finished epoch actually netted use x207_epoch_report. Returns {epoch, edgeCount, result}. An invalid proposal (unknown member, amount above the debt, wrong epoch phase) comes back as an error text from the contract. Read-only, sends nothing.",
    access: "read",
    inputSchema: {
      epoch: EPOCH.describe("The epoch the proposal is for; it must be one that can still accept a clearing."),
      edges: z.array(z.object({ debtor: ACCOUNT.describe("Member that owes."), creditor: ACCOUNT.describe("Member that is owed."), cleared: z.string().regex(/^\d{1,38}$/, "a decimal integer string").describe("Debt to cancel on this edge, a decimal string in the smallest unit (6 decimals), at most what the debtor owes.") })).min(1).max(300).describe("1 to 300 debt edges; a cycle of edges nets to zero cash."),
    },
    handler: async (args, ctx) => ({ epoch: args.epoch, edgeCount: (args.edges as unknown[]).length, result: await ctx.view("simulate_clearing", { epoch: args.epoch, edges: args.edges }) }),
  },
  {
    name: "x207_search_listings",
    title: "Search marketplace listings",
    description:
      "Find offers on the circle's marketplace (read API GET /listings): what an account offers and what it wants. Use it to discover who sells a service; for an order that already exists use x207_order_status. Returns {items, nextCursor}; pass nextCursor as `cursor` for the next page. No match gives an empty list, not an error. Needs the read API (X207_BACKEND_URL) and fails with a clear message without it.",
    access: "read",
    inputSchema: {
      status: z.enum(["open", "expired", "cancelled", "filled", "all"]).optional().describe("Listing state to match; open when left out, all for every state."),
      account: ACCOUNT.optional().describe("Only listings of this account."),
      offerType: z.string().min(3).max(129).optional().describe("Asset type the lister offers, e.g. service:summary; exact match."),
      wantType: z.string().min(3).max(129).optional().describe("Asset type the lister wants in return, same form as offerType."),
      offerClass: z.enum(["A", "B", "C", "D", "X"]).optional().describe("Settlement class of the offered asset (A to D, X for other); keep only listings of this class."),
      wantClass: z.enum(["A", "B", "C", "D", "X"]).optional().describe("Same, for the wanted asset."),
      limit: LIMIT(200, 20).describe("Page size, 1 to 200 (default 20)."),
      cursor: z.string().min(1).max(512).optional().describe("The nextCursor of the previous page; leave out for the first page."),
    },
    handler: async (args, ctx) => {
      const b = needBackend(ctx, "x207_search_listings");
      const { status, account, offerType, wantType, offerClass, wantClass, limit, cursor } = args as Record<string, string | number | undefined>;
      return b("/listings", { status, account, offerType, wantType, offerClass, wantClass, limit, cursor });
    },
  },
  {
    name: "x207_order_status",
    title: "Order status",
    description:
      "Orders of the circle's marketplace (read API GET /orders). With a hash: one order with its parties, budget, milestones and status. Without a hash: a page of orders, filtered by party and status. Use x207_search_listings to find offers before an order exists. An unknown hash is an error (\"no order ... in circle\"); an empty list is a normal result. Needs the read API (X207_BACKEND_URL).",
    access: "read",
    inputSchema: {
      hash: HASH.optional().describe("The order hash. Leave out to list orders."),
      party: ACCOUNT.optional().describe("Only orders where this account is buyer or seller (listing only)."),
      status: z.string().min(1).max(32).optional().describe("Only orders in this state, e.g. open, delivered or disputed (listing only)."),
      limit: LIMIT(200, 20).describe("Page size, 1 to 200 (default 20); listing only."),
      cursor: z.string().min(1).max(512).optional().describe("The nextCursor of the previous page; listing only."),
    },
    handler: async (args, ctx) => {
      const b = needBackend(ctx, "x207_order_status");
      if (args.hash !== undefined) {
        try {
          return await b(`/orders/${seg(args.hash as string)}`);
        } catch (error) {
          if (error instanceof BackendError && error.status === 404) throw new ToolError(`no order ${args.hash} in circle ${ctx.circleId}`);
          throw error;
        }
      }
      return b("/orders", { party: args.party as string | undefined, status: args.status as string | undefined, limit: args.limit as number, cursor: args.cursor as string | undefined });
    },
  },
];
