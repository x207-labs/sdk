import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NotImplementedError } from "@x207/scheme";
import {
  ChainUnavailableError,
  ConfigError,
  DEFAULT_RPC_TIMEOUT_MS,
  NearRpc,
  redactUrls,
  createApp,
  loadConfig,
  type FacilitatorService,
} from "../src/index.js";

const REQ = {
  scheme: "batch-settlement",
  network: "x207:agents-main",
  amount: "20000",
  asset: "USD",
  payTo: "summarizer.x207-circle.near",
  maxTimeoutSeconds: 60,
  extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42 },
};
const BODY = { x402Version: 2, paymentPayload: { x402Version: 2, accepted: REQ, payload: {} }, paymentRequirements: REQ };

const okService: FacilitatorService = {
  verify: async () => ({ isValid: true, payer: "translator.x207-circle.near" }),
  settle: async () => ({ success: true, transaction: "a:b:42:1", network: "x207:agents-main" }),
  supported: async () => ({ kinds: [], extensions: [], signers: {} }),
};
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

const servers: Server[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.closeAllConnections?.() ?? s.close()); servers.splice(0); });
async function rpcServer(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const healthy = (value: unknown) => (_req: unknown, res: import("node:http").ServerResponse) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: "x207", result: { result: [...Buffer.from(JSON.stringify(value))] } }));
};
const failing = (_req: unknown, res: import("node:http").ServerResponse) => { res.statusCode = 503; res.end("down"); };
const hanging = () => { /* never answers */ };

function rpcBackedService(rpc: NearRpc): FacilitatorService {
  return { ...okService, verify: async () => ({ isValid: true, payer: String(await rpc.view("x207-circle.near", "get_epoch")) }) };
}

