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
