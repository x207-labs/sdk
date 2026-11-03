// GENERATED oleh scripts/generate-contract-types.mjs dari abi/x207-circle.abi.json. Jangan diedit.
// Ubah ABI lewat contracts (CT-068), lalu: node scripts/generate-contract-types.mjs --pin <abi.json>

export const X207_CIRCLE_ABI_VERSION = "0.0.9";
export const X207_CIRCLE_ABI_SCHEMA_VERSION = "0.4.0";
export const X207_CIRCLE_ABI_SHA256 = "077516cc9fd609dc3f4dd494ab1e13c09fc55c34ec7ee4e76cc265c0b760f532";
export const X207_CIRCLE_EVENT_STANDARD = "x207";

export type AccessGrant = { "asset_type": string; "class": AssetClass; "delivery_pubkey"?: string | null; "grant_id": number; "grantee"?: string | null; "grantor": string; "limits": GrantLimits; "operator"?: string | null; "proof_hash"?: string | null; "proof_kind"?: string | null; "status": GrantStatus; "unit": string; "unit_price": string };
export type Admission = "open" | "dao";
export type AssetClass = "A" | "B" | "C" | "D" | "X";
export type AssetClassEntry = { "accepted_proofs": string[]; "asset_type": string; "class": AssetClass; "delivery_methods": string[]; "terms_hash": string };
export type BundleInput = { "epoch": number; "legs": BundleLeg[]; "search_leg"?: SearchLeg | null };
export type BundleLeg = { "max_amount": string; "payee": string; "payer": string };
export type BundleLegView = { "max_amount": string; "payee": string; "payer": string; "registered": string };
export type BundleSignature = { "account_id": string; "signature": string };
export type BundleStatus = "active";
export type BundleView = { "bundle_id": number; "epoch": number; "legs": BundleLegView[]; "status": BundleStatus; "terms_hash": string };
export type CircleConfig = { "circle_id": string; "contract_id": string; "decimals": number; "intents_id": string; "member_count": number; "network": string; "owner_id": string; "unit": string; "usdt_token_id": string };
export type ClaimDestination = "near" | "intents";
export type ClearingEdge = { "cleared": string; "creditor": string; "debtor": string };
export type ClearingProposal = { "cleared_total": string; "committed": boolean; "edge_count": number; "edges": ClearingEdge[]; "epoch": number; "solver": string; "submitted_at": string };
export type EpochPhaseView = "open" | "cutoff" | "clearing" | "commit" | "payment_window" | "finalized";
export type EpochView = { "closed_at"?: string | null; "committed_at"?: string | null; "cutoff_at": string; "edge_count": number; "epoch": number; "finalized_at"?: string | null; "opened_at": string; "params": Params; "participant_count": number; "payment_deadline"?: string | null; "phase": EpochPhaseView; "pool": string; "proposal_deadline"?: string | null; "shortfall": string; "total_cleared": string; "total_obligation": string };
export type EscrowState = "held" | "completing" | "cancelling" | "delivered" | "cancelled" | "stuck";
export type EscrowStep = "complete" | "cancel";
export type EscrowView = { "buyer"?: string | null; "grant_id": number; "nft_contract": string; "state": EscrowState; "token_id": string };
export type Fees = { "clearing_fee_bps": number; "solver_fee_bps": number };
export type GrantInput = { "asset_type": string; "delivery_method": string; "limits": GrantLimits; "operator"?: string | null; "proof_hash"?: string | null; "proof_kind"?: string | null; "unit": string; "unit_price": string };
export type GrantLimits = { "expires_at": string; "quota"?: string | null; "scope": string };
export type GrantRole = "grantor" | "grantee";
export type GrantStatus = "offered" | "active" | "revoked" | "expired";
export type IntentView = { "account_id": string; "intent_hash": string; "posted_at": string };
export type MemberStatus = "pending" | "active" | "suspended" | "exited";
export type MemberView = { "account_id": string; "admitted": boolean; "exit_requested_epoch"?: number | null; "joined_at": string; "last_active_epoch": number; "limit": string; "pubkey_voucher": string; "settled_history": string; "stake": string; "status": MemberStatus; "terms_hash": string };
export type ObligationView = { "cleared": string; "creditor": string; "cumulative": string; "debtor": string; "epoch": number; "last_seq": number; "obligation": string };
export type Params = { "admission": Admission; "base_limit_ratio": number; "epoch_length": number; "fees": Fees; "limit_cap": string; "limit_decay": number; "limit_growth": number; "max_search_share_bps"?: number; "payment_window": number; "proposal_window": number };
export type PendingParams = { "effective_epoch": number; "params": Params };
export type PoolView = { "accounted": string; "epoch_pools": string; "in_flight": string; "reserve": string; "solver_fees": string; "total_stake": string };
export type PositionRole = "debtor" | "creditor";
export type PositionStatus = "due" | "paid" | "defaulted" | "claimable" | "claimed";
export type PositionView = { "account_id": string; "amount": string; "epoch": number; "net": string; "payment_deadline": string; "recovered": string; "role": PositionRole; "status": PositionStatus; "updated_at_block": number };
export type Promise = unknown;
export type PromiseOrValueArray_of_String = string[];
export type PromiseOrValueBoolean = boolean;
export type PromiseOrValueString = string;
export type RevokeReason = "grantor" | "grantee" | "operator" | "expired" | "defaulted";
export type SearchLeg = { "payee": string; "payer": string };
export type SimulationResult = { "better_than_current": boolean; "cleared_total": string; "edge_count": number; "reason"?: string | null; "valid": boolean };
export type UpgradeView = { "code_hash": string; "eta": string };
export type Voucher = { "circle": string; "cumulativeAmount": string; "epoch": number; "payee": string; "payer": string; "resource": string; "seq": number; "unit": string };

