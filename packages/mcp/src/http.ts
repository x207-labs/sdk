// Streamable HTTP transport (SD-081): stateless, one server per request, read tools only. Binds to 127.0.0.1 unless told otherwise; the server has no key and signs nothing, so what it
// shows is what the contract and the read API already show to anybody.
import { isIP } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpConfig } from "./config.js";
import { ipv6Bytes } from "./net-guard.js";
import { createX207McpServer } from "./server.js";

export interface HttpOptions {
  host?: string;
  port?: number;
  /** Largest request body in bytes; default 1 MiB. */
  maxBodyBytes?: number;
  /** Values of the `Host` header that are served, e.g. `["mcp.example.org"]`. On a loopback address the default is `127.0.0.1`, `localhost` and `[::1]` (with the port). */
  allowedHosts?: readonly string[];
  /** A-SD-14: most `POST /mcp` requests per client address per minute (each one fans out to RPC and the read API); default 300, 0 turns it off. */
  maxRequestsPerMinute?: number;
  now?: () => number;
}

const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("body is not JSON"), { status: 400 });
  }
}

/** Starts the server; resolves when it listens. `GET /healthz` answers 200, `POST /mcp` is the MCP endpoint, everything else is refused. */
/** A loopback bind: `localhost`, any 127.x.x.x, `::1` or the mapped form of a 127.x address (cross review UM-112, F7: `127.0.0.2` is loopback too, and must not serve every Host). */
export function isLoopbackBind(bind: string): boolean {
  const host = bind.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  const bytes = ipv6Bytes(host);
  return bytes !== null && bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff && bytes[12] === 127;
}

export function startHttpServer(config: McpConfig, options: HttpOptions = {}): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const maxBody = options.maxBodyBytes ?? 1_048_576;
  const bind = options.host ?? "127.0.0.1";
  const loopback = isLoopbackBind(bind);
  // DNS rebinding (security review batch 8, SD-081 fix): a web page can make a browser send a request to 127.0.0.1 under the name of an attacker's site. The browser puts that name in `Host`,
  // so on a loopback address only the names of the loopback are served. A server that the operator binds to another address serves what `allowedHosts` says, or every host when there is no list.
  const hostAllowed = (header: string | undefined, port: number): boolean => {
    if (header === undefined) return !loopback && options.allowedHosts === undefined;
    const name = header.toLowerCase();
    if (options.allowedHosts !== undefined) return options.allowedHosts.map((h) => h.toLowerCase()).includes(name);
    if (!loopback) return true;
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "127.0.0.1", "localhost", "[::1]", bind.toLowerCase(), `${bind.toLowerCase()}:${port}`, `[${bind.toLowerCase()}]:${port}`].includes(name);
  };
  const limit = options.maxRequestsPerMinute ?? 300;
  const clock = options.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  /** Fixed window per socket address; at 10 000 addresses the windows that ended go first, then the oldest (never all at once). */
  const overLimit = (client: string): boolean => {
    if (limit <= 0) return false;
    const now = clock();
    const entry = windows.get(client);
    if (entry && now - entry.start < 60_000) return ++entry.count > limit;
    windows.delete(client);
    if (windows.size >= 10_000) {
      for (const [k, w] of windows) if (now - w.start >= 60_000) windows.delete(k);
      for (const k of windows.keys()) {
        if (windows.size < 10_000) break;
        windows.delete(k);
      }
    }
    windows.set(client, { start: now, count: 1 });
    return false;
  };
  const server = createServer(async (req, res) => {
    try {
      const port = (req.socket.localPort ?? options.port ?? 0) as number;
      if (!hostAllowed(req.headers.host, port)) return json(res, 403, { error: "host_not_allowed", message: "the Host header is not one that this server serves" });
      const path = (req.url ?? "").split("?")[0];
      if (path === "/healthz" && req.method === "GET") return json(res, 200, { ok: true, name: "x207-mcp" });
      if (path !== "/mcp") return json(res, 404, { error: "not_found" });
      if (req.method !== "POST") return json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST /mcp" }, id: null }, { allow: "POST" });
      if (overLimit(req.socket.remoteAddress ?? "unknown")) return json(res, 429, { jsonrpc: "2.0", error: { code: -32000, message: "too many requests" }, id: null }, { "retry-after": "60" });
      const body = await readBody(req, maxBody);
      const mcp = createX207McpServer(config, "http");
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      if (!res.headersSent) json(res, status, { jsonrpc: "2.0", error: { code: status === 500 ? -32603 : -32600, message: status === 500 ? "internal error" : (error as Error).message }, id: null });
      else res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3207, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({ server, url: `http://${options.host ?? "127.0.0.1"}:${port}/mcp`, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))) });
    });
  });
}
