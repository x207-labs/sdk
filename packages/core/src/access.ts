// F8 Access Asset Adapter (SD-050, interface 0.0.8): types D10/D11 from the pinned `abi.json` and the `AccessAssetAdapter` interface with five functions
// `price`, `prove`, `deliver`, `meter`, `revoke` (Contract Interface Spec 15, Feature F8 note). Principle: hand over access, not secrets. `meter`
// always produces a plain ADR-17 voucher, with `payee` = the grant giver (not the broker account), so the x207 core is unchanged.
import type * as Abi from "./contract/types.generated.js";
import type { AccountId, U128String } from "./types.js";
import type { ContractCall } from "./contract/settlement.js";

import type { AssetClass } from "./marketplace.js";

/**
 * Asset classes as stored by the D10 registry: A transferred natively, B derived credential, C secret held in a TEE broker, D x402 endpoint, and X
 * (rejected). `AssetClass` from `marketplace.ts` covers only A to D, the classes grants and listings may use.
 */
export type RegisteredAssetClass = Abi.AssetClass;
/** One D10 asset class registry row, set by the owner (DAO). */
export type AssetClassEntry = Abi.AssetClassEntry;
export type GrantLimits = Abi.GrantLimits;
export type GrantInput = Abi.GrantInput;
/** One D11 grant. No secret fields: only the proof hash and status are stored. */
export type AccessGrant = Abi.AccessGrant;
export type GrantStatus = Abi.GrantStatus;
export type GrantRole = Abi.GrantRole;
/** The contract's `GrantId`: a number, its own sequence, separate from `bundle_id`. */
export type GrantId = number;
/** Reason for `revoke_grant` (Spec 15.3), also in the `grant_revoked` event. */
export type RevokeReason = Abi.RevokeReason;

/**
 * Class A escrow (interface 0.0.7, CT-075): the NFT is held by the circle contract until the grant completes. Class A grants do not use `accept_grant`
 * (rejected); the buyer calls `complete_escrow` with a signed voucher, and the giver can `cancel_escrow` after `expires_at`.
 */
export type EscrowState = Abi.EscrowState;
/** Step completed by `on_escrow_resolved`, also in the `escrow_failed` event. */
export type EscrowStep = Abi.EscrowStep;
/** Result of the `get_escrow` view; `null` if the grant has no escrow. */
export type EscrowView = Abi.EscrowView;

/**
 * `limits.scope` is required for class A grants (interface 0.0.8): JSON with `nft_contract` and `token_id`; without it `offer_grant` answers
 * `ERR_BAD_GRANT` and `nft_on_transfer` rejects any other NFT with `ERR_ESCROW_NFT_MISMATCH`.
 */
export const escrowGrantScope = (nftContract: AccountId, tokenId: string): string => JSON.stringify({ nft_contract: nftContract, token_id: tokenId });

/**
 * Grant giver's NFT deposit for class A: NEP-171 `nft_transfer_call` on the NFT contract to the circle contract with `msg` `{"grant_id":N}` (no `action`, unlike tokens),
 * deposit 1 yoctoNEAR. Only the NFT and contract written in the scope (`escrowGrantScope`) are accepted (`ERR_ESCROW_NFT_MISMATCH`).
 */
export function buildNftEscrowDepositCall(input: { circleContract: AccountId; nftContract: AccountId; tokenId: string; grantId: GrantId }): ContractCall {
  if (!Number.isSafeInteger(input.grantId) || input.grantId < 1) throw new AccessGrantError(`grantId must be an integer >= 1, got ${input.grantId}`);
  if (input.tokenId.length < 1 || input.tokenId.length > 128) throw new AccessGrantError("tokenId must be 1 to 128 bytes");
  return {
    receiverId: input.nftContract,
    methodName: "nft_transfer_call",
    args: { receiver_id: input.circleContract, token_id: input.tokenId, msg: JSON.stringify({ grant_id: input.grantId }) },
    deposit: 1n,
  };
}

/**
 * Class A escrow for NEP-141 fungible tokens (interface 0.0.10, CT-090): the exact amount held by the circle contract. Result of the `get_ft_escrow` view; `null`
 * if the grant has no token escrow. Tokens with a transfer fee are not supported: the contract holds the amount that actually arrived, and that amount must
 * equal `amount` in `limits.scope`, so a deposit from a fee-charging token is rejected.
 */
export type FtEscrowView = Abi.FtEscrowView;