/** View: `args` = argumen JSON, `result` = nilai kembalian. */
export type CircleViews = {
  "get_asset_class": { args: { "asset_type": string }; result: AssetClassEntry | null };
  "get_bundle": { args: { "bundle_id": number }; result: BundleView | null };
  "get_circle": { args: Record<string, never>; result: CircleConfig };
  "get_clearing_proposal": { args: { "epoch": number }; result: ClearingProposal | null };
  "get_epoch": { args: { "epoch"?: number | null }; result: EpochView | null };
  "get_escrow": { args: { "grant_id": number }; result: EscrowView | null };
  "get_grant": { args: { "grant_id": number }; result: AccessGrant | null };
  "get_intent": { args: { "intent_hash": string }; result: IntentView | null };
  "get_owner": { args: Record<string, never>; result: string };
  "get_params": { args: Record<string, never>; result: Params };
  "get_pending_params": { args: Record<string, never>; result: PendingParams | null };
  "get_pool": { args: Record<string, never>; result: PoolView };
  "get_upgrade": { args: Record<string, never>; result: UpgradeView | null };
  "grants_of": { args: { "account_id": string; "role": GrantRole; "from_index": number; "limit": number }; result: AccessGrant[] };
  "headroom": { args: { "account_id": string }; result: string };
  "intents_balance": { args: Record<string, never>; result: string };
  "interface_version": { args: Record<string, never>; result: string };
  "last_seq": { args: { "payer": string; "payee": string; "epoch": number }; result: number };
  "limit": { args: { "account_id": string }; result: string };
  "list_asset_classes": { args: { "from_index": number; "limit": number }; result: AssetClassEntry[] };
  "list_members": { args: { "from_index": number; "limit": number }; result: MemberView[] };
  "list_obligations": { args: { "epoch": number; "from_index": number; "limit": number }; result: ObligationView[] };
  "list_positions": { args: { "epoch": number; "from_index": number; "limit": number }; result: PositionView[] };
  "member": { args: { "account_id": string }; result: MemberView | null };
  "net_position": { args: { "epoch": number; "account_id": string }; result: PositionView | null };
  "obligation": { args: { "epoch": number; "debtor": string; "creditor": string }; result: ObligationView | null };
  "outstanding_debt": { args: { "account_id": string }; result: string };
  "simulate_clearing": { args: { "epoch": number; "edges": ClearingEdge[] }; result: SimulationResult };
  "solver_fee_balance": { args: { "account_id": string }; result: string };
};

