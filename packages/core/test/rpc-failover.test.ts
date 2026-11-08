import { describe, expect, it, vi } from "vitest";
import { RpcHttpError, TESTNET_RPC_URLS, createCircleViewFn, isEndpointDown, isRateLimited, withRpcFailover } from "@x207/core";

const ok = (value: unknown) =>
  Response.json({ jsonrpc: "2.0", id: "x207", result: { result: [...Buffer.from(JSON.stringify(value))] } });

describe("UM-191 RPC failover and retry", () => {
  it("TC-UM-191-01 the testnet list is FastNEAR then dRPC, without the deprecated endpoint", () => {
    expect([...TESTNET_RPC_URLS]).toEqual(["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"]);
    expect(TESTNET_RPC_URLS.join(" ")).not.toContain("rpc.testnet.near.org");
  });

  it("TC-UM-191-02 the first endpoint answers HTTP 429 every time: the view moves on to the next endpoint", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return String(url).includes("first") ? new Response("slow down", { status: 429 }) : ok("42");
    });
    const view = createCircleViewFn({
      circleContract: "c.testnet", rpcUrls: ["http://first.test", "http://second.test"], fetch: fetchMock as unknown as typeof fetch,
      failover: { baseMs: 100, sleep: async (ms) => void sleeps.push(ms) },
    });
    expect(await view("headroom", {})).toBe("42");
    // three asks of the first endpoint (one and two retries after 100 ms and 200 ms), then the second
    expect(calls).toEqual(["http://first.test", "http://first.test", "http://first.test", "http://second.test"]);
    expect(sleeps).toEqual([100, 200]);
  });

  it("TC-UM-191-03 FastNEAR answers its rate limit as a JSON-RPC error -429: also a move to the next endpoint", async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes("first")
        ? Response.json({ jsonrpc: "2.0", error: { code: -429, message: "Rate limits exceeded" } })
        : ok({ ok: true }),
    );
    const view = createCircleViewFn({
      circleContract: "c.testnet", rpcUrls: ["http://first.test", "http://second.test"], fetch: fetchMock as unknown as typeof fetch,
      failover: { rateLimitRetries: 0 },
    });
    expect(await view("headroom", {})).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("TC-UM-191-04 a 429 that goes away on the same endpoint is asked again there and never reaches the next one", async () => {
    let n = 0;
    const fetchMock = vi.fn(async (_url?: unknown) => (++n === 1 ? new Response("", { status: 429 }) : ok("7")));
    const view = createCircleViewFn({
      circleContract: "c.testnet", rpcUrls: ["http://first.test", "http://second.test"], fetch: fetchMock as unknown as typeof fetch,
      failover: { sleep: async () => {} },
    });
    expect(await view("headroom", {})).toBe("7");
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["http://first.test", "http://first.test"]);
  });

  it("TC-UM-191-05 every endpoint rate limited: one error that names each endpoint", async () => {
    const view = createCircleViewFn({
      circleContract: "c.testnet", rpcUrls: ["http://a.test", "http://b.test"],
      fetch: (async () => new Response("", { status: 429 })) as unknown as typeof fetch, failover: { rateLimitRetries: 1, sleep: async () => {} },
    });
    await expect(view("headroom", {})).rejects.toThrow(/all RPC endpoints failed \(http:\/\/a\.test: HTTP 429; http:\/\/b\.test: HTTP 429\)/);
  });

  it("TC-UM-191-06 a transaction moves on only after a rate limit: another error is thrown at once", async () => {
    const run = vi.fn(async (url: string) => {
      if (url === "http://a.test") throw new Error("Internal server error");
      return "sent";
    });
    await expect(withRpcFailover(["http://a.test", "http://b.test"], run, { failoverOn: isRateLimited })).rejects.toThrow("Internal server error");
    expect(run).toHaveBeenCalledTimes(1);

    const limited = vi.fn(async (url: string) => {
      if (url === "http://a.test") throw Object.assign(new Error("Rate limits exceeded"), { code: -429 });
      return "sent";
    });
    expect(await withRpcFailover(["http://a.test", "http://b.test"], limited, { failoverOn: isRateLimited, rateLimitRetries: 0 })).toBe("sent");
  });

  it("TC-UM-191-07 what counts as a rate limit and what as a dead endpoint", () => {
    expect(isRateLimited(new RpcHttpError(429, "u"))).toBe(true);
    expect(isRateLimited(new Error("Rate limits exceeded. For higher rate limits get a subscription"))).toBe(true);
    expect(isRateLimited(new Error("THIS ENDPOINT IS DEPRECATED, HTTP 429"))).toBe(true);
    // A-SD-07: digits 429 inside contract or action text are not a rate limit (the transaction may have run)
    expect(isRateLimited(new Error("ERR_EVM_NONCE: nonce 429 expected 430"))).toBe(false);
    expect(isRateLimited(new Error("Action #0: deposit 429 yocto exceeds balance"))).toBe(false);
    expect(isRateLimited(new Error("Smart contract panicked: ERR_RATE_LIMIT_EXCEEDED"))).toBe(false);
    expect(isRateLimited(new Error("balance is 4290000"))).toBe(false);
    expect(isRateLimited(new Error("status 429 Too Many Requests"))).toBe(true);
    expect(isRateLimited(new RpcHttpError(503, "u"))).toBe(false);
    expect(isEndpointDown(new RpcHttpError(503, "u"))).toBe(true);
    expect(isEndpointDown(new Error("getaddrinfo ENOTFOUND near-testnet.drpc.org"))).toBe(true);
    expect(isEndpointDown(new Error("wasm execution failed: ERR_NOT_MEMBER"))).toBe(false);
    expect(isEndpointDown(new RpcHttpError(404, "u"))).toBe(false);
  });
});