/**
 * Class A escrow for one NEP-245 multi-token (interface 0.0.11, CT-092): the exact amount of one `token_id` in one multi-token contract, for example a balance of
 * `nep141:<usdt>` in NEAR Intents or a pool share. Result of the `get_mt_escrow` view; `null` if the grant has no multi-token escrow. One deposit may hold only
 * one token and one amount (`ERR_ESCROW_MT_BATCH` for batch deposits). Tokens with a transfer fee are not supported, as with NEP-141.
 */
export type MtEscrowView = Abi.MtEscrowView;

/**
 * Class A grant `limits.scope` for multi-tokens: JSON with `mt_contract`, `token_id` and `amount` (the token's smallest unit, as text). The deposit must match
 * exactly; any other contract, token, or amount is rejected (`ERR_ESCROW_MT_MISMATCH`, `ERR_ESCROW_MT_AMOUNT`).
 */
export const mtEscrowGrantScope = (mtContract: AccountId, tokenId: string, amount: U128String): string => {
  if (tokenId.length === 0) throw new AccessGrantError("tokenId must not be empty");
  if (!/^[1-9]\d*$/.test(amount)) throw new AccessGrantError(`amount must be an integer string > 0, got ${JSON.stringify(amount)}`);
  return JSON.stringify({ mt_contract: mtContract, token_id: tokenId, amount });
};

/**
 * Grant giver's deposit for multi-tokens: NEP-245 `mt_transfer_call` (one token) on the multi-token contract to the circle contract, with the same `msg`
 * as the NEP-141 deposit (`{"action":"escrow","grant_id":N}`), the exact amount from the scope, and a deposit of 1 yoctoNEAR. Batch deposits (`mt_batch_transfer_call`)
 * are rejected by the contract.
 */
export function buildMtEscrowDepositCall(input: { circleContract: AccountId; mtContract: AccountId; tokenId: string; amount: U128String; grantId: GrantId }): ContractCall {
  mtEscrowGrantScope(input.mtContract, input.tokenId, input.amount);
  return {
    receiverId: input.mtContract,
    methodName: "mt_transfer_call",
    args: { receiver_id: input.circleContract, token_id: input.tokenId, amount: input.amount, approval: null, memo: null, msg: buildFtEscrowMsg(input.grantId) },
    deposit: 1n,
  };
}

/**
 * Class A grant `limits.scope` for NEP-141 tokens: JSON with `ft_contract` and `amount` (the token's smallest unit, as text). The deposit must match this amount
 * exactly; any other token contract or amount is rejected at deposit.
 */
export const ftEscrowGrantScope = (ftContract: AccountId, amount: U128String): string => {
  if (!/^[1-9]\d*$/.test(amount)) throw new AccessGrantError(`amount must be an integer string > 0, got ${JSON.stringify(amount)}`);
  return JSON.stringify({ ft_contract: ftContract, amount });
};

/** Token deposit `msg`: `{"action":"escrow","grant_id":N}` (accepted by `ft_on_transfer` from any token except the circle's USDT). */
export function buildFtEscrowMsg(grantId: GrantId): string {
  if (!Number.isSafeInteger(grantId) || grantId < 1) throw new AccessGrantError(`grantId must be an integer >= 1, got ${grantId}`);
  return JSON.stringify({ action: "escrow", grant_id: grantId });
}

/**
 * Grant giver's deposit: `ft_transfer_call` on the token contract to the circle contract with the escrow `msg` and the exact amount from the scope. Deposit 1 yoctoNEAR
 * (NEP-141 standard). The giver must already have offered the grant (`offer_grant`) with the same scope, and must be an active member.
 */
export function buildFtEscrowDepositCall(input: { circleContract: AccountId; ftContract: AccountId; amount: U128String; grantId: GrantId }): ContractCall {
  ftEscrowGrantScope(input.ftContract, input.amount);
  return {
    receiverId: input.ftContract,
    methodName: "ft_transfer_call",
    args: { receiver_id: input.circleContract, amount: input.amount, msg: buildFtEscrowMsg(input.grantId) },
    deposit: 1n,
  };
}

/**
 * The buyer must be registered at the token contract (NEP-145 `storage_balance_of` not `null`) before `complete_escrow`: otherwise `ft_transfer` to the buyer
 * fails and the payment is cancelled. This helper reads the view on the token contract and rejects before the transaction is sent.
 * @param view reads a view on any contract: `(contractId, method, args) => JSON result`
 */
