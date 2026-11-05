import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventParseError, KNOWN_EVENT_VERSION, isKnownX207Event, parseEventLog, type X207Event } from "@x207/core";

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

// One sample log per event, fields exactly as in Contract Interface Spec section 6 and abi.json 0.0.1.
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
  asset_class_set: { asset_type: "near-rpc:access", class: "B" },
  grant_offered: { grant_id: 1, asset_type: "near-rpc:access", grantor: A, class: "B", unit: "call", unit_price: "10000", expires_at: "1793600000000000000" },
  grant_activated: { grant_id: 1, grantee: B, delivery_pubkey: null },
  grant_revoked: { grant_id: 1, reason: "defaulted" },
  intent_removed: { intent_hash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrZb9rXzFaVzJ", account_id: A },
  auto_settle_set: { account_id: A, enabled: true },
  auto_settled: { epoch: 4, account_id: A, due: "250", stake: "900", status: "active", position_status: "paid", outstanding_debt: "0" },
  intents_withdrawn: { amount: "1500000" },
  escrow_held: { grant_id: 1, nft_contract: "nft.test.near", token_id: "t1" },
  ft_escrow_held: { grant_id: 3, ft_contract: "rwa.near", amount: "2500000" },
  mt_escrow_held: { grant_id: 4, mt_contract: "mt.near", token_id: "nep141:usdt.tether-token.near", amount: "750000" },
  escrow_failed: { grant_id: 1, step: "complete", epoch: 42, payer: B, payee: A, delta: "10000000", reverted: true },
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
  // interface 0.0.12 (SD-073)
  freeze_proposed: { account_id: A, eta: "1793900000000000000", reason_hash: null },
  member_frozen: { account_id: A, from_epoch: 42 },
  freeze_cancelled: { account_id: A },
  member_unfrozen: { account_id: A },
  asset_contracts_set: { asset_type: "token:nep141", contracts: ["usdt.near", "usdc.near"] },
  bond_locked: { bundle_id: 1, account_id: A, amount: "20000000" },
  deal_confirmed: { bundle_id: 1, account_id: A, of: B },
  deal_disputed: { bundle_id: 1, complainant: A, accused: B, evidence_hash: "ab".repeat(32), disputed_at: "1793900000000000000" },
  deal_ruled: { bundle_id: 1, arbiter: "arbiter.near", verdict: "accused_guilty" },
  bond_slashed: { bundle_id: 1, from: B, to: A, amount: "20000000", from_stake: "80000000", to_stake: "120000000" },
  bond_released: { bundle_id: 1, account_id: A, amount: "20000000", reason: "ruling" },
  // other P0 events in abi 0.0.1 and member_admitted (spec)
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
    ["another abi event", "member_admitted"],
    ["another abi event", "clearing_submitted"],
    ["another abi event", "epoch_committed"],
    ["another abi event", "epoch_finalized"],
    ["another abi event", "residual_claimed"],
    ["another abi event", "residual_claim_failed"],
    ["TC-SD-011-05", "clearing_applied"],
  ])("%s %s becomes a typed object", (_id, name) => {
    const event = one(log(name, SAMPLES[name]));
    expect(event).toEqual({ event: name, ...(SAMPLES[name] as object) });
    expect(isKnownX207Event(event)).toBe(true);
  });

  it("TC-SD-011-05 a truncated clearing_applied gives two separate objects", () => {
    const base = SAMPLES.clearing_applied as Record<string, unknown>;
    const first = one(log("clearing_applied", { ...base, chunk: 0, chunks: 2 }));
    const second = one(log("clearing_applied", { ...base, chunk: 1, chunks: 2 }));
    expect(first).toMatchObject({ chunk: 0, chunks: 2 });
    expect(second).toMatchObject({ chunk: 1, chunks: 2 });
    const edges = (first as Extract<X207Event, { event: "clearing_applied" }>).edges;
    expect(edges!.every((e) => BigInt(e.cleared) > 0n)).toBe(true);
  });

  it("epoch_committed contains participants with net 0, role none, and status null (K-35)", () => {
    const event = one(log("epoch_committed", SAMPLES.epoch_committed)) as Extract<X207Event, { event: "epoch_committed" }>;
    expect(event.positions[1]).toEqual({ account_id: B, net: "0", role: "none", status: null, amount: "0", outstanding_debt: "0" });
  });

  it("TC-SD-011-11 data with two objects returns two objects", () => {
    const events = parseEventLog(log("stake_added", [SAMPLES.stake_added, { ...(SAMPLES.stake_added as object), amount: "1" }]));
    expect(events).toHaveLength(2);
    expect(events![1]).toMatchObject({ event: "stake_added", amount: "1" });
  });

  it("TC-SD-011-12 a log that is not an event gives null", () => {
    expect(parseEventLog("Transfer 10 from a to b")).toBeNull();
    expect(parseEventLog("")).toBeNull();
  });

  it("TC-SD-011-13 another standard gives null", () => {
    expect(parseEventLog('EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{}]}')).toBeNull();
  });

  it("TC-SD-011-14 a higher minor version is rejected, a higher patch is accepted", () => {
    expect(() => parseEventLog(log("stake_added", SAMPLES.stake_added, "0.1.0"))).toThrow(EventParseError);
    expect(() => parseEventLog(log("stake_added", SAMPLES.stake_added, "1.0.0"))).toThrow(/versi/);
    expect(() => parseEventLog(log("stake_added", SAMPLES.stake_added, "0.0.2"))).not.toThrow();
  });

  it("TC-SD-060-04 version 0.0.10 (two digit patch) is read by number, not by text: accepted, and the check ignores the patch of a higher version", () => {
    expect(KNOWN_EVENT_VERSION).toBe("0.0.13");
    for (const version of ["0.0.9", "0.0.10", "0.0.11", "0.0.12", "0.0.13", "0.0.100"]) {
      expect(() => parseEventLog(log("stake_added", SAMPLES.stake_added, version)), version).not.toThrow();
    }
    expect(() => parseEventLog(log("stake_added", SAMPLES.stake_added, "0.1.0"))).toThrow(EventParseError);
    // ft_escrow_held is in the schema table and is parsed under the version of the contract that emits it
    expect(one(log("ft_escrow_held", { grant_id: 1, ft_contract: "rwa.near", amount: "10" }, "0.0.10"))).toMatchObject({ event: "ft_escrow_held", amount: "10" });
  });

  it("TC-SD-011-15 an unknown field is ignored", () => {
    const event = one(log("stake_added", { ...(SAMPLES.stake_added as object), extra_field: "x" }));
    expect(event).toEqual({ event: "stake_added", ...(SAMPLES.stake_added as object) });
    expect("extra_field" in event).toBe(false);
  });

  it("TC-SD-011-16 malformed JSON throws EventParseError", () => {
    expect(() => parseEventLog('EVENT_JSON:{"standard":')).toThrow(EventParseError);
  });

  it("a missing required field or a wrong type throws EventParseError", () => {
    const { amount: _amount, ...missing } = SAMPLES.stake_added as Record<string, unknown>;
    expect(() => parseEventLog(log("stake_added", missing))).toThrow(/amount/);
    expect(() => parseEventLog(log("stake_added", { ...(SAMPLES.stake_added as object), amount: 5 }))).toThrow(/amount/);
    expect(() => parseEventLog(log("stake_added", { ...(SAMPLES.stake_added as object), status: "pending_stake" }))).toThrow(/status/);
    expect(() => parseEventLog(log("stake_added", []))).toThrow(EventParseError);
    expect(() => parseEventLog('EVENT_JSON:[1]')).toThrow(EventParseError);
  });

  it("an unknown event is passed through unchanged", () => {
    const event = one(log("future_event", { account_id: A, epoch: 42 }));
    expect(event).toEqual({ event: "future_event", data: { account_id: A, epoch: 42 } });
    expect(isKnownX207Event(event)).toBe(false);
  });

  // the two events whose shape changed in 0.0.13 (CT-099); SAMPLES keeps the shape of 0.0.12 for the tests of the legacy parse
