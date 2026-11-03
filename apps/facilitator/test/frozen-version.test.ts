// B5-F2 (review BE-062): a facilitator of this version against a contract older than 0.0.12 must not call the view `is_frozen`, which does not exist there.
import { describe, expect, it } from "vitest";
import { FREEZE_MIN_VERSION, NearChain, VERSION_TTL_MS, versionAtLeast } from "../src/chain.js";
import type { NearRpc } from "../src/rpc.js";
import type { PendingStore } from "../src/pending-store.js";

const A = "a.x207-circle.near";
const circle = { network: "x207:agents-main", circleContract: "x207-circle.near" } as never;

function chainOn(contract: { version: () => string; frozen?: (account: string) => boolean }, now: () => number = () => 0) {
  const calls: string[] = [];
  const rpc = {
    view: async (_c: string, method: string, args: { account_id?: string }) => {
      calls.push(method);
      if (method === "interface_version") return contract.version();
      if (method === "is_frozen") {
        if (!contract.frozen) throw new Error("MethodNotFound: is_frozen"); // what a contract older than 0.0.12 answers
        return contract.frozen(args.account_id!);
      }
      throw new Error(`no view ${method}`);
    },
  } as unknown as NearRpc;
  return { chain: new NearChain(rpc, circle, {} as PendingStore, { now }), calls };
}

describe("SD-074 fix: the freeze check follows the interface version of the contract", () => {
  it("TC-SD-074-04 versions are compared by number, and a text that is not a version is an error", () => {
    expect(FREEZE_MIN_VERSION).toBe("0.0.12");
    expect(versionAtLeast("0.0.12", "0.0.12")).toBe(true);
    expect(versionAtLeast("0.0.13", "0.0.12")).toBe(true);
    expect(versionAtLeast("0.1.0", "0.0.12")).toBe(true);
    expect(versionAtLeast("1.0.0", "0.0.12")).toBe(true);
    expect(versionAtLeast("0.0.11", "0.0.12")).toBe(false);
    expect(versionAtLeast("0.0.9", "0.0.12")).toBe(false); // by number, not by text
    for (const bad of ["", "0.0", "v0.0.12", "0.0.12-rc1", "x"]) expect(() => versionAtLeast(bad, "0.0.12"), bad).toThrow(/interface_version/);
  });

  it("TC-SD-074-05 a contract of 0.0.11 has no freeze: nothing is frozen and the view is never called", async () => {
    const { chain, calls } = chainOn({ version: () => "0.0.11" });
    expect(await chain.isFrozen(A)).toBe(false);
    expect(await chain.isFrozen("b.x207-circle.near")).toBe(false);
    expect(calls).toEqual(["interface_version"]); // read once, remembered
  });

  it("TC-SD-074-06 a contract of 0.0.12 or higher: the view must answer; true is frozen, and an error is an error (fail closed)", async () => {
    const frozen = new Set([A]);
    const { chain } = chainOn({ version: () => "0.0.12", frozen: (a) => frozen.has(a) });
    expect(await chain.isFrozen(A)).toBe(true);
    expect(await chain.isFrozen("b.x207-circle.near")).toBe(false);
    const broken = chainOn({ version: () => "0.0.12" }); // claims 0.0.12 but has no view: not "not frozen"
    await expect(broken.chain.isFrozen(A)).rejects.toThrow(/is_frozen/);
  });

  it("TC-SD-074-07 a failed read of the version is an error and is not remembered; the version is read again after its TTL, so an upgrade in place is seen", async () => {
    let now = 0;
    let version: string | Error = new Error("rpc down");
    const { chain, calls } = chainOn({ version: () => { if (version instanceof Error) throw version; return version; }, frozen: () => true }, () => now);
    await expect(chain.isFrozen(A)).rejects.toThrow(/rpc down/);
    version = "0.0.11";
    expect(await chain.isFrozen(A)).toBe(false); // the failure was not kept
    version = "0.0.12";
    now = VERSION_TTL_MS - 1;
    expect(await chain.isFrozen(A)).toBe(false); // still the remembered 0.0.11
    now = VERSION_TTL_MS;
    expect(await chain.isFrozen(A)).toBe(true); // the contract was upgraded: its freeze is looked at
    expect(calls.filter((c) => c === "interface_version")).toHaveLength(3);
  });
});
