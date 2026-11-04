import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Edge = { debtor: string; creditor: string; cleared: string };
type Snapshot = { obligations: { debtor: string; creditor: string; amount: string }[] };
type Vector = {
  name: string;
  input: { epoch: number; snapshot: Snapshot; edges: Edge[] };
  expected: Record<string, unknown> & { valid: boolean; reason: string | null };
};

const dir = fileURLToPath(new URL("../../../spec/test-vectors/clearing/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const load = (file: string) => JSON.parse(readFileSync(`${dir}${file}`, "utf8")) as Vector;
const U128 = /^(0|[1-9]\d*)$/;
const pair = (debtor: string, creditor: string) => `${debtor}\u0000${creditor}`;

/** Reference verifier following Contract Interface Spec 3.6 / 4.7 (order of checks per edge, then member balance). */
function simulate({ snapshot, edges }: Vector["input"]) {
  const base = { cleared_total: "0", edge_count: edges.length, better_than_current: false };
  const fail = (reason: string) => ({ ...base, valid: false, reason });
  if (edges.length === 0) return fail("ERR_EMPTY_PROPOSAL");
  const obligation = new Map(snapshot.obligations.map((o) => [pair(o.debtor, o.creditor), BigInt(o.amount)]));
  const seen = new Set<string>();
  const balance = new Map<string, bigint>();
  let total = 0n;
  for (const edge of edges) {
    const key = pair(edge.debtor, edge.creditor);
    const cleared = BigInt(edge.cleared);
    if (cleared === 0n) return fail("ERR_ZERO_CLEARED");
    if (seen.has(key)) return fail("ERR_DUPLICATE_EDGE");
    seen.add(key);
    const owed = obligation.get(key);
    if (owed === undefined) return fail("ERR_EDGE_NOT_IN_SNAPSHOT");
    if (cleared > owed) return fail("ERR_CLEARED_EXCEEDS_OBLIGATION");
    balance.set(edge.creditor, (balance.get(edge.creditor) ?? 0n) + cleared);
    balance.set(edge.debtor, (balance.get(edge.debtor) ?? 0n) - cleared);
    total += cleared;
  }
  for (const account of [...balance.keys()].sort()) {
    if (balance.get(account) !== 0n) return fail(`ERR_UNBALANCED_MEMBER: ${account}`);
  }
  return { ...base, valid: true, cleared_total: total.toString(), better_than_current: true, reason: null };
}

function net(snapshot: Snapshot, edges: Edge[]) {
  const cleared = new Map(edges.map((e) => [pair(e.debtor, e.creditor), BigInt(e.cleared)]));
  const out: Record<string, bigint> = {};
  for (const o of snapshot.obligations) {
    const left = BigInt(o.amount) - (cleared.get(pair(o.debtor, o.creditor)) ?? 0n);
    out[o.creditor] = (out[o.creditor] ?? 0n) + left;
    out[o.debtor] = (out[o.debtor] ?? 0n) - left;
  }
  return out;
}
const netBefore = (snapshot: Snapshot) => net(snapshot, []);
const asStrings = (m: Record<string, bigint>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toString()]));

describe("SD-009 clearing test vectors", () => {
  it("the expected files exist", () => {
    expect(files).toEqual(["cleared_exceeds_obligation.json", "unbalanced_member.json", "valid.json"]);
  });

  it("TC-SD-009-01 a valid proposal, net positions unchanged", () => {
    const { input, expected } = load("valid.json");
    const result = simulate(input);
    expect(result.valid).toBe(true);
    expect(expected.valid).toBe(true);
    expect(result.cleared_total).toBe(expected.cleared_total);
    const sum = input.edges.reduce((acc, e) => acc + BigInt(e.cleared), 0n);
    expect(expected.cleared_total).toBe(sum.toString());
    expect(result.edge_count).toBe(expected.edge_count);
    expect(result.better_than_current).toBe(expected.better_than_current);
    const before = asStrings(netBefore(input.snapshot));
    const after = asStrings(net(input.snapshot, input.edges));
    expect(after).toEqual(before);
    expect(expected.net_before).toEqual(before);
    expect(expected.net_after).toEqual(after);
    expect(Object.values(netBefore(input.snapshot)).reduce((a, b) => a + b, 0n)).toBe(0n);
  });

  it("TC-SD-009-02 cleared exceeds the obligation", () => {
    const { input, expected } = load("cleared_exceeds_obligation.json");
    const result = simulate(input);
    expect(expected.valid).toBe(false);
    expect(expected.reason).toMatch(/^ERR_CLEARED_EXCEEDS_OBLIGATION/);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/^ERR_CLEARED_EXCEEDS_OBLIGATION/);
  });

  it("TC-SD-009-03 Σ in != Σ out", () => {
    const { input, expected } = load("unbalanced_member.json");
    const result = simulate(input);
    expect(expected.valid).toBe(false);
    expect(expected.reason).toMatch(/^ERR_UNBALANCED_MEMBER/);
    expect(result.reason).toMatch(/^ERR_UNBALANCED_MEMBER/);
  });

  it("TC-SD-009-04 internal consistency of all files", () => {
    for (const file of files) {
      const { input, expected } = load(file);
      const known = new Set(input.snapshot.obligations.map((o) => pair(o.debtor, o.creditor)));
      for (const edge of input.edges) {
        expect(known.has(pair(edge.debtor, edge.creditor)), `${file} edge in the snapshot`).toBe(true);
        expect(edge.cleared, file).toMatch(U128);
      }
      for (const o of input.snapshot.obligations) expect(o.amount, file).toMatch(U128);
      expect(expected.cleared_total, file).toMatch(U128);
      expect(Object.keys(expected)).toEqual(
        expect.arrayContaining(["valid", "cleared_total", "edge_count", "reason"]),
      );
      expect(typeof expected.valid).toBe("boolean");
      expect(expected.edge_count).toBe(input.edges.length);
      expect(expected.reason === null || typeof expected.reason === "string").toBe(true);
      expect(simulate(input).valid, file).toBe(expected.valid);
    }
  });
});
