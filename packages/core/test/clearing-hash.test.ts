import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EventParseError, edgesCanonical, edgesHash, getProposalPage, parseEventLog, positionsCanonical, positionsHash, readProposal, type ClearingAppliedEdge, type EpochCommittedPosition,
  type ProposalPage, type X207Event,
} from "../src/index.js";

// SD-080 (interface 0.0.13, CT-099): the canonical hashes against the golden vector of the contract (a copy of contracts/tests/vectors/clearing_hashes.json), the event shapes of 0.0.13
// next to the legacy shapes, and the paged view get_proposal.
type Vector = {
  edges: Array<{ name: string; input: ClearingAppliedEdge[]; canonical: string; edges_hash: string }>;
  positions: Array<{ name: string; input: EpochCommittedPosition[]; canonical: string; positions_hash: string }>;
};
const vector = JSON.parse(readFileSync(new URL("../../../spec/test-vectors/clearing-hashes/clearing_hashes.json", import.meta.url), "utf8")) as Vector;
const A = "andi.x207-circle.near";
const B = "budi.x207-circle.near";
const C = "citra.x207-circle.near";
const log = (event: string, data: unknown, version: string) => `EVENT_JSON:${JSON.stringify({ standard: "x207", version, event, data: [data] })}`;
const one = (line: string) => parseEventLog(line)![0] as X207Event;

