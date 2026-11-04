import { describe, expect, it } from "vitest";
import { Guards } from "../src/guards.js";
import { isLoopbackBind } from "../src/http.js";
import { assertPublicUrl, ipv6Bytes, isPrivateAddress } from "../src/net-guard.js";
import { ToolError } from "../src/tools.js";
import { keepIfUnknown } from "../src/write-tools.js";

// UM-112: cross review of the write tools (SD-082) and the fixes of the security batch 8. Each test is a finding that was checked in the code and is closed here.
describe("UM-112 cross review: the network guard", () => {
  it("TC-UM-112-10 F1: IPv6 forms that carry a private IPv4 address, written in hex as `new URL` does, are refused; public ones are not", () => {
    const refused = [
      "64:ff9b::a9fe:a9fe", "64:ff9b::169.254.169.254", "::7f00:1", "2002:a9fe:a9fe::1", "2002:7f00:1::", "::ffff:0:7f00:1", "::ffff:7f00:1", "::ffff:10.0.0.1",
      "fec0::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::1", "::", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "64:ff9b:1::1", "2001:db8::1",
    ];
    for (const a of refused) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["2606:4700:4700::1111", "2001:4860:4860::8888", "64:ff9b::808:808", "::ffff:8.8.8.8", "2002:808:808::1"]) expect(isPrivateAddress(a), a).toBe(false);
    for (const url of ["http://[64:ff9b::169.254.169.254]/", "http://[::7f00:1]/", "http://[fec0::1]/x"]) {
      await_refused(new URL(url));
    }
    expect(ipv6Bytes("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Bytes("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(ipv6Bytes("not-an-address")).toBeNull();
  });

  it("TC-UM-112-11 F6: a trailing dot does not hide a private name", async () => {
    const publicResolver = async () => ["93.184.216.34"];
    for (const name of ["localhost.", "db.internal.", "printer.local.."]) await expect(assertPublicUrl(new URL(`http://${name}/`), publicResolver), name).rejects.toThrow(/refused/);
    await expect(assertPublicUrl(new URL("https://example.com./"), publicResolver)).resolves.toBeUndefined();
  });

  it("TC-UM-112-12 F7: any 127.x address and the mapped form are loopback binds; 0.0.0.0 and a public address are not", () => {
    for (const b of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopbackBind(b), b).toBe(true);
    for (const b of ["0.0.0.0", "::", "192.168.1.5", "93.184.216.34"]) expect(isLoopbackBind(b), b).toBe(false);
  });
});

async function await_refused(url: URL): Promise<void> {
  await expect(assertPublicUrl(url, async () => ["93.184.216.34"]), url.href).rejects.toThrow(/refused/);
}

describe("UM-112 cross review: the guards of the budget", () => {
  const guards = () => new Guards({ account: "agent.test.near", maxSpendSession: 1_000n, maxPricePerCall: 500n, allowedCounterparties: [], allowOutflows: true, allowFullAccessKey: false, nearKey: null } as never, async () => null);

  it("TC-UM-112-13 F4: a negative amount cannot raise the budget or pass the price guard", () => {
    const g = guards();
    expect(() => g.spend(-5n, "x")).toThrow(ToolError);
    expect(() => g.price(-5n, "x")).toThrow(ToolError);
    g.spend(100n, "x");
    g.release(-50n); // a negative release is ignored, it does not raise what is spent
    expect(g.spent).toBe(100n);
    g.release(100n);
    expect(g.spent).toBe(0n);
  });

  it("TC-UM-112-14 F3: the amount goes back only when nothing was committed for certain; a timeout, a 5xx or an unknown error keeps it counted", () => {
    const g = guards();
    const cases: Array<[unknown, boolean]> = [
      [new ToolError("refused: x"), true],
      [Object.assign(new Error("bad request"), { name: "BackendError", status: 400 }), true],
      [Object.assign(new Error("contract said no"), { name: "ContractCallError", code: "ERR_X" }), true],
      [Object.assign(new Error("unreachable"), { name: "BackendError", status: 0 }), false],
      [Object.assign(new Error("server error"), { name: "BackendError", status: 502 }), false],
      [Object.assign(new Error("tx timed out"), { name: "ContractCallError", code: null }), false],
      [new Error("socket hang up"), false],
    ];
    for (const [error, released] of cases) {
      g.spend(100n, "x");
      const thrown = keepIfUnknown({ guards: g }, 100n, error);
      expect(g.spent, String(error)).toBe(released ? 0n : 100n);
      if (!released) {
        expect((thrown as Error).message).toMatch(/outcome is unknown/);
        g.release(100n);
      }
    }
  });
});
