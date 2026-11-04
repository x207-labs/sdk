// NEP-297 event parser for the `x207-circle` contract (SD-011, Contract Interface Spec section 6).
// Log: `EVENT_JSON:{"standard":"x207","version":"0.0.9","event":"<nama>","data":[{…}]}`.
import type { Params } from "./contract/types.generated.js";
import type { AccountId, U128String } from "./types.js";

export const EVENT_PREFIX = "EVENT_JSON:";
export const EVENT_STANDARD = "x207";
/** Event interface version known to the parser (Spec 1, item 3). */
export const KNOWN_EVENT_VERSION = "0.0.13";

export class EventParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventParseError";
  }
}

type Ns = string; // timestamp in nanoseconds as a string
type MemberStatusValue = "pending" | "active" | "suspended" | "exited";
type AssetClassValue = "A" | "B" | "C" | "D" | "X";
type EscrowStepValue = "complete" | "cancel";
type PositionStatusValue = "due" | "paid" | "defaulted" | "claimable" | "claimed";

export type ClearingAppliedEdge = { debtor: AccountId; creditor: AccountId; cleared: U128String };
export type EpochCommittedPosition = {
  account_id: AccountId;
  net: string;
  role: "debtor" | "creditor" | "none";
  status: PositionStatusValue | null;
  amount: U128String;
  outstanding_debt: U128String;
};
export type LimitChange = { account_id: AccountId; old_limit: U128String; new_limit: U128String; status: MemberStatusValue };
export type BundleLeg = { payer: AccountId; payee: AccountId; max_amount: U128String };