/** Call: transaksi. `payable`, `init`, `private` dari modifier ABI. */
export type CircleCalls = {
  "accept_grant": { args: { "grant_id": number; "delivery_pubkey"?: string | null }; result: void };
  "admit_member": { args: { "account_id": string }; result: void };
  "apply_upgrade": { args: Record<string, never>; result: Promise };
  "cancel_escrow": { args: { "grant_id": number }; result: Promise };
  "claim": { args: { "epoch": number; "destination": ClaimDestination }; result: Promise; payable: true };
  "claim_solver_fee": { args: Record<string, never>; result: Promise; payable: true };
  "close_epoch": { args: { "epoch": number }; result: void };
  "commit_bundle": { args: { "bundle": BundleInput; "signatures": BundleSignature[] }; result: number };
  "commit_epoch": { args: { "epoch": number }; result: void };
  "complete_escrow": { args: { "grant_id": number; "voucher": Voucher; "signature": string }; result: Promise };
  "finalize_epoch": { args: { "epoch": number }; result: void };
  "ft_on_transfer": { args: { "sender_id": string; "amount": string; "msg": string }; result: PromiseOrValueString };
  "join": { args: { "circle_id": string; "pubkey_voucher": string; "terms_hash": string }; result: MemberView; payable: true };
  "migrate": { args: Record<string, never>; result: void; init: true; private: true };
  "mt_on_transfer": { args: { "sender_id": string; "previous_owner_ids": string[]; "token_ids": string[]; "amounts": string[]; "msg": string }; result: PromiseOrValueArray_of_String };
  "new": { args: { "owner_id": string; "circle_id": string; "usdt_token_id": string; "intents_id": string; "params"?: Params | null }; result: void; init: true };
  "nft_on_transfer": { args: { "sender_id": string; "previous_owner_id": string; "token_id": string; "msg": string }; result: PromiseOrValueBoolean };
  "offer_grant": { args: { "input": GrantInput }; result: number };
  "on_claim_resolved": { args: { "epoch": number; "account_id": string; "amount": string; "destination": ClaimDestination }; result: string; private: true };
  "on_escrow_resolved": { args: { "grant_id": number; "step": EscrowStep }; result: void; private: true };
  "on_intents_withdrawn": { args: { "amount": string }; result: string; private: true };
  "on_solver_fee_resolved": { args: { "account_id": string; "amount": string }; result: string; private: true };
  "on_withdraw_resolved": { args: { "account_id": string; "amount": string }; result: boolean; private: true };
  "post_intent": { args: { "intent_hash": string }; result: void };
  "propose_upgrade": { args: { "code_hash": string }; result: void };
  "prune_epoch": { args: { "epoch": number; "max_items": number }; result: number };
  "register_cumulative": { args: { "voucher": Voucher; "signature": string }; result: string };
  "register_in_bundle": { args: { "bundle_id": number; "voucher": Voucher; "signature": string }; result: string };
  "register_voucher": { args: { "voucher": Voucher; "signature": string }; result: string };
  "remove_intent": { args: { "intent_hash": string }; result: void };
  "request_exit": { args: Record<string, never>; result: void; payable: true };
  "revoke_grant": { args: { "grant_id": number; "reason": RevokeReason }; result: void };
  "set_asset_class": { args: { "asset_type": string; "entry": AssetClassEntry }; result: void };
  "set_params": { args: { "params": Params }; result: void };
  "submit_clearing": { args: { "epoch": number; "edges": ClearingEdge[] }; result: string };
  "withdraw_intents_balance": { args: Record<string, never>; result: Promise };
  "withdraw_stake": { args: Record<string, never>; result: PromiseOrValueBoolean; payable: true };
};

