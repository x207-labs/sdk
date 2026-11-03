// CachedVerifyChain: what is kept, for how long, and when the facilitator forgets it (see src/chain-cache.ts for the staleness argument).
import { describe, expect, it } from "vitest";
import type { ContractAbi } from "@x207/core";
import { CachedVerifyChain } from "../src/chain-cache.js";

function fakeChain() {
  const calls: string[] = [];
  let failNext = false;
  const chain = {
    async getEpoch() { calls.push("get_epoch"); return { epoch: 7 } as ContractAbi.EpochView; },
    async member(a: string) { calls.push(`member ${a}`); if (failNext) { failNext = false; throw new Error("rpc down"); } return { status: "active" } as ContractAbi.MemberView; },
    async headroom(a: string) { calls.push(`headroom ${a}`); return "1000"; },
    async obligation(e: number, d: string, c: string) { calls.push(`obligation ${e} ${d} ${c}`); return { cumulative: "10", last_seq: 1 }; },
    async bundle(id: number) { calls.push(`bundle ${id}`); return null; },
    async isFrozen(a: string) { calls.push(`frozen ${a}`); return a === "z"; },
    async pendingByPayer() { calls.push("pending"); return []; },
  };
  return { chain, calls, failNext: () => { failNext = true; } };
}

describe("UM-032 follow-up: cache of the chain reads of verify", () => {
  it("TC-CC-01 a read inside its TTL is answered from memory, after the TTL the chain is asked again", async () => {
    let now = 0;
    const { chain, calls } = fakeChain();
    const cached = new CachedVerifyChain(chain, { now: () => now, memberMs: 1000, epochMs: 5000 });
    await cached.member("a"); await cached.member("a"); await cached.getEpoch(); await cached.getEpoch();
    expect(calls).toEqual(["member a", "get_epoch"]);
    now = 999; await cached.member("a");
    expect(calls).toHaveLength(2);
    now = 1000; await cached.member("a");
    expect(calls).toEqual(["member a", "get_epoch", "member a"]);
    now = 5000; await cached.getEpoch();
    expect(calls.at(-1)).toBe("get_epoch");
    expect(cached.stats).toEqual({ hits: 3, misses: 4 });
  });

  it("TC-SD-074-02 is_frozen is cached for its own TTL like member; an older chain with no is_frozen reads as not frozen", async () => {
    let now = 0;
    const { chain, calls } = fakeChain();
    const cached = new CachedVerifyChain(chain, { now: () => now, frozenMs: 1000 });
    expect(await cached.isFrozen("z")).toBe(true);
    expect(await cached.isFrozen("z")).toBe(true);
    expect(await cached.isFrozen("a")).toBe(false);
    expect(calls).toEqual(["frozen z", "frozen a"]);
    now = 1000;
    await cached.isFrozen("z");
    expect(calls.at(-1)).toBe("frozen z");
    const { isFrozen: _omit, ...older } = chain;
    void _omit;
    expect(await new CachedVerifyChain(older, { now: () => 0 }).isFrozen("z")).toBe(false);
  });

  it("TC-CC-02 two reads at the same moment share one request; a failed read is not kept", async () => {
    const { chain, calls, failNext } = fakeChain();
    const cached = new CachedVerifyChain(chain, { now: () => 0 });
    await Promise.all([cached.headroom("a"), cached.headroom("a"), cached.headroom("a")]);
    expect(calls).toEqual(["headroom a"]);
    failNext();
    await expect(cached.member("b")).rejects.toThrow("rpc down");
    await expect(cached.member("b")).resolves.toMatchObject({ status: "active" });
    expect(calls.filter((c) => c === "member b")).toHaveLength(2);
  });

  it("TC-CC-03 invalidatePayer drops the headroom and the obligations of that payer only, not its membership", async () => {
    const { chain, calls } = fakeChain();
    const cached = new CachedVerifyChain(chain, { now: () => 0 });
    await cached.headroom("a"); await cached.headroom("b"); await cached.obligation(7, "a", "b"); await cached.obligation(7, "b", "a"); await cached.member("a");
    calls.length = 0;
    cached.invalidatePayer("a");
    await cached.headroom("a"); await cached.headroom("b"); await cached.obligation(7, "a", "b"); await cached.obligation(7, "b", "a"); await cached.member("a");
    expect(calls).toEqual(["headroom a", "obligation 7 a b"]);
  });

  it("TC-CC-04 a TTL of 0 turns an entry off", async () => {
    const { chain, calls } = fakeChain();
    const cached = new CachedVerifyChain(chain, { now: () => 0, memberMs: 0 });
    await cached.member("a"); await cached.member("a");
    expect(calls).toEqual(["member a", "member a"]);
  });

  it("TC-CC-05 pending rows are local and never cached", async () => {
    const { chain, calls } = fakeChain();
    const cached = new CachedVerifyChain(chain, { now: () => 0 });
    await cached.pendingByPayer("a", 7); await cached.pendingByPayer("a", 7);
    expect(calls).toEqual(["pending", "pending"]);
  });
});