export type X207EventMap = {
  member_joined: { account_id: AccountId; pubkey_voucher: string; terms_hash: string; status: "pending"; joined_at: Ns };
  stake_added: { account_id: AccountId; sender_id: AccountId; amount: U128String; stake: U128String; limit: U128String; status: MemberStatusValue };
  member_admitted: { account_id: AccountId; status: MemberStatusValue };
  voucher_registered: {
    payer: AccountId; payee: AccountId; epoch: number; seq: number; cumulative_amount: U128String;
    delta: U128String; obligation: U128String; outstanding_debt: U128String; mode: "cumulative" | "per_request";
  };
  epoch_cutoff: {
    epoch: number; closed_at: Ns; proposal_deadline: Ns; edge_count: number; participant_count: number;
    total_obligation: U128String; next_epoch: number; next_cutoff_at: Ns;
  };
  clearing_submitted: {
    epoch: number; solver: AccountId; cleared_total: U128String; edge_count: number;
    replaced_solver: AccountId | null; replaced_cleared_total: U128String | null;
  };
  /**
   * Interface 0.0.13 (CT-099): `edge_count` and `edges_hash` (`edgesHash`), no edges in the event. Read the edges of a proposal that is not committed yet with the view
   * `get_proposal` and after the commit from `list_obligations`. Interface 0.0.12 and older (the version of the envelope): `edges`, `chunk` and `chunks` instead, and no
   * `edge_count` or `edges_hash`.
   */
  clearing_applied: {
    epoch: number; solver: AccountId | null; cleared_total: U128String; clearing_fee: U128String; solver_fee: U128String;
    edge_count?: number; edges_hash?: string; edges?: ClearingAppliedEdge[]; chunk?: number; chunks?: number;
  };
  /**
   * Interface 0.0.13: the complete `positions` (at most `MAX_MEMBERS`), `position_count` and `positions_hash` (`positionsHash`), no `chunk`. Older: `positions` in chunks and no
   * `position_count` or `positions_hash`.
   */
  epoch_committed: {
    epoch: number; committed_at: Ns; payment_deadline: Ns; total_due: U128String; total_claimable: U128String;
    positions: EpochCommittedPosition[]; position_count?: number; positions_hash?: string; chunk?: number; chunks?: number;
  };
  residual_paid: {
    epoch: number; account_id: AccountId; sender_id: AccountId; amount: U128String; refunded: U128String;
    settled_history: U128String;
  };
  member_defaulted: {
    epoch: number; account_id: AccountId; due: U128String; from_stake: U128String; from_reserve: U128String;
    shortfall: U128String; stake: U128String; status: "suspended"; position_status: "defaulted";
    outstanding_debt: U128String;
  };
  limits_updated: { epoch: number; changes: LimitChange[]; chunk: number; chunks: number };
  epoch_finalized: {
    epoch: number; finalized_at: Ns; defaulted_count: number; total_defaulted: U128String; pool: U128String;
    shortfall: U128String;
  };
  residual_claimed: { epoch: number; account_id: AccountId; amount: U128String; destination: "near" | "intents"; status: "claimed" };
  residual_claim_failed: { epoch: number; account_id: AccountId; amount: U128String; destination: "near" | "intents"; status: "claimable" };
  params_updated: { old: Params; new: Params; changed: string[]; effective_epoch: number };
  exit_requested: { account_id: AccountId; epoch: number };
  stake_withdrawn: { account_id: AccountId; amount: U128String };
  stake_withdraw_failed: { account_id: AccountId; amount: U128String };
  member_reactivated: { account_id: AccountId; stake: U128String; limit: U128String; effective_epoch: number };
  solver_fee_claimed: { account_id: AccountId; amount: U128String };
  solver_fee_claim_failed: { account_id: AccountId; amount: U128String };
  intent_posted: { intent_hash: string; account_id: AccountId; posted_at: string };
  upgrade_proposed: { code_hash: string; eta: string };
  upgrade_applied: { code_hash: string; applied_at: string };
  asset_class_set: { asset_type: string; class: AssetClassValue };
  grant_offered: { grant_id: number; asset_type: string; grantor: AccountId; class: AssetClassValue; unit: string; unit_price: U128String; expires_at: string };
  grant_activated: { grant_id: number; grantee: AccountId; delivery_pubkey: string | null };
  grant_revoked: { grant_id: number; reason: "grantor" | "grantee" | "operator" | "expired" | "defaulted" };
  escrow_held: { grant_id: number; nft_contract: AccountId; token_id: string };
  ft_escrow_held: { grant_id: number; ft_contract: AccountId; amount: U128String };
  mt_escrow_held: { grant_id: number; mt_contract: AccountId; token_id: string; amount: U128String };
  escrow_failed: { grant_id: number; step: EscrowStepValue; epoch: number; payer: AccountId; payee: AccountId; delta: U128String; reverted: boolean };
  intent_removed: { intent_hash: string; account_id: AccountId };
  intents_withdrawn: { amount: U128String };
  bundle_committed: { bundle_id: string | number; terms_hash: string; epoch: number; legs: BundleLeg[]; solver: AccountId };
  // interface 0.0.12 (SD-073): freeze of a member (CT-095), official contracts of an asset type (CT-096), deal with a bond and an arbiter (CT-094)
  freeze_proposed: { account_id: AccountId; eta: Ns; reason_hash: string | null };
  member_frozen: { account_id: AccountId; from_epoch: number };
  freeze_cancelled: { account_id: AccountId };
  member_unfrozen: { account_id: AccountId };
  asset_contracts_set: { asset_type: string; contracts: AccountId[] };
  bond_locked: { bundle_id: string | number; account_id: AccountId; amount: U128String };
  deal_confirmed: { bundle_id: string | number; account_id: AccountId; of: AccountId };
  deal_disputed: { bundle_id: string | number; complainant: AccountId; accused: AccountId; evidence_hash: string; disputed_at: Ns };
  deal_ruled: { bundle_id: string | number; arbiter: AccountId; verdict: "accused_guilty" | "complaint_false" | "no_fault" };
  bond_slashed: { bundle_id: string | number; from: AccountId; to: AccountId; amount: U128String; from_stake: U128String; to_stake: U128String };
  bond_released: { bundle_id: string | number; account_id: AccountId; amount: U128String; reason: "confirmed" | "elapsed" | "arbiter_silent" | "ruling" };
};

