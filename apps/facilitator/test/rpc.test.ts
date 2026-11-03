// NearRpc: HTTP 429 of a public endpoint is asked again with backoff when `rateLimit` is set; without it the endpoint counts as failed.
import { describe, expect, it } from "vitest";
import { ChainUnavailableError, NearRpc } from "../src/rpc.js";

const ok = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x207", result: { ok: true } }), { status: 200 });
const tooMany = (retryAfter?: string) => new Response("slow down", { status: 429, ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}) });

describe("SD-031 NearRpc rate limit", () => {
  it("TC-SD-031-20 429 is asked again until it passes, and the failure is reported when it never does", async () => {
    let calls = 0;
    const flaky = new NearRpc({ urls: ["http://a"], timeoutMs: 1000, rateLimit: { attempts: 3, baseMs: 1 }, fetch: async () => (++calls < 3 ? tooMany() : ok()) });
    expect(await flaky.call("status", [])).toEqual({ ok: true });
    expect(calls).toBe(3);

    calls = 0;
    const stuck = new NearRpc({ urls: ["http://a"], timeoutMs: 1000, rateLimit: { attempts: 2, baseMs: 1 }, fetch: async () => (calls++, tooMany()) });
    await expect(stuck.call("status", [])).rejects.toThrow(ChainUnavailableError);
    expect(calls).toBe(3);
  });

  it("TC-SD-031-21 without the option a 429 is not repeated, and the next endpoint is tried", async () => {
    const seen: string[] = [];
    const rpc = new NearRpc({ urls: ["http://a", "http://b"], timeoutMs: 1000, fetch: async (url) => (seen.push(String(url)), String(url) === "http://a" ? tooMany() : ok()) });
    expect(await rpc.call("status", [])).toEqual({ ok: true });
    expect(seen).toEqual(["http://a", "http://b"]);
  });
});
