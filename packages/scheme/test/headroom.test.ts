import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeBase, computeHeadroom, type HeadroomSources, type PendingVoucherRef } from "@x207/scheme";

const A = "a.x207-circle.near";
const B = "b.x207-circle.near";
const C = "c.x207-circle.near";

type Fixture = {
  onchainHeadroom: string;
  pending?: (PendingVoucherRef & { epoch: number })[];
  obligations?: { payee: string; cumulative: string }[];
  lastSeq?: Record<string, number>;
};

/** Mock data source: the D3 pending store (filtered per epoch like `listByPayer`) and the contract view. */
function sources(fixture: Fixture): HeadroomSources {
  return {
    headroom: async () => fixture.onchainHeadroom,
    obligation: async (_epoch, _debtor, creditor) => {
      const found = fixture.obligations?.find((o) => o.payee === creditor);
      return found ? { cumulative: found.cumulative, last_seq: fixture.lastSeq?.[creditor] ?? 1 } : null;
    },
    pendingByPayer: async (_payer, epoch) =>
      (fixture.pending ?? []).filter((row) => row.epoch === epoch),
  };
}
const pending = (payee: string, cumulativeAmount: string, epoch = 42, seq = 1) => ({
  payee, cumulativeAmount, epoch, seq,
});

describe("SD-023 computeHeadroom", () => {
  it("TC-SD-023-01 no pending", async () => {
    expect(await computeHeadroom(A, 42, sources({ onchainHeadroom: "100000" }))).toBe("100000");
  });

  it("TC-SD-023-02 one pending not registered yet", async () => {
    const s = sources({ onchainHeadroom: "100000", pending: [pending(B, "60000")] });
    expect(await computeHeadroom(A, 42, s)).toBe("40000");
  });

  it("TC-SD-023-03 pending partly registered: the registered part is not counted twice", async () => {
    const s = sources({
      onchainHeadroom: "80000",
      pending: [pending(B, "60000")],
      obligations: [{ payee: B, cumulative: "20000" }],
    });
    expect(await computeHeadroom(A, 42, s)).toBe("40000");
  });

  it("TC-SD-023-04 pending to several payees", async () => {
    const s = sources({ onchainHeadroom: "100000", pending: [pending(B, "30000"), pending(C, "50000")] });
    expect(await computeHeadroom(A, 42, s)).toBe("20000");
  });

  it("TC-SD-023-05 passes on-chain, fails after pending", async () => {
    const s = sources({ onchainHeadroom: "100000", pending: [pending(B, "90000")] });
    const headroom = await computeHeadroom(A, 42, s);
    expect(headroom).toBe("10000");
    expect(BigInt("20000") <= BigInt(headroom)).toBe(false);
  });

  it("TC-SD-023-07 a settled row is not counted", async () => {
    const s = sources({
      onchainHeadroom: "100000",
      pending: [pending(B, "60000")],
      obligations: [{ payee: B, cumulative: "60000" }],
    });
    expect(await computeHeadroom(A, 42, s)).toBe("100000");
  });

  it("TC-SD-023-08 another epoch is ignored", async () => {
    const s = sources({ onchainHeadroom: "100000", pending: [pending(B, "50000", 41)] });
    expect(await computeHeadroom(A, 42, s)).toBe("100000");
  });

  it("TC-SD-023-09 never negative", async () => {
    const zero = sources({ onchainHeadroom: "0", pending: [pending(B, "20000")] });
    expect(await computeHeadroom(A, 42, zero)).toBe("0");
    const over = sources({ onchainHeadroom: "30000", pending: [pending(B, "50000")] });
    expect(await computeHeadroom(A, 42, over)).toBe("0");
  });

  it("pending lower than registered does not add headroom", async () => {
    const s = sources({
      onchainHeadroom: "50000",
      pending: [pending(B, "10000")],
      obligations: [{ payee: B, cumulative: "20000" }],
    });
    expect(await computeHeadroom(A, 42, s)).toBe("50000");
  });

  it("big arithmetic without float", async () => {
    const s = sources({ onchainHeadroom: "9007199254740993", pending: [pending(B, "1")] });
    expect(await computeHeadroom(A, 42, s)).toBe("9007199254740992");
  });

  it("TC-SD-023-10 test vector headroom", async () => {
    const dir = fileURLToPath(new URL("../../../spec/test-vectors/headroom/", import.meta.url));
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const { input, expected } = JSON.parse(readFileSync(`${dir}${file}`, "utf8"));
      const got = await computeHeadroom(input.payer, input.epoch, sources(input));
      expect(got, file).toBe(expected.headroom);
    }
  });
});

describe("SD-023 computeBase", () => {
  const last = (v: { seq: number; cumulativeAmount: string; source: string }) => v;

  it("pending ahead of on-chain", async () => {
    const s = sources({
      onchainHeadroom: "0",
      pending: [pending(B, "60000", 42, 3)],
      obligations: [{ payee: B, cumulative: "20000" }],
      lastSeq: { [B]: 1 },
    });
    expect(last(await computeBase(A, B, 42, s))).toEqual({ seq: 3, cumulativeAmount: "60000", source: "pending" });
  });

  it("without pending, uses the on-chain obligation", async () => {
    const s = sources({ onchainHeadroom: "0", obligations: [{ payee: B, cumulative: "20000" }], lastSeq: { [B]: 7 } });
    expect(last(await computeBase(A, B, 42, s))).toEqual({ seq: 7, cumulativeAmount: "20000", source: "onchain" });
  });

  it("neither exists: seq 0", async () => {
    expect(last(await computeBase(A, B, 42, sources({ onchainHeadroom: "0" })))).toEqual({
      seq: 0,
      cumulativeAmount: "0",
      source: "none",
    });
  });
});