export type X207EventName = keyof X207EventMap;
export type X207Event = { [K in X207EventName]: { event: K } & X207EventMap[K] }[X207EventName];

/** Event not yet known to the parser (next patch or SD-054); its data is passed on as is. */
export type UnknownX207Event = { event: string; data: Record<string, unknown> };

// --- field schema ---
type Kind =
  | "str" | "int" | "bool" | "strnull" | "strarr" | "params" | "bundleid"
  | { enum: readonly (string | null)[] }
  | { list: Schema };
type Schema = Record<string, Kind>;

const MEMBER_STATUS = { enum: ["pending", "active", "suspended", "exited"] } as const;
const POSITION_STATUS = { enum: ["due", "paid", "defaulted", "claimable", "claimed", null] } as const;
const POSITION_FIELDS: Schema = {
  account_id: "str", net: "str", role: { enum: ["debtor", "creditor", "none"] }, status: POSITION_STATUS, amount: "str", outstanding_debt: "str",
};
const DESTINATION = { enum: ["near", "intents"] } as const;

/** The shapes of interface 0.0.12 and older (chunks, edges in the event), read when the envelope says a version below 0.0.13. */
const LEGACY_SCHEMAS: Partial<Record<X207EventName, Schema>> = {
  clearing_applied: {
    epoch: "int", solver: "strnull", cleared_total: "str", edges: { list: { debtor: "str", creditor: "str", cleared: "str" } }, clearing_fee: "str", solver_fee: "str", chunk: "int", chunks: "int",
  },
  epoch_committed: {
    epoch: "int", committed_at: "str", payment_deadline: "str", total_due: "str", total_claimable: "str", positions: { list: POSITION_FIELDS }, chunk: "int", chunks: "int",
  },
};
const isLegacyVersion = (version: string): boolean => {
  const [major, minor] = version.split(".").map(Number) as [number, number, number];
  return major === 0 && minor === 0 && Number(version.split(".")[2]) < 13;
};

