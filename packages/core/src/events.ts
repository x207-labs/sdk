// Parser event NEP-297 kontrak `x207-circle` (SD-011, Spec Antarmuka Kontrak bagian 6).
// Log: `EVENT_JSON:{"standard":"x207","version":"0.0.9","event":"<nama>","data":[{…}]}`.
import type { Params } from "./contract/types.generated.js";
import type { AccountId, U128String } from "./types.js";

export const EVENT_PREFIX = "EVENT_JSON:";
export const EVENT_STANDARD = "x207";
/** Versi antarmuka event yang dikenal parser (Spec 1, butir 3). */
export const KNOWN_EVENT_VERSION = "0.0.9";

export class EventParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventParseError";
  }
}

type Ns = string; // timestamp nanodetik sebagai string
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
  clearing_applied: {
    epoch: number; solver: AccountId | null; cleared_total: U128String; edges: ClearingAppliedEdge[];
    clearing_fee: U128String; solver_fee: U128String; chunk: number; chunks: number;
  };
  epoch_committed: {
    epoch: number; committed_at: Ns; payment_deadline: Ns; total_due: U128String; total_claimable: U128String;
    positions: EpochCommittedPosition[]; chunk: number; chunks: number;
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
  escrow_failed: { grant_id: number; step: EscrowStepValue; epoch: number; payer: AccountId; payee: AccountId; delta: U128String; reverted: boolean };
  intent_removed: { intent_hash: string; account_id: AccountId };
  intents_withdrawn: { amount: U128String };
  bundle_committed: { bundle_id: string | number; terms_hash: string; epoch: number; legs: BundleLeg[]; solver: AccountId };
};

export type X207EventName = keyof X207EventMap;
export type X207Event = { [K in X207EventName]: { event: K } & X207EventMap[K] }[X207EventName];

/** Event yang belum dikenal parser (patch berikutnya atau SD-054); datanya diteruskan apa adanya. */
export type UnknownX207Event = { event: string; data: Record<string, unknown> };

// --- skema field ---
type Kind =
  | "str" | "int" | "bool" | "strnull" | "strarr" | "params" | "bundleid"
  | { enum: readonly (string | null)[] }
  | { list: Schema };
type Schema = Record<string, Kind>;

const MEMBER_STATUS = { enum: ["pending", "active", "suspended", "exited"] } as const;
const POSITION_STATUS = { enum: ["due", "paid", "defaulted", "claimable", "claimed", null] } as const;
const DESTINATION = { enum: ["near", "intents"] } as const;

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
  clearing_applied: {
    epoch: "int", solver: "strnull", cleared_total: "str",
    edges: { list: { debtor: "str", creditor: "str", cleared: "str" } },
    clearing_fee: "str", solver_fee: "str", chunk: "int", chunks: "int",
  },
  epoch_committed: {
    epoch: "int", committed_at: "str", payment_deadline: "str", total_due: "str", total_claimable: "str",
    positions: {
      list: {
        account_id: "str", net: "str", role: { enum: ["debtor", "creditor", "none"] }, status: POSITION_STATUS,
        amount: "str", outstanding_debt: "str",
      },
    },
    chunk: "int", chunks: "int",
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
  escrow_failed: {
    grant_id: "int", step: { enum: ["complete", "cancel"] }, epoch: "int", payer: "str", payee: "str", delta: "str", reverted: "bool",
  },
  intent_removed: { intent_hash: "str", account_id: "str" },
  intents_withdrawn: { amount: "str" },
  bundle_committed: {
    bundle_id: "bundleid", terms_hash: "str", epoch: "int",
    legs: { list: { payer: "str", payee: "str", max_amount: "str" } }, solver: "str",
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readField(value: unknown, kind: Kind, path: string): unknown {
  const fail = (expected: string): never => {
    throw new EventParseError(`field ${path} harus ${expected}`);
  };
  if (typeof kind === "object" && "enum" in kind) {
    return kind.enum.includes(value as string | null) ? value : fail(`salah satu dari ${JSON.stringify(kind.enum)}`);
  }
  if (typeof kind === "object" && "list" in kind) {
    if (!Array.isArray(value)) return fail("array");
    return value.map((item, i) => readObject(item, kind.list, `${path}[${i}]`));
  }
  switch (kind) {
    case "str": return typeof value === "string" ? value : fail("string");
    case "int": return Number.isSafeInteger(value) ? value : fail("integer");
    case "bool": return typeof value === "boolean" ? value : fail("boolean");
    case "strnull": return value === null || typeof value === "string" ? value : fail("string atau null");
    case "strarr": return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : fail("array string");
    case "params": return isRecord(value) ? value : fail("objek Params");
    case "bundleid": return typeof value === "string" || Number.isSafeInteger(value) ? value : fail("string atau integer");
  }
}

/** Ambil hanya field yang dikenal; field tambahan diabaikan (Spec 1, butir 3). */
function readObject(value: unknown, schema: Schema, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new EventParseError(`${path} harus objek`);
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(schema)) {
    if (!(name in value)) throw new EventParseError(`field ${path}.${name} hilang`);
    out[name] = readField(value[name], kind, `${path}.${name}`);
  }
  return out;
}

function checkVersion(version: unknown): void {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new EventParseError(`version event tidak sah: ${JSON.stringify(version)}`);
  }
  const [major, minor] = version.split(".").map(Number) as [number, number];
  const [knownMajor, knownMinor] = KNOWN_EVENT_VERSION.split(".").map(Number) as [number, number];
  if (major !== knownMajor || minor > knownMinor) {
    throw new EventParseError(`versi event ${version} lebih tinggi dari yang dikenal (${KNOWN_EVENT_VERSION})`);
  }
}

const isKnownName = (name: string): name is X207EventName => Object.hasOwn(SCHEMAS, name);

export const isKnownX207Event = (event: X207Event | UnknownX207Event): event is X207Event =>
  isKnownName(event.event);

/**
 * Parse satu baris log kontrak. `null` untuk log yang bukan `EVENT_JSON:` atau ber-`standard` selain `x207`;
 * `EventParseError` untuk JSON rusak, versi minor lebih tinggi, atau field wajib yang hilang (K-34).
 * Mengembalikan satu objek per elemen `data`.
 */
export function parseEventLog(log: string): (X207Event | UnknownX207Event)[] | null {
  if (!log.startsWith(EVENT_PREFIX)) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(log.slice(EVENT_PREFIX.length));
  } catch (error) {
    throw new EventParseError(`JSON event rusak: ${(error as Error).message}`);
  }
  if (!isRecord(envelope)) throw new EventParseError("event harus objek JSON");
  if (envelope.standard !== EVENT_STANDARD) return null;
  checkVersion(envelope.version);
  const name = envelope.event;
  if (typeof name !== "string") throw new EventParseError("field event hilang");
  if (!Array.isArray(envelope.data) || envelope.data.length === 0) {
    throw new EventParseError("data harus array berisi minimal satu objek");
  }
  return envelope.data.map((item, i): X207Event | UnknownX207Event => {
    if (!isKnownName(name)) {
      if (!isRecord(item)) throw new EventParseError(`data[${i}] harus objek`);
      return { event: name, data: item };
    }
    return { event: name, ...readObject(item, SCHEMAS[name], `data[${i}]`) } as X207Event;
  });
}
