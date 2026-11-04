import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCircleViewFn } from "@x207/core";
import { createBackendGet } from "./backend.js";
import type { McpConfig } from "./config.js";
import { READ_TOOLS, ToolError, type ToolContext, type ToolDef } from "./tools.js";

export type Transport = "stdio" | "http";

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

/** One MCP server with the tools of `transport`. Every tool is read-only: it reads views of the contract and the read API and sends nothing. */
export function createX207McpServer(config: McpConfig, transport: Transport, version = "0.0.1"): McpServer {
  const server = new McpServer({ name: "x207", version });
  const ctx = contextFrom(config);
  for (const tool of toolsFor(transport)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: tool.access === "read", destructiveHint: false, idempotentHint: true, openWorldHint: true } },
      (async (args: Record<string, unknown>) => {
        try {
          return { content: [{ type: "text" as const, text: text(await tool.handler(args as never, ctx)) }] };
        } catch (error) {
          // a tool error is an answer for the model, not a crash of the server
          const message = error instanceof ToolError ? error.message : `${tool.name} failed: ${(error as Error).message}`;
          return { isError: true, content: [{ type: "text" as const, text: message }] };
        }
      }) as never,
    );
  }
  return server;
}
