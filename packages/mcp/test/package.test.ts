import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createX207McpServer } from "../src/server.js";
import { mock } from "./mock.js";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { version: string; bin: Record<string, string>; files: string[] };

describe("SD-045: what npm publishes of @x207/mcp", () => {
  it("the version in the server info is the version of package.json", async () => {
    const server = createX207McpServer(mock().config, "stdio");
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    expect(client.getServerVersion()).toMatchObject({ name: "x207", version: pkg.version });
  });

  it("the bin is dist/cli.js without a leading ./ (npm 11.20 removes bin[x207-mcp] at publish when it starts with ./: version 0.0.1 had no command)", () => {
    expect(pkg.bin).toEqual({ "x207-mcp": "dist/cli.js" });
    expect(pkg.files).toContain("dist");
  });

  it("the source of the bin starts with a shebang, so the installed command runs under node", () => {
    expect(readFileSync(new URL("src/cli.ts", root), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
    // when the package is built, the command exists and is executable
    if (existsSync(new URL("dist/cli.js", root))) expect(readFileSync(new URL("dist/cli.js", root), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
});

describe("UM-140: the entry for the official MCP Registry", () => {
  const server = JSON.parse(readFileSync(new URL("server.json", root), "utf8")) as {
    name: string; version: string; description: string;
    packages: Array<{ registryType: string; identifier: string; version: string; transport: { type: string } }>;
    remotes: Array<{ type: string; url: string }>;
  };
  const named = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { name: string; mcpName?: string };

  it("server.json names the same server as mcpName and the same version as package.json", () => {
    expect(named.mcpName).toBe("io.github.x207-labs/x207-mcp");
    expect(server.name).toBe(named.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0]).toMatchObject({ registryType: "npm", identifier: named.name, version: pkg.version, transport: { type: "stdio" } });
  });

  it("the description fits the 100 characters of the registry and the remote is Streamable HTTP", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.remotes).toEqual([{ type: "streamable-http", url: "https://mcp.x207.boxd.sh/mcp" }]);
  });
});