describe("SD-021 scaffold apps/facilitator", () => {
  it("TC-SD-021-01 three routes exist and answer JSON", async () => {
    const app = createApp(okService);
    for (const [path, res] of [
      ["/verify", await post(app, "/verify", BODY)],
      ["/settle", await post(app, "/settle", BODY)],
      ["/supported", await app.request("/supported")],
    ] as const) {
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain("application/json");
      await res.json();
    }
  });

  it("TC-SD-021-02 unknown route 404 not_found", async () => {
    const res = await createApp(okService).request("/foo");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("TC-SD-021-03 body is not JSON 400 invalid_request", async () => {
    const res = await post(createApp(okService), "/verify", "abc");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request", message: expect.any(String) });
  });

  it("TC-SD-021-04 a missing required field gives 400 invalid_request", async () => {
    const { paymentRequirements: _r, ...without } = BODY;
    const res = await post(createApp(okService), "/verify", without);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    expect((await post(createApp(okService), "/settle", { ...BODY, paymentPayload: undefined })).status).toBe(400);
  });

  it("TC-SD-021-05 network failing the regex gives 400 invalid_request", async () => {
    const bad = { ...REQ, network: "x207:x207-circle.near" };
    const res = await post(createApp(okService), "/verify", { ...BODY, paymentRequirements: bad });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("TC-SD-021-06 RPC does not answer -> 503 chain_unavailable + Retry-After", async () => {
    const url = await rpcServer(hanging);
    const app = createApp(rpcBackedService(new NearRpc({ urls: [url], timeoutMs: 50 })));
    const res = await post(app, "/verify", BODY);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "chain_unavailable" });
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("TC-SD-021-06 default timeout of 10 seconds (ADR-25)", () => {
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(10_000);
    expect(loadConfig({ X207_CIRCLES: "agents-main=x207-circle.near" }).rpcTimeoutMs).toBe(10_000);
  });

  it("TC-SD-021-07 failover to the spare RPC, then both fail", async () => {
    const down = await rpcServer(failing);
    const up = await rpcServer(healthy("epoch-42"));
    const rpc = new NearRpc({ urls: [down, up], timeoutMs: 200 });
    expect(await rpc.view("x207-circle.near", "get_epoch")).toBe("epoch-42");

    const down2 = await rpcServer(failing);
    const both = new NearRpc({ urls: [down, down2], timeoutMs: 200 });
    await expect(both.view("x207-circle.near", "get_epoch")).rejects.toBeInstanceOf(ChainUnavailableError);
    const res = await post(createApp(rpcBackedService(both)), "/verify", BODY);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "chain_unavailable" });
  });

  it("TC-SD-107-01 the 503 answer names no RPC URL (A-SD-05): the URLs, with their API keys, stay out of the body", async () => {
    const down = await rpcServer(failing);
    const down2 = await rpcServer(failing);
    const secretA = `${down}/v2/SECRETKEY-A`;
    const both = new NearRpc({ urls: [secretA, `${down2}?apikey=SECRETKEY-B`], timeoutMs: 200 });
    const res = await post(createApp(rpcBackedService(both)), "/verify", BODY);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: "chain_unavailable" });
    expect(text).not.toContain("SECRETKEY");
    expect(text).not.toContain("http");
    expect(text).not.toContain("127.0.0.1");
  });

  it("TC-SD-107-02 redactUrls replaces every URL of a text", () => {
    expect(redactUrls("all RPC endpoints failed (https://rpc.example/v2/KEY: HTTP 500; http://h:3030/?apikey=K2: timeout)")).toBe("all RPC endpoints failed (<rpc-url>: HTTP 500; <rpc-url>: timeout)");
    expect(redactUrls("ERR_EVM_NONCE: nonce 5 expected 6")).toBe("ERR_EVM_NONCE: nonce 5 expected 6");
  });

  it("TC-SD-021-07 a contract error from RPC does not trigger failover", async () => {
    const erroring = await rpcServer((_q, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "x207", error: { cause: { name: "UNKNOWN_ACCOUNT" } } }));
    });
    const spare = await rpcServer(healthy("unused"));
    await expect(new NearRpc({ urls: [erroring, spare], timeoutMs: 200 }).call("query", {})).rejects.toThrow(/RPC query error/);
  });

  it("TC-SD-021-08 dependencies: @x402/near 2.29.0, @near-js 2.5.1, no near-api-js", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const readJson = (path: string) => JSON.parse(readFileSync(`${root}${path}`, "utf8"));
    const pkg = readJson("apps/facilitator/package.json");
    expect(pkg.dependencies["@x402/near"]).toBe("2.29.0");
    expect(pkg.dependencies["near-api-js"]).toBeUndefined();
    const lock = readJson("package-lock.json").packages as Record<string, { version?: string }>;
    expect(lock["node_modules/@x402/near"]?.version).toBe("2.29.0");
    const nearJs = Object.entries(lock).filter(([name]) => /^node_modules\/@near-js\/[^/]+$/.test(name));
    expect(nearJs.length).toBeGreaterThan(0);
    for (const [name, entry] of nearJs) expect(entry.version, name).toBe("2.5.1");

    const importsNearApi = (dir: string) =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".ts"))
        .filter((e) => /from\s+["']near-api-js/.test(readFileSync(`${e.parentPath}/${e.name}`, "utf8")));
    expect(importsNearApi(`${root}apps/facilitator/src`)).toEqual([]);
    expect(importsNearApi(`${root}packages/scheme`).filter((e) => !e.parentPath.includes("node_modules") && !e.parentPath.includes("dist"))).toEqual([]);
    // The @x207/core root entry must not pull in near-api-js 7 (the contract client is in a separate subpath).
    // The only core file allowed to import near-api-js is the separate entry `signer.ts`, which is not exported from the root.
    expect(importsNearApi(`${root}packages/core/src`).map((e) => e.name)).toEqual(["signer.ts"]);
    expect(readFileSync(`${root}packages/core/src/index.ts`, "utf8")).not.toMatch(/signer/);
  });

  it("TC-SD-021-09 configuration variables are in .env.example and required variables are checked", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const example = readFileSync(`${root}.env.example`, "utf8");
    const source = readFileSync(`${root}apps/facilitator/src/config.ts`, "utf8");
    const names = new Set([...source.matchAll(/(?:env\.|parsePositiveInt\(env, ")((?:X207|NEAR|RPC)_[A-Z_]+|PORT)/g)].map((m) => m[1]!));
    expect(names.size).toBeGreaterThanOrEqual(6);
    for (const name of names) expect(example, name).toMatch(new RegExp(`^${name}=`, "m"));
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/X207_CIRCLES/);
    expect(() => loadConfig({ X207_CIRCLES: "agents-main=x207-circle.near", X207_RELAYER_ACCOUNT_ID: "r.near" })).toThrow(/RELAYER/);
    expect(() => loadConfig({ X207_CIRCLES: "bad=" })).toThrow(ConfigError);
    expect(() => loadConfig({ X207_CIRCLES: "x207-circle.near=x" })).toThrow(ConfigError);
    expect(loadConfig({ X207_CIRCLES: "agents-main=x207-circle.near", PORT: "9000" })).toMatchObject({
      port: 9000,
      circles: [{ network: "x207:agents-main", circleContract: "x207-circle.near" }],
    });
  });

  it("TC-SD-021-10 error internal 500 internal_error", async () => {
    const app = createApp({ ...okService, verify: async () => { throw new NotImplementedError("verify", "SD-024"); } });
    const res = await post(app, "/verify", BODY);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });
});
