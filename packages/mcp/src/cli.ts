#!/usr/bin/env node
// x207-mcp: the MCP server of x207. stdio by default (for Claude Desktop and other local clients); `--http` for Streamable HTTP (read tools only).
//   X207_CIRCLE_CONTRACT=x207-v013.testnet X207_BACKEND_URL=http://127.0.0.1:8080 x207-mcp [--http [--port 3207] [--host 127.0.0.1]]
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, configFromEnv } from "./config.js";
import { startHttpServer } from "./http.js";
import { createX207McpServer } from "./server.js";
import { writeConfigFromEnv } from "./write-config.js";

const USAGE = "usage: x207-mcp [--http [--port <n>] [--host <address>]]   (environment: X207_CIRCLE_CONTRACT, X207_CIRCLE_ID, X207_RPC_URL, X207_BACKEND_URL, X207_TIMEOUT_MS, X207_ALLOWED_HOSTS)";

async function main(argv: string[]): Promise<void> {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") {
      console.error(USAGE);
      return;
    }
    if (a === "--http") args.set("http", true);
    else if (a === "--port" || a === "--host") {
      const v = argv[(i += 1)];
      if (v === undefined || v.startsWith("--")) throw new ConfigError(`${a} needs a value\n${USAGE}`);
      args.set(a.slice(2), v);
    } else throw new ConfigError(`unknown argument ${a}\n${USAGE}`);
  }
  const config = configFromEnv();
  if (args.has("http")) {
    if (process.env.X207_MCP_WRITE === "1") console.error("x207-mcp: X207_MCP_WRITE is ignored on HTTP: the HTTP server only has the read tools");
    const port = args.has("port") ? Number(args.get("port")) : 3207;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("--port must be an integer from 0 to 65535");
    const allowedHosts = (process.env.X207_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter((h) => h !== "");
    const { url } = await startHttpServer(config, { port, host: (args.get("host") as string | undefined) ?? "127.0.0.1", ...(allowedHosts.length > 0 ? { allowedHosts } : {}) });
    console.error(`x207-mcp: Streamable HTTP (read tools only) on ${url}`);
    return;
  }
  // stdout belongs to the protocol: every message of ours goes to stderr
  const write = writeConfigFromEnv();
  await createX207McpServer(config, "stdio", { write }).connect(new StdioServerTransport());
  console.error(`x207-mcp: stdio, circle ${config.circleContract}, read API ${config.backendUrl ?? "not configured (contract views only)"}, ${write ? `WRITE tools on for ${write.account}` : "read tools only"}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`x207-mcp: ${error instanceof ConfigError ? error.message : error}`);
  process.exit(1);
});