export async function assertBuyerRegisteredAtToken(
  view: (contractId: AccountId, methodName: string, args: object) => Promise<unknown>,
  ftContract: AccountId,
  buyer: AccountId,
): Promise<void> {
  let balance: unknown;
  try {
    balance = await view(ftContract, "storage_balance_of", { account_id: buyer });
  } catch (error) {
    throw new AccessGrantError(`storage_balance_of at ${ftContract} failed for ${buyer}: ${(error as Error).message}`);
  }
  if (balance === null || balance === undefined) {
    throw new AccessGrantError(`${buyer} is not registered at ${ftContract} (storage_deposit): the token payment would fail and be cancelled`);
  }
}

/**
 * All `offered` and `active` grants of one account in one role. `grants_of` has been paginated since interface 0.0.8 and no longer includes
 * grants that have already ended (`get_grant` still answers them), so pages are read until a page that is not full.
 */
export async function listGrantsOf(view: (methodName: string, args: object) => Promise<unknown>, accountId: AccountId, role: GrantRole, pageSize = 50): Promise<AccessGrant[]> {
  const all: AccessGrant[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = (await view("grants_of", { account_id: accountId, role, from_index: from, limit: pageSize })) as AccessGrant[];
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}

/** Price units known to the contract (`GrantInput.unit`). */
export const GRANT_UNITS = ["call", "minute", "day", "once"] as const;
export type GrantUnit = (typeof GRANT_UNITS)[number];

/** Price per unit of a grant, in the smallest credit unit (6 decimals). */
export type PriceQuote = { assetType: string; unit: string; unitPrice: U128String };

/** Result of `prove`: the asset exists and matches the claim. Not an assessment of service quality. */
export type ProofResult = { valid: true } | { valid: false; reason: string };

/**
 * Usage bill from `meter`: the input for one cumulative ADR-17 voucher. `payee` is always the grant giver and `payer` the recipient; `resource` carries
 * `grantId` so the facilitator and seller recognise which grant is being paid.
 */
export type MeterCharge = { payer: AccountId; payee: AccountId; amount: U128String; resource: string };

/** Metered usage: `quantity` units (calls, minutes, days, or 1 for `once`). */
export type Usage = { quantity: number };

/**
 * The five adapter functions. `Delivery` is what the buyer receives and never contains the giver's secrets: an endpoint (class D), a derived key
 * (class B), or a proxy URL (class C).
 */
export interface AccessAssetAdapter<Delivery = unknown, Evidence = unknown> {
  readonly assetClass: AssetClass;
  /** Price from the grant. */
  price(grant: AccessGrant): PriceQuote | Promise<PriceQuote>;
  /** Prove the asset exists and matches the grant (class B: `verifyFunctionCallKey`; class D: not needed). */
  prove(grant: AccessGrant, evidence?: Evidence): ProofResult | Promise<ProofResult>;
  /** Hand access to the recipient. */
  deliver(grant: AccessGrant): Delivery | Promise<Delivery>;
  /** Turn measured usage into an ADR-17 voucher bill. */
  meter(grant: AccessGrant, usage: Usage): MeterCharge | Promise<MeterCharge>;
  /** Revoke access. The contract records the status; the adapter closes the access (delete the key, stop the proxy, reject the payer). */
  revoke(grant: AccessGrant, reason: RevokeReason): void | Promise<void>;
}

export class AccessGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessGrantError";
  }
}

/** The `resource` of a voucher that pays a grant: `x207:grant:<grantId>` (Feature F8 note). */
export const grantResource = (grantId: GrantId): string => `x207:grant:${grantId}`;

/** Inverse of `grantResource`; `null` if `resource` is not a grant resource. */
export function parseGrantResource(resource: string): GrantId | null {
  const match = /^x207:grant:(0|[1-9]\d*)$/.exec(resource);
  if (match === null) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Standard bill `quantity` × `unit_price` for an `active` grant. `payee` = the giver, not the operator or broker. Used by adapters as the
 * basis for `meter`.
 */
export function meterGrant(grant: AccessGrant, usage: Usage): MeterCharge {
  if (grant.status !== "active") throw new AccessGrantError(`grant ${grant.grant_id} has status ${grant.status}, not active`);
  if (grant.grantee === null || grant.grantee === undefined) throw new AccessGrantError(`grant ${grant.grant_id} has no grantee yet`);
  if (!Number.isSafeInteger(usage.quantity) || usage.quantity < 1) throw new AccessGrantError("quantity must be an integer >= 1");
  const amount = BigInt(grant.unit_price) * BigInt(usage.quantity);
  return { payer: grant.grantee, payee: grant.grantor, amount: amount.toString(), resource: grantResource(grant.grant_id) };
}

/** Default `price`: the unit and price written in the grant. */
export const priceOfGrant = (grant: AccessGrant): PriceQuote => ({ assetType: grant.asset_type, unit: grant.unit, unitPrice: grant.unit_price });
