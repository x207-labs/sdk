import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventParseError, isKnownX207Event, parseEventLog, type X207Event } from "@x207/core";

const abi = JSON.parse(
  readFileSync(fileURLToPath(new URL("../abi/x207-circle.abi.json", import.meta.url)), "utf8"),
) as { events: { name: string; fields: string[]; list_item_fields?: string[] }[] };

const A = "translator.x207-circle.near";
const B = "summarizer.x207-circle.near";
const log = (event: string, data: unknown, version = "0.0.1", standard = "x207") =>
  `EVENT_JSON:${JSON.stringify({ standard, version, event, data: Array.isArray(data) ? data : [data] })}`;
const one = (line: string) => {
  const events = parseEventLog(line);
  expect(events).toHaveLength(1);
  return events![0]!;
};

const PARAMS = {
  epoch_length: 3600, payment_window: 1800, proposal_window: 600, base_limit_ratio: 8000, limit_growth: 1000,
  limit_cap: "1000000000", limit_decay: 0, fees: { clearing_fee_bps: 0, solver_fee_bps: 0 }, admission: "open",
};

// Satu contoh log per event, field persis seperti Spec Antarmuka Kontrak bagian 6 dan abi.json 0.0.1.
const SAMPLES: Record<string, unknown> = {
  member_joined: { account_id: A, pubkey_voucher: "ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9", terms_hash: "a".repeat(64), status: "pending", joined_at: "1793500000000000000" },
  stake_added: { account_id: A, sender_id: A, amount: "50000000", stake: "50000000", limit: "40000000", status: "active" },
  voucher_registered: { payer: A, payee: B, epoch: 42, seq: 137, cumulative_amount: "2740000", delta: "20000", obligation: "2740000", outstanding_debt: "2740000", mode: "cumulative" },
  epoch_cutoff: { epoch: 42, closed_at: "1", proposal_deadline: "2", edge_count: 12, participant_count: 6, total_obligation: "2563380000", next_epoch: 43, next_cutoff_at: "3" },
  clearing_applied: { epoch: 42, solver: B, cleared_total: "180000000", edges: [{ debtor: A, creditor: B, cleared: "60000000" }], clearing_fee: "0", solver_fee: "0", chunk: 0, chunks: 1 },
  residual_paid: { epoch: 42, account_id: A, sender_id: A, amount: "35000000", refunded: "0", settled_history: "35000000" },
  member_defaulted: { epoch: 42, account_id: A, due: "35000000", from_stake: "35000000", from_reserve: "0", shortfall: "0", stake: "15000000", status: "suspended", position_status: "defaulted", outstanding_debt: "0" },
  limits_updated: { epoch: 42, changes: [{ account_id: A, old_limit: "40000000", new_limit: "42000000", status: "active" }], chunk: 0, chunks: 1 },
  params_updated: { old: PARAMS, new: { ...PARAMS, limit_decay: 100 }, changed: ["limit_decay"], effective_epoch: 44 },
  exit_requested: { account_id: A, epoch: 42 },
  stake_withdrawn: { account_id: A, amount: "50000000" },
  stake_withdraw_failed: { account_id: A, amount: "50000000" },
  member_reactivated: { account_id: A, stake: "50000000", limit: "40000000", effective_epoch: 44 },
  solver_fee_claimed: { account_id: B, amount: "150000" },
  intent_posted: { intent_hash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrZb9rXzFaVzJ", account_id: A, posted_at: "1793900000000000000" },
  upgrade_proposed: { code_hash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrZb9rXzFaVzJ", eta: "1793900000000000000" },
  upgrade_applied: { code_hash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrZb9rXzFaVzJ", applied_at: "1793990000000000000" },
  solver_fee_claim_failed: { account_id: B, amount: "150000" },
  bundle_committed: { bundle_id: "b1", terms_hash: "b".repeat(64), epoch: 42, legs: [{ payer: A, payee: B, max_amount: "1000000" }], solver: B },
  // event P0 lain di abi 0.0.1 dan member_admitted (spec)
  member_admitted: { account_id: A, status: "active" },
  clearing_submitted: { epoch: 42, solver: B, cleared_total: "180000000", edge_count: 3, replaced_solver: null, replaced_cleared_total: null },
  epoch_committed: { epoch: 42, committed_at: "1", payment_deadline: "2", total_due: "45000000", total_claimable: "45000000", positions: [{ account_id: A, net: "-35000000", role: "debtor", status: "due", amount: "35000000", outstanding_debt: "35000000" }, { account_id: B, net: "0", role: "none", status: null, amount: "0", outstanding_debt: "0" }], chunk: 0, chunks: 1 },
  epoch_finalized: { epoch: 42, finalized_at: "1", defaulted_count: 0, total_defaulted: "0", pool: "35000000", shortfall: "0" },
  residual_claimed: { epoch: 42, account_id: B, amount: "45000000", destination: "near", status: "claimed" },
  residual_claim_failed: { epoch: 42, account_id: B, amount: "45000000", destination: "intents", status: "claimable" },
};

describe("SD-011 parseEventLog", () => {
  it.each([
    ["TC-SD-011-01", "member_joined"],
    ["TC-SD-011-02", "stake_added"],
    ["TC-SD-011-03", "voucher_registered"],
    ["TC-SD-011-04", "epoch_cutoff"],
    ["TC-SD-011-06", "residual_paid"],
    ["TC-SD-011-07", "member_defaulted"],
    ["TC-SD-011-08", "limits_updated"],
    ["TC-SD-011-09", "params_updated"],
    ["TC-SD-011-10", "bundle_committed"],
    ["event abi lain", "member_admitted"],
    ["event abi lain", "clearing_submitted"],
    ["event abi lain", "epoch_committed"],
    ["event abi lain", "epoch_finalized"],
    ["event abi lain", "residual_claimed"],
    ["event abi lain", "residual_claim_failed"],
    ["TC-SD-011-05", "clearing_applied"],
  ])("%s %s menjadi objek bertipe", (_id, name) => {
    const event = one(log(name, SAMPLES[name]));
    expect(event).toEqual({ event: name, ...(SAMPLES[name] as object) });
    expect(isKnownX207Event(event)).toBe(true);
  });

  it("TC-SD-011-05 clearing_applied terpotong menghasilkan dua objek terpisah", () => {
    const base = SAMPLES.clearing_applied as Record<string, unknown>;
    const first = one(log("clearing_applied", { ...base, chunk: 0, chunks: 2 }));
    const second = one(log("clearing_applied", { ...base, chunk: 1, chunks: 2 }));
    expect(first).toMatchObject({ chunk: 0, chunks: 2 });
    expect(second).toMatchObject({ chunk: 1, chunks: 2 });
    const edges = (first as Extract<X207Event, { event: "clearing_applied" }>).edges;
    expect(edges.every((e) => BigInt(e.cleared) > 0n)).toBe(true);
  });

  it("epoch_committed memuat peserta net 0 dengan role none dan status null (K-35)", () => {
    const event = one(log("epoch_committed", SAMPLES.epoch_committed)) as Extract<X207Event, { event: "epoch_committed" }>;
    expect(event.positions[1]).toEqual({ account_id: B, net: "0", role: "none", status: null, amount: "0", outstanding_debt: "0" });
  });

  it("TC-SD-011-11 data berisi dua objek mengembalikan dua objek", () => {
    const events = parseEventLog(log("stake_added", [SAMPLES.stake_added, { ...(SAMPLES.stake_added as object), amount: "1" }]));
    expect(events).toHaveLength(2);
    expect(events![1]).toMatchObject({ event: "stake_added", amount: "1" });
  });

  it("TC-SD-011-12 log bukan event menghasilkan null", () => {
    expect(parseEventLog("Transfer 10 from a to b")).toBeNull();
    expect(parseEventLog("")).toBeNull();
  });

  it("TC-SD-011-13 standar lain menghasilkan null", () => {
    expect(parseEventLog('EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{}]}')).toBeNull();
  });

  it("TC-SD-011-14 versi minor lebih tinggi ditolak, patch lebih tinggi diterima", () => {
    expect(() => parseEventLog(log("stake_added", SAMPLES.stake_added, "0.1.0"))).toThrow(EventParseError);
    expect(() => parseEventLog(log("stake_added", SAMPLES.stake_added, "1.0.0"))).toThrow(/versi/);
    expect(() => parseEventLog(log("stake_added", SAMPLES.stake_added, "0.0.2"))).not.toThrow();
  });

  it("TC-SD-011-15 field tak dikenal diabaikan", () => {
    const event = one(log("stake_added", { ...(SAMPLES.stake_added as object), extra_field: "x" }));
    expect(event).toEqual({ event: "stake_added", ...(SAMPLES.stake_added as object) });
    expect("extra_field" in event).toBe(false);
  });

  it("TC-SD-011-16 JSON rusak melempar EventParseError", () => {
    expect(() => parseEventLog('EVENT_JSON:{"standard":')).toThrow(EventParseError);
  });

  it("field wajib hilang atau salah tipe melempar EventParseError", () => {
    const { amount: _amount, ...missing } = SAMPLES.stake_added as Record<string, unknown>;
    expect(() => parseEventLog(log("stake_added", missing))).toThrow(/amount/);
    expect(() => parseEventLog(log("stake_added", { ...(SAMPLES.stake_added as object), amount: 5 }))).toThrow(/amount/);
    expect(() => parseEventLog(log("stake_added", { ...(SAMPLES.stake_added as object), status: "pending_stake" }))).toThrow(/status/);
    expect(() => parseEventLog(log("stake_added", []))).toThrow(EventParseError);
    expect(() => parseEventLog('EVENT_JSON:[1]')).toThrow(EventParseError);
  });

  it("event yang belum dikenal diteruskan apa adanya", () => {
    const event = one(log("future_event", { account_id: A, epoch: 42 }));
    expect(event).toEqual({ event: "future_event", data: { account_id: A, epoch: 42 } });
    expect(isKnownX207Event(event)).toBe(false);
  });

  it("skema parser cocok dengan abi.json 0.0.6 untuk setiap event yang dikenal", () => {
    const known = new Set(Object.keys(SAMPLES));
    const inAbi = abi.events.filter((e) => known.has(e.name));
    expect(inAbi.length).toBe(abi.events.length);
    for (const spec of inAbi) {
      const sample = SAMPLES[spec.name] as Record<string, unknown>;
      expect(Object.keys(sample).sort(), spec.name).toEqual([...spec.fields].sort());
      for (const field of Object.keys(sample)) expect(parseEventLog(log(spec.name, sample))![0], spec.name).toHaveProperty(field);
      if (spec.list_item_fields) {
        const list = Object.values(sample).find((v) => Array.isArray(v)) as Record<string, unknown>[];
        expect(Object.keys(list[0]!).sort(), spec.name).toEqual([...spec.list_item_fields].sort());
      }
    }
    for (const name of ["exit_requested", "stake_withdrawn", "stake_withdraw_failed"]) {
      expect(abi.events.some((e) => e.name === name)).toBe(true);
    }
  });
});
