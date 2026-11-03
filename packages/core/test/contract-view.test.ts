import { describe, expect, it, vi } from "vitest";
import { createCircleViewFn, getMember } from "@x207/core";

const ok = (value: unknown) =>
  Response.json({ jsonrpc: "2.0", id: "x207", result: { result: [...Buffer.from(JSON.stringify(value))] } });

describe("SD-012 createCircleViewFn", () => {
  it("calls call_function with a base64 argument and parses the result", async () => {
    const fetchMock = vi.fn(async () => ok(null));
    const view = createCircleViewFn({ circleContract: "x207-circle.near", rpcUrls: ["http://rpc.test"], fetch: fetchMock as unknown as typeof fetch });
    expect(await getMember(view, "stranger.near")).toBeNull();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(body.params).toMatchObject({ request_type: "call_function", account_id: "x207-circle.near", method_name: "member" });
    expect(JSON.parse(Buffer.from(body.params.args_base64, "base64").toString())).toEqual({ account_id: "stranger.near" });
  });

  it("failover to a backup endpoint, then an error when all fail", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return String(url).includes("down") ? new Response("x", { status: 503 }) : ok("42");
    });
    const view = createCircleViewFn({ circleContract: "c.near", rpcUrls: ["http://down.test", "http://up.test"], fetch: fetchMock as unknown as typeof fetch });
    expect(await view("headroom", {})).toBe("42");
    expect(calls).toEqual(["http://down.test", "http://up.test"]);
    const allDown = createCircleViewFn({ circleContract: "c.near", rpcUrls: ["http://down.test"], fetch: fetchMock as unknown as typeof fetch });
    await expect(allDown("headroom", {})).rejects.toThrow(/all RPC endpoints failed/);
  });

  it("a contract panic does not trigger failover", async () => {
    const fetchMock = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: "x207", result: { error: "wasm execution failed: ERR_X" } }));
    const view = createCircleViewFn({ circleContract: "c.near", rpcUrls: ["http://a.test", "http://b.test"], fetch: fetchMock as unknown as typeof fetch });
    await expect(view("headroom", {})).rejects.toThrow(/ERR_X/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
