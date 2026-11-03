// Client of the deal with a bond, the freeze of a member and the official contracts of an asset type (SD-073, interface 0.0.12; CT-094, CT-095, CT-096). Builds the calls and reads the
// views through the function the caller gives, like `client.ts`; the signer and the RPC are the caller's. None of these calls is payable.
import type { AccountId, U128String } from "../types.js";
import type { CircleViewFn } from "./client.js";
import type { ContractCall } from "./settlement.js";
import type { DealView, FreezeView, Verdict } from "./types.generated.js";

const HASH = /^[0-9a-f]{64}$/;
const call = (circleContract: AccountId, methodName: string, args: Record<string, unknown>): ContractCall => ({ receiverId: circleContract, methodName, args, deposit: 0n });
const bundleId = (id: number): number => {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`bundle_id harus bilangan bulat >= 0, dapat ${id}`);
  return id;
};

/** `ERR_*` codes that the deal, the freeze and the official contracts can answer with (the part after `ERR_` is what `contractErrorCode` returns, with the prefix). */
export const DEAL_ERROR_CODES = [
  "ERR_ARBITER_INVALID", "ERR_BOND_INSUFFICIENT_STAKE", "ERR_BOND_LOCKED", "ERR_BOND_REQUIRED", "ERR_DEAL_ALREADY_DISPUTED", "ERR_DEAL_CLOSED", "ERR_DEAL_LIMIT",
  "ERR_DEAL_NOT_DISPUTED", "ERR_DEAL_NOT_DUE", "ERR_DEAL_NOT_PARTY", "ERR_DEAL_NO_STAKE_AT_RISK", "ERR_DEAL_UNKNOWN", "ERR_DEAL_WINDOW", "ERR_DEAL_WINDOW_OVER", "ERR_NOT_ARBITER", "ERR_RULING_WINDOW",
] as const;
export const FREEZE_ERROR_CODES = ["ERR_ALREADY_FROZEN", "ERR_FREEZE_NOT_PENDING", "ERR_FREEZE_PENDING", "ERR_FREEZE_TIMELOCK", "ERR_FROZEN", "ERR_NOT_FROZEN"] as const;
export const ASSET_CONTRACT_ERROR_CODES = ["ERR_ASSET_CLASS_NOT_A", "ERR_ASSET_TYPE_UNKNOWN", "ERR_CONTRACT_NOT_OFFICIAL", "ERR_DUPLICATE_CONTRACT", "ERR_TOO_MANY_CONTRACTS"] as const;

/** `confirm_deal(bundle_id)`: a party confirms that the deal was kept; both confirm and the bond is released. */
export const buildConfirmDealCall = (circleContract: AccountId, id: number): ContractCall => call(circleContract, "confirm_deal", { bundle_id: bundleId(id) });
/** `dispute_deal(bundle_id, evidence_hash)`: a party disputes inside the window (before `confirm_by`); `evidence_hash` is the sha256 (64 lowercase hex) of the evidence kept off-chain. */
export function buildDisputeDealCall(circleContract: AccountId, id: number, evidenceHash: string): ContractCall {
  if (!HASH.test(evidenceHash)) throw new Error("evidence_hash harus 64 karakter hex huruf kecil (sha256)");
  return call(circleContract, "dispute_deal", { bundle_id: bundleId(id), evidence_hash: evidenceHash });
}
/** `rule_deal(bundle_id, verdict)`: the arbiter alone, on a disputed deal. */
export function buildRuleDealCall(circleContract: AccountId, id: number, verdict: Verdict): ContractCall {
  if (verdict !== "accused_guilty" && verdict !== "complaint_false" && verdict !== "no_fault") throw new Error(`verdict tidak dikenal: ${JSON.stringify(verdict)}`);
  return call(circleContract, "rule_deal", { bundle_id: bundleId(id), verdict });
}
/** `settle_deal(bundle_id)`: anybody, once the deal is due and nobody disputed (or the arbiter missed the window). */
export const buildSettleDealCall = (circleContract: AccountId, id: number): ContractCall => call(circleContract, "settle_deal", { bundle_id: bundleId(id) });

/** `propose_freeze(account_id, reason_hash?)`: the owner (the DAO) only; the freeze applies after the timelock. */
export function buildProposeFreezeCall(circleContract: AccountId, accountId: AccountId, reasonHash?: string): ContractCall {
  if (reasonHash !== undefined && !HASH.test(reasonHash)) throw new Error("reason_hash harus 64 karakter hex huruf kecil");
  return call(circleContract, "propose_freeze", { account_id: accountId, ...(reasonHash === undefined ? {} : { reason_hash: reasonHash }) });
}
export const buildApplyFreezeCall = (circleContract: AccountId, accountId: AccountId): ContractCall => call(circleContract, "apply_freeze", { account_id: accountId });
export const buildCancelFreezeCall = (circleContract: AccountId, accountId: AccountId): ContractCall => call(circleContract, "cancel_freeze", { account_id: accountId });
export const buildUnfreezeMemberCall = (circleContract: AccountId, accountId: AccountId): ContractCall => call(circleContract, "unfreeze_member", { account_id: accountId });

/** `set_asset_contracts(asset_type, contracts)` (CT-096): the owner names the official contracts of an asset type; an escrow of NFT, NEP-141 or NEP-245 needs one of them. */
export function buildSetAssetContractsCall(circleContract: AccountId, assetType: string, contracts: AccountId[]): ContractCall {
  if (assetType === "") throw new Error("asset_type tidak boleh kosong");
  return call(circleContract, "set_asset_contracts", { asset_type: assetType, contracts });
}

/** View `get_deal(bundle_id)`; `null` for a bundle without a deal. */
export async function getDeal(view: CircleViewFn, id: number): Promise<DealView | null> {
  return ((await view("get_deal", { bundle_id: bundleId(id) })) ?? null) as DealView | null;
}
/** View `bond_locked(account_id)`: the part of the stake held by open deals, as a U128 string. */
export async function getBondLocked(view: CircleViewFn, accountId: AccountId): Promise<U128String> {
  return String(await view("bond_locked", { account_id: accountId }));
}
/** View `is_frozen(account_id)`: true once the freeze is applied (not while it is only proposed). */
export async function isFrozen(view: CircleViewFn, accountId: AccountId): Promise<boolean> {
  return (await view("is_frozen", { account_id: accountId })) === true;
}
/** View `get_freeze(account_id)`: the pending or applied freeze, or `null`. */
export async function getFreeze(view: CircleViewFn, accountId: AccountId): Promise<FreezeView | null> {
  return ((await view("get_freeze", { account_id: accountId })) ?? null) as FreezeView | null;
}
/** View `get_asset_contracts(asset_type)`: the official contracts of the type (empty = none named). */
export async function getAssetContracts(view: CircleViewFn, assetType: string): Promise<AccountId[]> {
  return ((await view("get_asset_contracts", { asset_type: assetType })) ?? []) as AccountId[];
}
