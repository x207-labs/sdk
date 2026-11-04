import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, configFromEnv } from "../src/config.js";
import { startHttpServer } from "../src/http.js";
import { mock } from "./mock.js";

const NAMES = ["x207_circle_overview", "x207_member_inspect", "x207_epoch_report", "x207_simulate_clearing", "x207_search_listings", "x207_order_status"].sort();

describe("SD-081: Streamable HTTP transport (read tools only)", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  it("TC-SD-081-13 a client lists and calls the read tools over HTTP; the server is stateless and keeps no session", async () => {
    const m = mock();
    m.backendAnswers["/members?limit=20"] = { items: [] };
    const http = await startHttpServer(m.config, { port: 0 });
    closers.push(http.close);
    const client = new Client({ name: "http-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(NAMES);
    const r = (await client.callTool({ name: "x207_circle_overview", arguments: {} })) as { content: Array<{ text: string }> };
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ circle: { circle_id: "agents-main" }, members: { items: [] } });
    // a second client is served without any session of the first
    const other = new Client({ name: "http-test-2", version: "0" });
    await other.connect(new StreamableHTTPClientTransport(new URL(http.url)));
    expect((await other.listTools()).tools).toHaveLength(6);
    await client.close();
    await other.close();
  });

  it("TC-SD-081-14 only POST /mcp is served: GET and DELETE are 405, other paths 404, a bad or a big body is refused, /healthz answers", async () => {
    const http = await startHttpServer(mock().config, { port: 0, maxBodyBytes: 2048 });
    closers.push(http.close);
    const base = http.url.replace(/\/mcp$/, "");
    expect((await fetch(http.url, { method: "GET" })).status).toBe(405);
    expect((await fetch(http.url, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const bad = await fetch(http.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(400);
    const big = await fetch(http.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(5000) }) });
    expect(big.status).toBe(413);
  });

  it("TC-SD-081-15 the server listens on 127.0.0.1 by default", async () => {
    const http = await startHttpServer(mock().config, { port: 0 });
    closers.push(http.close);
    expect(http.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });
});

describe("SD-081: configuration from the environment", () => {
  it("TC-SD-081-16 the contract is required; a testnet circle reads from the testnet endpoint by default; values are checked", () => {
    expect(() => configFromEnv({})).toThrow(ConfigError);
    expect(() => configFromEnv({ X207_CIRCLE_CONTRACT: "Bad Name" })).toThrow(/X207_CIRCLE_CONTRACT/);
    const c = configFromEnv({ X207_CIRCLE_CONTRACT: "x207-v013.testnet" });
    expect(c).toMatchObject({ circleId: "agents-main", rpcUrls: ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"], backendUrl: null, timeoutMs: 10_000 });
    expect(configFromEnv({ X207_CIRCLE_CONTRACT: "x207.near" }).rpcUrls.join(" ")).not.toMatch(/testnet/);
    expect(configFromEnv({ X207_CIRCLE_CONTRACT: "a.testnet", X207_RPC_URL: "https://a.test, https://b.test", X207_BACKEND_URL: "https://api.test/", X207_CIRCLE_ID: "c1" })).toMatchObject({ rpcUrls: ["https://a.test", "https://b.test"], backendUrl: "https://api.test", circleId: "c1" });
    expect(() => configFromEnv({ X207_CIRCLE_CONTRACT: "a.testnet", X207_RPC_URL: "ftp://x" })).toThrow(/not an http/);
    expect(() => configFromEnv({ X207_CIRCLE_CONTRACT: "a.testnet", X207_BACKEND_URL: "nope" })).toThrow(/X207_BACKEND_URL/);
    expect(() => configFromEnv({ X207_CIRCLE_CONTRACT: "a.testnet", X207_TIMEOUT_MS: "5" })).toThrow(/X207_TIMEOUT_MS/);
  });
});

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe.skipIf(!existsSync(CLI))("SD-081: stdio transport, the built x207-mcp against a local RPC and read API", () => {
  let fake: Server | undefined;
  afterAll(() => void fake?.close());

  it("TC-SD-081-17 the built CLI speaks MCP on stdio and answers a tool call from the RPC and the read API", async () => {
    const m = mock();
    fake = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", async () => {
        const url = req.url ?? "/";
        const target = url.startsWith("/x207/") ? `https://api.mock.test${url}` : "https://rpc.mock.test";
        const response = await m.config.fetch!(target, { method: req.method, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(await response.text());
      });
    });
    await new Promise<void>((r) => fake!.listen(0, "127.0.0.1", r));
    const port = (fake.address() as { port: number }).port;
    m.backendAnswers["/listings?limit=20"] = { items: [{ listingHash: "h1" }], nextCursor: null };
    const client = new Client({ name: "stdio-test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath, args: [CLI],
        env: { PATH: process.env.PATH ?? "", X207_CIRCLE_CONTRACT: "x207-v013.testnet", X207_RPC_URL: `http://127.0.0.1:${port}`, X207_BACKEND_URL: `http://127.0.0.1:${port}` },
      }),
    );
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(NAMES);
    const r = (await client.callTool({ name: "x207_search_listings", arguments: {} })) as { content: Array<{ text: string }> };
    expect(JSON.parse(r.content[0]!.text)).toEqual({ items: [{ listingHash: "h1" }], nextCursor: null });
    const s = (await client.callTool({ name: "x207_epoch_report", arguments: { epoch: 7 } })) as { content: Array<{ text: string }> };
    expect(JSON.parse(s.content[0]!.text)).toMatchObject({ epoch: 7, contract: { epoch: 7 } });
    await client.close();
  });

  it("TC-SD-081-18 a missing contract makes the CLI stop with a message on stderr and a non-zero exit, and nothing on stdout", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [CLI], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/X207_CIRCLE_CONTRACT must be the circle contract account/);
  });
});