const SCHEMAS: { [K in X207EventName]: Schema } = {
  member_joined: { account_id: "str", pubkey_voucher: "str", terms_hash: "str", status: { enum: ["pending"] }, joined_at: "str" },
  stake_added: { account_id: "str", sender_id: "str", amount: "str", stake: "str", limit: "str", status: MEMBER_STATUS },
  member_admitted: { account_id: "str", status: MEMBER_STATUS },
  exit_requested: { account_id: "str", epoch: "int" },
  stake_withdrawn: { account_id: "str", amount: "str" },
  stake_withdraw_failed: { account_id: "str", amount: "str" },
  member_reactivated: { account_id: "str", stake: "str", limit: "str", effective_epoch: "int" },
  solver_fee_claimed: { account_id: "str", amount: "str" },
  solver_fee_claim_failed: { account_id: "str", amount: "str" },
  intent_posted: { intent_hash: "str", account_id: "str", posted_at: "str" },
  asset_class_set: { asset_type: "str", class: { enum: ["A", "B", "C", "D", "X"] } },
  grant_offered: {
    grant_id: "int", asset_type: "str", grantor: "str", class: { enum: ["A", "B", "C", "D", "X"] }, unit: "str", unit_price: "str", expires_at: "str",
  },
  grant_activated: { grant_id: "int", grantee: "str", delivery_pubkey: "strnull" },
  grant_revoked: { grant_id: "int", reason: { enum: ["grantor", "grantee", "operator", "expired", "defaulted"] } },
  upgrade_proposed: { code_hash: "str", eta: "str" },
  upgrade_applied: { code_hash: "str", applied_at: "str" },
  voucher_registered: {
    payer: "str", payee: "str", epoch: "int", seq: "int", cumulative_amount: "str", delta: "str",
    obligation: "str", outstanding_debt: "str", mode: { enum: ["cumulative", "per_request"] },
  },
  epoch_cutoff: {
    epoch: "int", closed_at: "str", proposal_deadline: "str", edge_count: "int", participant_count: "int",
    total_obligation: "str", next_epoch: "int", next_cutoff_at: "str",
  },
  clearing_submitted: {
    epoch: "int", solver: "str", cleared_total: "str", edge_count: "int", replaced_solver: "strnull",
    replaced_cleared_total: "strnull",
  },
  // the interface 0.0.13 shape; `LEGACY_SCHEMAS` below has the shape of 0.0.12 and older, chosen by the version of the envelope
  clearing_applied: { epoch: "int", solver: "strnull", cleared_total: "str", edge_count: "int", edges_hash: "str", clearing_fee: "str", solver_fee: "str" },
  epoch_committed: {
    epoch: "int", committed_at: "str", payment_deadline: "str", total_due: "str", total_claimable: "str", position_count: "int", positions_hash: "str",
    positions: { list: POSITION_FIELDS },
  },
  residual_paid: { epoch: "int", account_id: "str", sender_id: "str", amount: "str", refunded: "str", settled_history: "str" },
  member_defaulted: {
    epoch: "int", account_id: "str", due: "str", from_stake: "str", from_reserve: "str", shortfall: "str",
    stake: "str", status: { enum: ["suspended"] }, position_status: { enum: ["defaulted"] }, outstanding_debt: "str",
  },
  limits_updated: {
    epoch: "int",
    changes: { list: { account_id: "str", old_limit: "str", new_limit: "str", status: MEMBER_STATUS } },
    chunk: "int", chunks: "int",
  },
  epoch_finalized: {
    epoch: "int", finalized_at: "str", defaulted_count: "int", total_defaulted: "str", pool: "str", shortfall: "str",
  },
  residual_claimed: { epoch: "int", account_id: "str", amount: "str", destination: DESTINATION, status: { enum: ["claimed"] } },
  residual_claim_failed: { epoch: "int", account_id: "str", amount: "str", destination: DESTINATION, status: { enum: ["claimable"] } },
  params_updated: { old: "params", new: "params", changed: "strarr", effective_epoch: "int" },
  escrow_held: { grant_id: "int", nft_contract: "str", token_id: "str" },
  ft_escrow_held: { grant_id: "int", ft_contract: "str", amount: "str" },
  mt_escrow_held: { grant_id: "int", mt_contract: "str", token_id: "str", amount: "str" },
  escrow_failed: {
    grant_id: "int", step: { enum: ["complete", "cancel"] }, epoch: "int", payer: "str", payee: "str", delta: "str", reverted: "bool",
  },
  intent_removed: { intent_hash: "str", account_id: "str" },
  intents_withdrawn: { amount: "str" },
  bundle_committed: {
    bundle_id: "bundleid", terms_hash: "str", epoch: "int",
    legs: { list: { payer: "str", payee: "str", max_amount: "str" } }, solver: "str",
  },
  freeze_proposed: { account_id: "str", eta: "str", reason_hash: "strnull" },
  member_frozen: { account_id: "str", from_epoch: "int" },
  freeze_cancelled: { account_id: "str" },
  member_unfrozen: { account_id: "str" },
  asset_contracts_set: { asset_type: "str", contracts: "strarr" },
  bond_locked: { bundle_id: "bundleid", account_id: "str", amount: "str" },
  deal_confirmed: { bundle_id: "bundleid", account_id: "str", of: "str" },
  deal_disputed: { bundle_id: "bundleid", complainant: "str", accused: "str", evidence_hash: "str", disputed_at: "str" },
  deal_ruled: { bundle_id: "bundleid", arbiter: "str", verdict: { enum: ["accused_guilty", "complaint_false", "no_fault"] } },
  bond_slashed: { bundle_id: "bundleid", from: "str", to: "str", amount: "str", from_stake: "str", to_stake: "str" },
  bond_released: { bundle_id: "bundleid", account_id: "str", amount: "str", reason: { enum: ["confirmed", "elapsed", "arbiter_silent", "ruling"] } },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readField(value: unknown, kind: Kind, path: string): unknown {
  const fail = (expected: string): never => {
    throw new EventParseError(`field ${path} must be ${expected}`);
  };
  if (typeof kind === "object" && "enum" in kind) {
    return kind.enum.includes(value as string | null) ? value : fail(`one of ${JSON.stringify(kind.enum)}`);
  }
  if (typeof kind === "object" && "list" in kind) {
    if (!Array.isArray(value)) return fail("array");
    return value.map((item, i) => readObject(item, kind.list, `${path}[${i}]`));
  }
  switch (kind) {
    case "str": return typeof value === "string" ? value : fail("string");
    case "int": return Number.isSafeInteger(value) ? value : fail("integer");
    case "bool": return typeof value === "boolean" ? value : fail("boolean");
    case "strnull": return value === null || typeof value === "string" ? value : fail("string or null");
    case "strarr": return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : fail("array string");
    case "params": return isRecord(value) ? value : fail("Params object");
    case "bundleid": return typeof value === "string" || Number.isSafeInteger(value) ? value : fail("string or integer");
  }
}

/** Take only the known fields; extra fields are ignored (Spec 1, item 3). */
function readObject(value: unknown, schema: Schema, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new EventParseError(`${path} must be an object`);
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(schema)) {
    if (!(name in value)) throw new EventParseError(`field ${path}.${name} missing`);
    out[name] = readField(value[name], kind, `${path}.${name}`);
  }
  return out;
}

