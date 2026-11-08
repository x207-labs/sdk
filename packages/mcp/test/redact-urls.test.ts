// A-SD-06: the error of a tool must not hand the RPC URLs (with API keys) to the model.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createX207McpServer } from "../src/server.js";
import { redactUrls } from "../src/write-config.js";
import { mock } from "./mock.js";

describe("A-SD-06 URLs in tool errors", () => {
  it("TC-SD-110-01 redactUrls keeps the origin and drops user, path and query", () => {
    expect(redactUrls("all RPC endpoints failed (https://rpc.example/v2/KEY: HTTP 500; http://user:pw@h.test:3030/x?apikey=K2: timeout)")).toBe(
      "all RPC endpoints failed (https://rpc.example: HTTP 500; http://h.test:3030: timeout)",
    );
    expect(redactUrls("no url here: ERR_NOT_MEMBER")).toBe("no url here: ERR_NOT_MEMBER");
  });

  it("TC-SD-110-02 a tool whose RPC fails answers without the key in the URL", async () => {
    const m = mock({ rpcUrls: ["https://rpc.down.test/v2/SECRETKEY-1", "https://rpc2.down.test/?apikey=SECRETKEY-2"], backendUrl: null });
    m.other = () => new Response("down", { status: 500 });
    const server = createX207McpServer(m.config, "stdio");
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = (await client.callTool({ name: "x207_circle_overview", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
    const text = r.content[0]!.text;
    expect(r.isError).toBe(true);
    expect(text).toContain("failed");
    expect(text).not.toContain("SECRETKEY");
    expect(text).toContain("https://rpc.down.test");
  });
});
