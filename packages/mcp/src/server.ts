import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCircleViewFn } from "@x207/core";
import { createBackendGet, createBackendPost } from "./backend.js";
import type { McpConfig } from "./config.js";
import { READ_TOOLS, ToolError, type ToolContext, type ToolDef } from "./tools.js";
import { availableWriteTools, createWriteRuntime } from "./write-tools.js";
import { scrub, type WriteConfig } from "./write-config.js";
import type { ContractCall } from "@x207/core";

export type Transport = "stdio" | "http";

/** The version of the package, read from its package.json (one place, so the server info cannot say another version than the one that was published). `../package.json` is the package root from `src/` and from `dist/`. */
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** Longest text of one tool result. A longer answer is cut and says so, so one call cannot fill the context of a model. */
export const MAX_RESULT_CHARS = 100_000;

const text = (value: unknown): string => {
  const out = JSON.stringify(value, null, 2) ?? "null";
  return out.length <= MAX_RESULT_CHARS ? out : `${out.slice(0, MAX_RESULT_CHARS)}\n… cut at ${MAX_RESULT_CHARS} characters; ask for fewer items or use the cursor`;
};

/** The tools that run on a transport: HTTP only ever gets the read tools. */
export const toolsFor = (transport: Transport): ToolDef[] => READ_TOOLS.filter((t) => transport === "stdio" || t.access === "read");

export function contextFrom(config: McpConfig): ToolContext {
  const view = createCircleViewFn({ circleContract: config.circleContract, rpcUrls: config.rpcUrls, timeoutMs: config.timeoutMs, ...(config.fetch ? { fetch: config.fetch } : {}) });
  const backend = config.backendUrl === null ? null : createBackendGet({ baseUrl: config.backendUrl, circleId: config.circleId, timeoutMs: config.timeoutMs, ...(config.fetch ? { fetch: config.fetch } : {}) });
  return { view, backend, circleContract: config.circleContract, circleId: config.circleId };
}

export interface ServerOptions {
  version?: string;
  /** The write configuration (SD-082). Honoured on stdio only: on HTTP it is ignored and the server stays read-only. */
  write?: WriteConfig | null;
  /** Replaces the NEAR sender of the write tools (tests). */
  send?: (call: ContractCall) => Promise<unknown>;
  now?: () => number;
  /** Replaces the DNS lookup of the SSRF guard (tests). */
  resolve?: (host: string) => Promise<string[]>;
}

/** One MCP server with the tools of `transport`. The read tools read views of the contract and the read API and send nothing. The write tools exist only on stdio with a write configuration. */
export function createX207McpServer(config: McpConfig, transport: Transport, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "x207", version: options.version ?? PACKAGE_VERSION });
  const ctx = contextFrom(config);
  const writeCfg = transport === "stdio" ? (options.write ?? null) : null;
  let tools: ToolDef[] = toolsFor(transport);
  if (writeCfg !== null) {
    const post = config.backendUrl === null ? null : createBackendPost({ baseUrl: config.backendUrl, circleId: config.circleId, timeoutMs: config.timeoutMs, ...(config.fetch ? { fetch: config.fetch } : {}) });
    ctx.write = createWriteRuntime(config, writeCfg, ctx.view, { post, ...(options.send ? { send: options.send } : {}), ...(options.now ? { now: options.now } : {}), ...(options.resolve ? { resolve: options.resolve } : {}) });
    tools = [...tools, ...availableWriteTools(ctx.write, ctx.backend !== null)];
  }
  for (const tool of tools) {
    // `as never` on inputSchema: this package builds its schemas with zod 4, and which copy of zod the MCP SDK resolves depends on the install (the sdk repo alone hoists zod 4, the umbrella
    // workspace hoists zod 3.25 to the root and the SDK resolves that one), so the two declarations of the schema type differ for tsc while the SDK reads either at run time (SD-084).
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema as never, annotations: { readOnlyHint: tool.access === "read", destructiveHint: tool.access === "write", idempotentHint: tool.access === "read", openWorldHint: true } },
      (async (args: Record<string, unknown>) => {
        try {
          return { content: [{ type: "text" as const, text: scrub(text(await tool.handler(args as never, ctx)), writeCfg) }] };
        } catch (error) {
          // a tool error is an answer for the model, not a crash of the server; no key can be in it
          const message = error instanceof ToolError ? error.message : `${tool.name} failed: ${(error as Error).message}`;
          return { isError: true, content: [{ type: "text" as const, text: scrub(message, writeCfg) }] };
        }
      }) as never,
    );
  }
  return server;
}