function checkVersion(version: unknown): void {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new EventParseError(`invalid event version: ${JSON.stringify(version)}`);
  }
  const [major, minor] = version.split(".").map(Number) as [number, number];
  const [knownMajor, knownMinor] = KNOWN_EVENT_VERSION.split(".").map(Number) as [number, number];
  if (major !== knownMajor || minor > knownMinor) {
    throw new EventParseError(`event version ${version} is higher than the known version (${KNOWN_EVENT_VERSION})`);
  }
}

const isKnownName = (name: string): name is X207EventName => Object.hasOwn(SCHEMAS, name);

export const isKnownX207Event = (event: X207Event | UnknownX207Event): event is X207Event =>
  isKnownName(event.event);

/**
 * Parse one contract log line. `null` for a log that is not `EVENT_JSON:` or has a `standard` other than `x207`;
 * `EventParseError` for broken JSON, a higher minor version, or a missing required field (K-34).
 * Returns one object per `data` element.
 */
export function parseEventLog(log: string): (X207Event | UnknownX207Event)[] | null {
  if (!log.startsWith(EVENT_PREFIX)) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(log.slice(EVENT_PREFIX.length));
  } catch (error) {
    throw new EventParseError(`malformed event JSON: ${(error as Error).message}`);
  }
  if (!isRecord(envelope)) throw new EventParseError("event must be a JSON object");
  if (envelope.standard !== EVENT_STANDARD) return null;
  checkVersion(envelope.version);
  const version = envelope.version as string;
  const name = envelope.event;
  if (typeof name !== "string") throw new EventParseError("event field missing");
  if (!Array.isArray(envelope.data) || envelope.data.length === 0) {
    throw new EventParseError("data must be an array with at least one object");
  }
  return envelope.data.map((item, i): X207Event | UnknownX207Event => {
    if (!isKnownName(name)) {
      if (!isRecord(item)) throw new EventParseError(`data[${i}] must be an object`);
      return { event: name, data: item };
    }
    const schema = (isLegacyVersion(version) ? LEGACY_SCHEMAS[name] : undefined) ?? SCHEMAS[name];
    return { event: name, ...readObject(item, schema, `data[${i}]`) } as X207Event;
  });
}
