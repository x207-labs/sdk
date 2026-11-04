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
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>, ctx: ToolContext) => Promise<unknown>;
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
      "Overview of one x207 mutual-credit circle: its record and rules from the contract (get_circle, get_params) and its members (read API GET /members, or the contract view list_members when no read API is configured). Credit amounts are strings in the smallest unit (6 decimals).",
    access: "read",
    inputSchema: { members_limit: LIMIT(200, 20), members_status: z.string().min(1).max(32).optional().describe("Only members with this status, e.g. active (read API only).") },
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
      "One member of the circle: status, stake, position and credit limit. Uses the read API (GET /members/{account} and /members/{account}/limits), or the contract views member and limit when no read API is configured.",
    access: "read",
    inputSchema: { account: ACCOUNT },
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
      "The state and the result of one clearing epoch: the contract record (get_epoch) and, from the read API, the epoch summary (GET /epochs/{n}), its metrics (cleared ratio, GET /epochs/{n}/metrics) and its settlements (GET /epochs/{n}/settlements). Without epoch, the current epoch.",
    access: "read",
    inputSchema: { epoch: EPOCH.optional().describe("Epoch number; the current epoch when left out."), settlements_limit: LIMIT(200, 20) },
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
      "Asks the contract (view simulate_clearing) whether a proposed clearing for an epoch is valid and what it would clear. Each edge nets a debt: debtor owes creditor, `cleared` is the amount to cancel (decimal string, smallest unit). Changes nothing.",
    access: "read",
    inputSchema: {
      epoch: EPOCH,
      edges: z.array(z.object({ debtor: ACCOUNT, creditor: ACCOUNT, cleared: z.string().regex(/^\d{1,38}$/, "a decimal integer string") })).min(1).max(300),
    },
    handler: async (args, ctx) => ({ epoch: args.epoch, edgeCount: (args.edges as unknown[]).length, result: await ctx.view("simulate_clearing", { epoch: args.epoch, edges: args.edges }) }),
  },
  {
    name: "x207_search_listings",
    title: "Search marketplace listings",
    description:
      "Listings of the circle's marketplace (read API GET /listings): what an account offers and what it wants. Filters are optional; `status` defaults to open. Use `cursor` from `nextCursor` for the next page.",
    access: "read",
    inputSchema: {
      status: z.enum(["open", "expired", "cancelled", "filled", "all"]).optional().describe("Default open."),
      account: ACCOUNT.optional().describe("Only listings of this account."),
      offerType: z.string().min(3).max(129).optional().describe("Asset type offered, e.g. service:summary."),
      wantType: z.string().min(3).max(129).optional(),
      offerClass: z.enum(["A", "B", "C", "D", "X"]).optional(),
      wantClass: z.enum(["A", "B", "C", "D", "X"]).optional(),
      limit: LIMIT(200, 20),
      cursor: z.string().min(1).max(512).optional(),
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
      "A service order of the circle's marketplace: parties, budget, milestones and status (read API GET /orders/{hash}). Without a hash, lists orders; filter by `party` and `status`.",
    access: "read",
    inputSchema: {
      hash: HASH.optional().describe("The order hash. Leave out to list orders."),
      party: ACCOUNT.optional().describe("Only orders where this account is buyer or seller (listing only)."),
      status: z.string().min(1).max(32).optional().describe("Only orders with this status (listing only)."),
      limit: LIMIT(200, 20),
      cursor: z.string().min(1).max(512).optional(),
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