describe("SD-080 the canonical hashes follow the golden vector", () => {
  it("TC-SD-080-01 edges: the canonical JSON and edges_hash of every case of the vector", () => {
    expect(vector.edges.length).toBeGreaterThanOrEqual(3);
    for (const c of vector.edges) {
      expect(edgesCanonical(c.input), c.name).toBe(c.canonical);
      expect(edgesHash(c.input), c.name).toBe(c.edges_hash);
    }
  });

  it("TC-SD-080-02 positions: the canonical JSON and positions_hash of every case of the vector", () => {
    expect(vector.positions.length).toBeGreaterThanOrEqual(2);
    for (const c of vector.positions) {
      expect(positionsCanonical(c.input), c.name).toBe(c.canonical);
      expect(positionsHash(c.input), c.name).toBe(c.positions_hash);
    }
  });

  it("TC-SD-080-03 the order of the input does not change the hash, an edge with cleared 0 is not in it, and an empty list is []", () => {
    const edges: ClearingAppliedEdge[] = [{ debtor: C, creditor: A, cleared: "5" }, { debtor: A, creditor: B, cleared: "5" }, { debtor: B, creditor: C, cleared: "0" }];
    expect(edgesHash(edges)).toBe(edgesHash([...edges].reverse()));
    expect(edgesHash(edges)).toBe(edgesHash(edges.filter((e) => e.cleared !== "0")));
    expect(edgesCanonical([])).toBe("[]");
    expect(positionsCanonical([])).toBe("[]");
    expect(edgesHash([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("TC-SD-080-04 the order is by bytes: 'Z' (0x5a) is before 'a' (0x61), and a longer name after its prefix", () => {
    const edges: ClearingAppliedEdge[] = [{ debtor: "a.near", creditor: "x.near", cleared: "1" }, { debtor: "Z.near", creditor: "x.near", cleared: "1" }, { debtor: "a.near.sub", creditor: "x.near", cleared: "1" }];
    expect((JSON.parse(edgesCanonical(edges)) as ClearingAppliedEdge[]).map((e) => e.debtor)).toEqual(["Z.near", "a.near", "a.near.sub"]);
  });

  it("TC-SD-080-05 an amount that is not a whole decimal number is refused, a changed amount changes the hash", () => {
    expect(() => edgesHash([{ debtor: A, creditor: B, cleared: "1.5" }])).toThrow(/decimal whole number/);
    expect(() => edgesHash([{ debtor: A, creditor: B, cleared: "007" }])).toThrow();
    expect(edgesHash([{ debtor: A, creditor: B, cleared: "6" }])).not.toBe(edgesHash([{ debtor: A, creditor: B, cleared: "7" }]));
    expect(() => positionsHash([{ account_id: A, net: "-0x1", role: "debtor", status: "due", amount: "1", outstanding_debt: "1" }])).toThrow();
  });
});

describe("SD-080 the events of interface 0.0.13", () => {
  const applied = { epoch: 42, solver: B, cleared_total: "180000000", edge_count: 300, edges_hash: "a".repeat(64), clearing_fee: "0", solver_fee: "0" };
  const committed = {
    epoch: 42, committed_at: "1", payment_deadline: "2", total_due: "45000000", total_claimable: "45000000", position_count: 1, positions_hash: "b".repeat(64),
    positions: [{ account_id: A, net: "-35000000", role: "debtor", status: "due", amount: "35000000", outstanding_debt: "35000000" }],
  };

  it("TC-SD-080-06 clearing_applied of 0.0.13 has edge_count and edges_hash and no edges or chunk; epoch_committed has position_count, positions_hash and the complete positions", () => {
    const a = one(log("clearing_applied", applied, "0.0.13")) as Extract<X207Event, { event: "clearing_applied" }>;
    expect(a).toMatchObject({ event: "clearing_applied", edge_count: 300, edges_hash: "a".repeat(64), solver: B });
    expect(a.edges).toBeUndefined();
    expect(a.chunk).toBeUndefined();
    const c = one(log("epoch_committed", committed, "0.0.13")) as Extract<X207Event, { event: "epoch_committed" }>;
    expect(c).toMatchObject({ position_count: 1, positions_hash: "b".repeat(64) });
    expect(c.positions).toHaveLength(1);
    expect(c.chunk).toBeUndefined();
  });

  it("TC-SD-080-07 a missing edge_count, edges_hash, position_count or positions_hash in 0.0.13 is an error", () => {
    for (const field of ["edge_count", "edges_hash"]) {
      const rest: Record<string, unknown> = { ...applied };
      delete rest[field];
      expect(() => parseEventLog(log("clearing_applied", rest, "0.0.13")), field).toThrow(EventParseError);
    }
    for (const field of ["position_count", "positions_hash"]) {
      const rest: Record<string, unknown> = { ...committed };
      delete rest[field];
      expect(() => parseEventLog(log("epoch_committed", rest, "0.0.13")), field).toThrow(EventParseError);
    }
  });

  it("TC-SD-080-08 the shapes of 0.0.12 and older are still read: edges, chunk and chunks; a 0.0.12 event with the 0.0.13 shape is an error", () => {
    const legacy = { epoch: 42, solver: B, cleared_total: "1", edges: [{ debtor: A, creditor: B, cleared: "1" }], clearing_fee: "0", solver_fee: "0", chunk: 0, chunks: 2 };
    const a = one(log("clearing_applied", legacy, "0.0.12")) as Extract<X207Event, { event: "clearing_applied" }>;
    expect(a).toMatchObject({ chunk: 0, chunks: 2 });
    expect(a.edges).toHaveLength(1);
    expect(a.edge_count).toBeUndefined();
    expect(() => parseEventLog(log("clearing_applied", applied, "0.0.12"))).toThrow(EventParseError);
    expect(() => parseEventLog(log("clearing_applied", legacy, "0.0.13"))).toThrow(EventParseError);
  });

  it("TC-SD-080-09 positions_hash of a committed event is the hash of its positions", () => {
    const c = one(log("epoch_committed", { ...committed, positions_hash: positionsHash(committed.positions as EpochCommittedPosition[]) }, "0.0.13")) as Extract<X207Event, { event: "epoch_committed" }>;
    expect(positionsHash(c.positions)).toBe(c.positions_hash);
  });
});

describe("SD-080 get_proposal in pages", () => {
  const edges: ClearingAppliedEdge[] = Array.from({ length: 7 }, (_, i) => ({ debtor: `d${i}.near`, creditor: `c${i}.near`, cleared: String(i + 1) }));
  const sorted = (): ClearingAppliedEdge[] => JSON.parse(edgesCanonical(edges)) as ClearingAppliedEdge[];
  const viewOf = (store: ClearingAppliedEdge[] | null, calls: Array<Record<string, unknown>> = []) => async (method: string, args: object): Promise<unknown> => {
    expect(method).toBe("get_proposal");
    calls.push(args as Record<string, unknown>);
    if (store === null) return null;
    const { from_index, limit } = args as { from_index: number; limit: number };
    return { solver: B, cleared_total: "28", edge_count: store.length, edges: store.slice(from_index, from_index + limit) } satisfies ProposalPage;
  };

  it("TC-SD-080-10 getProposalPage sends epoch, from_index and limit; readProposal reads every page and the edges hash to the edges_hash of the event", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const store = sorted();
    expect(await getProposalPage(viewOf(store, calls), 42, 2, 3)).toMatchObject({ edge_count: 7, edges: store.slice(2, 5) });
    expect(calls[0]).toEqual({ epoch: 42, from_index: 2, limit: 3 });
    calls.length = 0;
    const all = await readProposal(viewOf(store, calls), 42, { pageLimit: 3, expectedEdgesHash: edgesHash(edges) });
    expect(all!.edges).toEqual(store);
    expect(calls.map((c) => c.from_index)).toEqual([0, 3, 6]);
  });

  it("TC-SD-080-11 edges that do not hash to the edges_hash of the event are refused, a proposal that ends early is an error, and no proposal is null", async () => {
    const store = sorted();
    const tampered = store.map((e, i) => (i === 3 ? { ...e, cleared: "999" } : e));
    await expect(readProposal(viewOf(tampered), 42, { pageLimit: 3, expectedEdgesHash: edgesHash(edges) })).rejects.toThrow(/do not hash/);
    const short = async (_m: string, args: object): Promise<unknown> =>
      (args as { from_index: number }).from_index === 0 ? { solver: B, cleared_total: "1", edge_count: 7, edges: store.slice(0, 3) } : { solver: B, cleared_total: "1", edge_count: 7, edges: [] };
    await expect(readProposal(short, 42, { pageLimit: 3 })).rejects.toThrow(/ended at 3 of 7/);
    expect(await readProposal(viewOf(null), 42)).toBeNull();
  });
});