const SAMPLES_0_0_13: Record<string, unknown> = {
  clearing_applied: { epoch: 42, solver: B, cleared_total: "180000000", edge_count: 1, edges_hash: "a".repeat(64), clearing_fee: "0", solver_fee: "0" },
  epoch_committed: {
    epoch: 42, committed_at: "1", payment_deadline: "2", total_due: "45000000", total_claimable: "45000000", position_count: 1, positions_hash: "b".repeat(64),
    positions: [{ account_id: A, net: "-35000000", role: "debtor", status: "due", amount: "35000000", outstanding_debt: "35000000" }],
  },
};

it("the parser schema matches abi.json 0.0.13 for every known event", () => {
    const known = new Set(Object.keys(SAMPLES));
    const inAbi = abi.events.filter((e) => known.has(e.name));
    expect(inAbi.length).toBe(abi.events.length);
    for (const spec of inAbi) {
      const sample = (SAMPLES_0_0_13[spec.name] ?? SAMPLES[spec.name]) as Record<string, unknown>;
      expect(Object.keys(sample).sort(), spec.name).toEqual([...spec.fields].sort());
      for (const field of Object.keys(sample)) expect(parseEventLog(log(spec.name, sample, "0.0.13"))![0], spec.name).toHaveProperty(field);
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
