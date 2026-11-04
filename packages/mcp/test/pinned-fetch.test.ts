// M-2 of the cross review (UM-112): DNS rebinding. The connection of x207_pay_request goes only to addresses that were checked, and the name is resolved once, inside the connection.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createPinnedFetch } from "../src/net-guard.js";

describe("M-2 pinned fetch of x207_pay_request", () => {
  async function listen() {
    const seen: string[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("reached");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, seen, port: (server.address() as AddressInfo).port };
  }

  it("TC-SD-082-M2a a name that resolves to a loopback or private address at connection time is refused and nothing reaches the server (the check and the connection use the same answer)", async () => {
    const { server, seen, port } = await listen();
    try {
      // the guard may have seen a public address earlier; the pinned fetch resolves again on its own and applies the guard to THAT answer, the one it connects with
      await expect(createPinnedFetch(async () => ["127.0.0.1"])(`http://rebind.test:${port}/x`)).rejects.toThrow();
      await expect(createPinnedFetch(async () => ["93.184.216.34", "10.0.0.5"])(`http://mixed.test:${port}/x`)).rejects.toThrow(); // one private address among the answers refuses the name
      await expect(createPinnedFetch(async () => ["169.254.169.254"])(`http://meta.test:${port}/x`)).rejects.toThrow();
      await expect(createPinnedFetch(async () => ["::ffff:7f00:1"])(`http://mapped.test:${port}/x`)).rejects.toThrow();
      await expect(createPinnedFetch(async () => [])(`http://empty.test:${port}/x`)).rejects.toThrow();
      expect(seen).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("TC-SD-082-M2b the resolver is asked exactly once for each connection, with the host of the URL, and a failure of the resolver is a failure of the request", async () => {
    const hosts: string[] = [];
    const fetchIt = createPinnedFetch(async (host) => {
      hosts.push(host);
      throw new Error("ENOTFOUND");
    });
    await expect(fetchIt("http://seller.example/api")).rejects.toThrow(/ENOTFOUND/);
    expect(hosts).toEqual(["seller.example"]);
  });

  it("TC-SD-082-M2c only http and https are fetched", async () => {
    await expect(createPinnedFetch(async () => ["93.184.216.34"])("file:///etc/passwd")).rejects.toThrow();
  });
});