export const CIRCLE_VIEW_METHODS = ["get_asset_class","get_bundle","get_circle","get_clearing_proposal","get_epoch","get_escrow","get_grant","get_intent","get_owner","get_params","get_pending_params","get_pool","get_upgrade","grants_of","headroom","intents_balance","interface_version","last_seq","limit","list_asset_classes","list_members","list_obligations","list_positions","member","net_position","obligation","outstanding_debt","simulate_clearing","solver_fee_balance"] as const;
export const CIRCLE_CALL_METHODS = ["accept_grant","admit_member","apply_upgrade","cancel_escrow","claim","claim_solver_fee","close_epoch","commit_bundle","commit_epoch","complete_escrow","finalize_epoch","ft_on_transfer","join","migrate","mt_on_transfer","new","nft_on_transfer","offer_grant","on_claim_resolved","on_escrow_resolved","on_intents_withdrawn","on_solver_fee_resolved","on_withdraw_resolved","post_intent","propose_upgrade","prune_epoch","register_cumulative","register_in_bundle","register_voucher","remove_intent","request_exit","revoke_grant","set_asset_class","set_params","submit_clearing","withdraw_intents_balance","withdraw_stake"] as const;

/** Nama event NEP-297 dan urutan field `data`-nya. */
export const CIRCLE_EVENTS = {
  "member_joined": ["account_id","pubkey_voucher","terms_hash","status","joined_at"],
  "stake_added": ["account_id","sender_id","amount","stake","limit","status"],
  "voucher_registered": ["payer","payee","epoch","seq","cumulative_amount","delta","obligation","outstanding_debt","mode"],
  "epoch_cutoff": ["epoch","closed_at","proposal_deadline","edge_count","participant_count","total_obligation","next_epoch","next_cutoff_at"],
  "clearing_submitted": ["epoch","solver","cleared_total","edge_count","replaced_solver","replaced_cleared_total"],
  "clearing_applied": ["epoch","solver","cleared_total","edges","clearing_fee","solver_fee","chunk","chunks"],
  "epoch_committed": ["epoch","committed_at","payment_deadline","total_due","total_claimable","positions","chunk","chunks"],
  "residual_paid": ["epoch","account_id","sender_id","amount","refunded","settled_history"],
  "member_defaulted": ["epoch","account_id","due","from_stake","from_reserve","shortfall","stake","status","position_status","outstanding_debt"],
  "limits_updated": ["epoch","changes","chunk","chunks"],
  "epoch_finalized": ["epoch","finalized_at","defaulted_count","total_defaulted","pool","shortfall"],
  "residual_claimed": ["epoch","account_id","amount","destination","status"],
  "residual_claim_failed": ["epoch","account_id","amount","destination","status"],
  "params_updated": ["old","new","changed","effective_epoch"],
  "exit_requested": ["account_id","epoch"],
  "stake_withdrawn": ["account_id","amount"],
  "stake_withdraw_failed": ["account_id","amount"],
  "member_admitted": ["account_id","status"],
  "member_reactivated": ["account_id","stake","limit","effective_epoch"],
  "solver_fee_claimed": ["account_id","amount"],
  "solver_fee_claim_failed": ["account_id","amount"],
  "upgrade_proposed": ["code_hash","eta"],
  "upgrade_applied": ["code_hash","applied_at"],
  "intent_posted": ["intent_hash","account_id","posted_at"],
  "asset_class_set": ["asset_type","class"],
  "grant_offered": ["grant_id","asset_type","grantor","class","unit","unit_price","expires_at"],
  "grant_activated": ["grant_id","grantee","delivery_pubkey"],
  "grant_revoked": ["grant_id","reason"],
  "escrow_held": ["grant_id","nft_contract","token_id"],
  "escrow_failed": ["grant_id","step","epoch","payer","payee","delta","reverted"],
  "bundle_committed": ["bundle_id","terms_hash","epoch","legs","solver"],
  "intents_withdrawn": ["amount"],
} as const;

export type CircleEventName = keyof typeof CIRCLE_EVENTS;
