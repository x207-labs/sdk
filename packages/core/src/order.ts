// Service order format (SD-069, pipeline P6, ADR-45). An order is an agreement between buyer and seller over work done; all that exists on-chain is a plain voucher with
// `resource = "x207:order:<hash>"`. The contract does not change. Three payment patterns:
//   - `milestone`: deliveries per milestone `{amount, due_at}`, paid after the buyer confirms or automatically after the dispute window (ADR-42, BE-047);
//   - `outcome`: pay per result the buyer accepts (`lead`, `bug`); each milestone is one result slot;
//   - `proof`: pay per provider transaction visible on-chain (`keeper`, `solver`), via `payForProofs`; `delegate` (SD-072) uses the same pattern but is paid per
//     `proposal_id` the delegate votes on with `VoteApprove` or `VoteReject`, against a public mandate (`mandate_hash`).
// Rules that prevent misuse live in the document: a sample (`sample_hash`) is required for `prompt` because a result that is easy to copy must not be disputable once copied, and
// proof of ownership of `target` is required for `loadtest` so x207 does not become a DDoS-for-hire market (the backend checks the target, BE-054). The budget is locked as a bundle like SD-067
// (`orderBundleTerms`); a bundle lives in only one epoch, so a milestone due in a different epoch uses a different bundle (`epochForTime` in invoice.ts).
import { createHash } from "node:crypto";
import { CREDIT_UNIT } from "./constants.js";
import type { BundleTerms } from "./barter.js";
import type { AccountId, U128String, UnsignedVoucher, Voucher } from "./types.js";
import { nep413SigningHash, signHash, signVoucher, type VoucherSecretKey } from "./voucher.js";
import type { InvoicePairState } from "./invoice.js";

export const ORDER_KINDS = ["prompt", "research", "translation", "annotation", "scraping", "audit", "loadtest", "freelance", "bug", "lead", "keeper", "solver", "delegate"] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];
export type OrderPattern = "milestone" | "outcome" | "proof";
/** Payment pattern per kind. Monitoring (`day`) and consulting (`minute`) are not here: both are metered like P5 and use a metered endpoint. */
export const ORDER_PATTERN: Readonly<Record<OrderKind, OrderPattern>> = {
  prompt: "milestone", research: "milestone", translation: "milestone", annotation: "milestone", scraping: "milestone", audit: "milestone", loadtest: "milestone", freelance: "milestone",
  bug: "outcome", lead: "outcome", keeper: "proof", solver: "proof", delegate: "proof",
};
/** Barter catalog number per kind. */
export const ORDER_CATALOG_NO: Readonly<Record<OrderKind, number>> = {
  prompt: 39, research: 40, translation: 41, annotation: 42, scraping: 43, audit: 52, loadtest: 53, freelance: 83, bug: 88, lead: 51, keeper: 46, solver: 48, delegate: 16,
};
/**
 * Contract methods counted as proof, per kind. For `delegate` this is the default (`act_proposal` from Sputnik v2); a DAO that uses another method supplies it via
 * `OrderOptions.delegateMethods` on `normalizeOrder`, `serializeOrder`, and `orderHash`.
 */
export const PROOF_METHODS: Readonly<Record<"keeper" | "solver" | "delegate", readonly string[]>> = { keeper: ["close_epoch", "finalize_epoch"], solver: ["submit_clearing"], delegate: ["act_proposal"] };
/** Voting actions that are paid for `delegate` orders; other actions of the same method (`Finalize`, `VoteRemove`, ...) are not paid. */
export const DELEGATE_VOTE_ACTIONS: readonly string[] = ["VoteApprove", "VoteReject"];
export type OrderOptions = { delegateMethods?: readonly string[] };
export const ORDER_RESOURCE_PREFIX = "x207:order:";
export const MAX_MILESTONES = 24;

export type OrderErrorCode =
  | "order_bad_kind" | "order_bad_account" | "order_same_party" | "order_bad_hash" | "order_sample_required" | "order_target_required" | "order_target_forbidden" | "order_bad_target"
  | "order_bad_milestones" | "order_bad_amount" | "order_bad_proof" | "order_bad_nonce" | "order_bad_resource" | "order_not_proof_kind" | "order_bad_state"
  | "order_mandate_required" | "order_mandate_forbidden" | "order_bad_mandate";

export class OrderError extends Error {
  constructor(readonly code: OrderErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "OrderError";
  }
}

export type OrderMilestone = { amount: U128String; due_at: number };
export type OrderProof = { method: string; amount_per_tx: U128String };
export type OrderDocument = {
  circle: AccountId;
  kind: OrderKind;
  buyer: AccountId;
  seller: AccountId;
  /** sha256 hex of the work specification (the content stays off-chain). */
  spec_hash: string;
  milestones: OrderMilestone[];
  /** Sample result: required for `prompt`; the hash is locked when the order is created. */
  sample_hash?: string | null;
  /** Load-test target hostname: required for `loadtest`, forbidden for other kinds. */
  target?: string | null;
  /** Required for `keeper`, `solver`, and `delegate`, forbidden for other kinds. For `delegate`, `amount_per_tx` is the price of one vote (one `proposal_id`). */
  proof?: OrderProof | null;
  /** sha256 hex of the public mandate (`mandateHash`): required for `delegate`, forbidden for other kinds; only `delegate` orders include it in the canonical JSON (the hash of other orders does not change). */
  mandate_hash?: string | null;
  nonce: string;
};
/** Canonical form: `mandate_hash` exists only for `delegate` orders. */
export type NormalizedOrder = Required<Omit<OrderDocument, "mandate_hash">> & { mandate_hash?: string };

const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const AMOUNT = /^[1-9]\d*$/;
const HASH = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9._-]{1,32}$/;
const HOST = /^(?=.{3,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z][a-z\d-]{0,61}[a-z\d]$/;
const U128_MAX = 340282366920938463463374607431768211455n;
const fail = (code: OrderErrorCode, message: string): never => {
  throw new OrderError(code, message);
};
const isAccount = (v: unknown): v is string => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT.test(v);
const isAmount = (v: unknown): v is string => typeof v === "string" && AMOUNT.test(v) && BigInt(v) <= U128_MAX;

/** Validates the document and returns the canonical form (fixed keys, `null` for empty values). */
export function normalizeOrder(order: OrderDocument, options: OrderOptions = {}): NormalizedOrder {
  if (!ORDER_KINDS.includes(order.kind)) fail("order_bad_kind", `unknown order kind: ${JSON.stringify(order.kind)}; choose ${ORDER_KINDS.join(", ")}`);
  for (const [name, value] of [["circle", order.circle], ["buyer", order.buyer], ["seller", order.seller]] as const) if (!isAccount(value)) fail("order_bad_account", `${name} is not a NEAR account: ${JSON.stringify(value)}`);
  if (order.buyer === order.seller) fail("order_same_party", "buyer and seller must be different accounts");
  if (!HASH.test(order.spec_hash)) fail("order_bad_hash", "spec_hash must be 64 lowercase hex characters");
  const sample = order.sample_hash ?? null;
  if (sample !== null && !HASH.test(sample)) fail("order_bad_hash", "sample_hash must be 64 lowercase hex characters");
  if (order.kind === "prompt" && sample === null) fail("order_sample_required", "a prompt order must contain sample_hash: an easily copied result needs a locked sample");
  const target = order.target ?? null;
  if (order.kind === "loadtest" && target === null) fail("order_target_required", "a load-test order must contain a target");
  if (order.kind !== "loadtest" && target !== null) fail("order_target_forbidden", "target is only for load-test orders");
  if (target !== null && (!HOST.test(target) || /^\d+(\.\d+){3}$/.test(target) || target === "localhost" || target.endsWith(".localhost") || target.endsWith(".local") || target.endsWith(".internal"))) {
    fail("order_bad_target", "target must be a public host name, not an IP address, localhost, .local, or .internal");
  }
  if (!Array.isArray(order.milestones) || order.milestones.length < 1 || order.milestones.length > MAX_MILESTONES) fail("order_bad_milestones", `milestones must be 1 to ${MAX_MILESTONES}`);
  let previous = 0;
  for (const m of order.milestones) {
    if (!isAmount(m.amount)) fail("order_bad_amount", `milestone amount must be a decimal integer > 0 (smallest unit), got ${JSON.stringify(m.amount)}`);
    if (!Number.isSafeInteger(m.due_at) || m.due_at <= previous) fail("order_bad_milestones", "due_at must be unix seconds and increase from milestone to milestone");
    previous = m.due_at;
  }
  const pattern = ORDER_PATTERN[order.kind];
  const proof = order.proof ?? null;
  const mandateHash = order.mandate_hash ?? null;
  if (order.kind === "delegate") {
    if (mandateHash === null) fail("order_mandate_required", "a delegate order must contain mandate_hash (sha256 of the public mandate)");
    if (!HASH.test(mandateHash!)) fail("order_bad_mandate", "mandate_hash must be 64 lowercase hex characters");
  } else if (mandateHash !== null) {
    fail("order_mandate_forbidden", "mandate_hash is only for delegate orders");
  }
  if (pattern === "proof") {
    const methods = order.kind === "delegate" ? (options.delegateMethods ?? PROOF_METHODS.delegate) : PROOF_METHODS[order.kind as "keeper" | "solver"];
    if (proof === null || !methods.includes(proof.method)) fail("order_bad_proof", `a ${order.kind} order must contain proof.method, one of ${methods.join(", ")}`);
    if (!isAmount(proof!.amount_per_tx)) fail("order_bad_amount", `proof.amount_per_tx must be a decimal integer > 0, got ${JSON.stringify(proof!.amount_per_tx)}`);
  } else if (proof !== null) {
    fail("order_bad_proof", "proof is only for keeper, solver, and delegate orders");
  }
  if (typeof order.nonce !== "string" || !NONCE.test(order.nonce)) fail("order_bad_nonce", "nonce must be 1 to 32 characters [A-Za-z0-9._-]");
  return {
    circle: order.circle, kind: order.kind, buyer: order.buyer, seller: order.seller, spec_hash: order.spec_hash,
    milestones: order.milestones.map((m) => ({ amount: m.amount, due_at: m.due_at })), sample_hash: sample, target,
    proof: proof === null ? null : { method: proof.method, amount_per_tx: proof.amount_per_tx }, ...(order.kind === "delegate" ? { mandate_hash: mandateHash! } : {}), nonce: order.nonce,
  };
}

/** Canonical order JSON: keys `circle, kind, buyer, seller, spec_hash, milestones, sample_hash, target, proof, nonce`, no whitespace; `delegate` orders insert `mandate_hash` after `proof`. */
/** For the helpers that work on an order that was already accepted: the method of its own proof is taken as allowed (the DAO list is checked where the order is accepted). */
const ownMethod = (o: OrderDocument): OrderOptions => (o.kind === "delegate" ? { delegateMethods: o.proof ? [o.proof.method] : [] } : {});
export const serializeOrder = (order: OrderDocument, options: OrderOptions = {}): string => JSON.stringify(normalizeOrder(order, options));
export const orderHash = (order: OrderDocument, options: OrderOptions = {}): string => createHash("sha256").update(serializeOrder(order, options)).digest("hex");

// ---- delegate mandate (SD-072) ------------------------------------------------------------------------------------------------------------------------------------------------------

export type DelegateMandate = {
  circle: AccountId;
  /** DAO account where the delegate votes. */
  dao: AccountId;
  /** Proposal kinds (`ProposalKind` variants of Sputnik v2 in snake_case) that may be paid. */
  kinds: string[];
  /** sha256 hex of the public rules text: when the delegate picks what. The text stays off-chain. */
  rules_hash: string;
};
const KIND = /^[a-z][a-z0-9_]{1,31}$/;
export const MAX_MANDATE_KINDS = 16;

/** Validates the mandate and returns the canonical form: `kinds` sorted ascending, no duplicates. */
export function normalizeMandate(m: DelegateMandate): DelegateMandate {
  if (!isAccount(m.circle) || !isAccount(m.dao)) fail("order_bad_mandate", "circle and dao must be NEAR accounts");
  if (!Array.isArray(m.kinds) || m.kinds.length < 1 || m.kinds.length > MAX_MANDATE_KINDS) fail("order_bad_mandate", `kinds must be 1 to ${MAX_MANDATE_KINDS} proposal kinds`);
  for (const k of m.kinds) if (typeof k !== "string" || !KIND.test(k)) fail("order_bad_mandate", `invalid proposal kind: ${JSON.stringify(k)}`);
  if (new Set(m.kinds).size !== m.kinds.length) fail("order_bad_mandate", "kinds contains the same kind twice");
  if (!HASH.test(m.rules_hash)) fail("order_bad_mandate", "rules_hash must be 64 lowercase hex characters");
  return { circle: m.circle, dao: m.dao, kinds: [...m.kinds].sort(), rules_hash: m.rules_hash };
}
/** Canonical mandate JSON: keys `circle, dao, kinds, rules_hash`, no whitespace. */
export const serializeMandate = (m: DelegateMandate): string => JSON.stringify(normalizeMandate(m));
export const mandateHash = (m: DelegateMandate): string => createHash("sha256").update(serializeMandate(m)).digest("hex");

// ---- delegate transaction claim -------------------------------------------------------------------------------------------------------------------------------------------------------

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
export type OrderClaimNotice = { circle: AccountId; order_hash: string; actor: AccountId; action: "claim"; at: number; tx_hash: string };
/**
 * Claim notice: the seller (delegate) declares its vote transaction to the backend (`POST orders/{hash}/claims`), because votes in the DAO do not pass through the x207 indexer. Key order:
 * `circle, order_hash, actor, action, at, tx_hash`. The backend checks that transaction over RPC.
 */
export function orderClaimNotice(args: { circle: AccountId; orderHash: string; actor: AccountId; at: number; txHash: string }): OrderClaimNotice {
  if (!isAccount(args.circle) || !isAccount(args.actor)) fail("order_bad_account", "circle and actor must be NEAR accounts");
  if (!HASH.test(args.orderHash)) fail("order_bad_hash", "order_hash must be 64 lowercase hex characters");
  if (!Number.isSafeInteger(args.at) || args.at < 1) fail("order_bad_state", "at must be unix seconds");
  if (!TX_HASH.test(args.txHash)) fail("order_bad_hash", "tx_hash is not a NEAR transaction hash (base58)");
  return { circle: args.circle, order_hash: args.orderHash, actor: args.actor, action: "claim", at: args.at, tx_hash: args.txHash };
}
/** Claim notice signature: NEP-413 over the notice JSON with the contract account as recipient, the same scheme as other ledger notices. */
export function signOrderClaim(notice: OrderClaimNotice, secretKey: VoucherSecretKey): string {
  const json = JSON.stringify(notice);
  return signHash(nep413SigningHash(json, createHash("sha256").update(json, "utf8").digest(), notice.circle), secretKey);
}

export function orderResource(hash: string): string {
  if (!HASH.test(hash)) fail("order_bad_resource", "order hash must be 64 lowercase hex characters");
  return `${ORDER_RESOURCE_PREFIX}${hash}`;
}
export function parseOrderResource(resource: string): string | null {
  if (!resource.startsWith(ORDER_RESOURCE_PREFIX)) return null;
  const hash = resource.slice(ORDER_RESOURCE_PREFIX.length);
  return HASH.test(hash) ? hash : null;
}

/** Sum of all milestones: the order budget (upper bound that can be paid). */
export function orderBudget(order: OrderDocument): U128String {
  return normalizeOrder(order, ownMethod(order)).milestones.reduce((n, m) => n + BigInt(m.amount), 0n).toString();
}

/**
 * Terms of the bundle that locks the order budget in `epoch`, as in SD-067: a buyer-to-seller leg of `amount` (default: the whole budget) plus a companion seller-to-
 * buyer leg of 1 smallest unit, because the contract demands two legs. The bundle lives only in that epoch.
 */
export function orderBundleTerms(args: { order: OrderDocument; epoch: number; amount?: U128String }): BundleTerms {
  const o = normalizeOrder(args.order, ownMethod(args.order));
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 1) fail("order_bad_state", `epoch must be an integer >= 1, got ${args.epoch}`);
  const amount = args.amount ?? orderBudget(o);
  if (!isAmount(amount)) fail("order_bad_amount", `invalid bundle amount: ${JSON.stringify(amount)}`);
  return {
    circle: o.circle, epoch: args.epoch,
    legs: [{ payer: o.buyer, payee: o.seller, max_amount: amount }, { payer: o.seller, payee: o.buyer, max_amount: "1" }],
  };
}

/**
 * Voucher for milestone `index` (from 1) after that milestone is confirmed, continuing the pair state in `epoch`. A disputed milestone is not paid and does not change
 * the state, so the next milestone's voucher is built from the real pair state (`state`), not from a voucher chain computed ahead of time.
 * `paid` is required: the milestone indexes the caller has already paid (`OrderLedger` records them); an already-paid milestone is rejected, so one milestone is never paid twice.
 */
export function milestoneVoucher(args: { order: OrderDocument; index: number; epoch: number; state: InvoicePairState; paid: readonly number[] }): UnsignedVoucher {
  const o = normalizeOrder(args.order, ownMethod(args.order));
  // F5 (review BE-062): the library has no memory, so the caller must say which milestones it paid; a milestone is paid once
  if (!Array.isArray(args.paid)) fail("order_bad_state", "paid (the milestones already paid) is required");
  if (args.paid.includes(args.index)) fail("order_bad_state", `milestone ${args.index} is already paid`);
  const item = o.milestones[args.index - 1];
  if (!Number.isInteger(args.index) || item === undefined) fail("order_bad_milestones", `milestone ${args.index} does not exist; this order has ${o.milestones.length}`);
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 1) fail("order_bad_state", `epoch must be an integer >= 1, got ${args.epoch}`);
  if (!Number.isSafeInteger(args.state.seq) || args.state.seq < 0 || !/^(0|[1-9]\d*)$/.test(args.state.cumulativeAmount)) fail("order_bad_state", `invalid pair state: ${JSON.stringify(args.state)}`);
  return {
    circle: o.circle, payer: o.buyer, payee: o.seller, epoch: args.epoch, seq: args.state.seq + 1,
    cumulativeAmount: (BigInt(args.state.cumulativeAmount) + BigInt(item!.amount)).toString(), unit: CREDIT_UNIT,
    resource: orderResource(orderHash(o, ownMethod(o))),
  };
}

/** On-chain proof from the backend (`GET orders/{hash}/onchain-proofs`, BE-055): one provider transaction. */
export type OnchainProof = {
  txHash: string; method: string; signer: AccountId;
  /** `delegate` orders only (SD-072): the contract called, the proposal voted on, its action, and its proposal kind (`ProposalKind` variant in snake_case). */
  receiver?: AccountId; proposal_id?: number; action?: string; proposal_kind?: string;
};
export type ProofRefusal = { txHash: string; reason: "wrong_signer" | "wrong_method" | "already_paid" | "over_budget" | "unverified" | "wrong_receiver" | "not_a_vote" | "kind_not_in_mandate" };
/**
 * `paid` is the hash of paid transactions; `paidKeys` is the anti-duplicate keys recorded: transaction hashes, or `proposal:<id>` for `delegate` orders. The next call passes
 * `paidKeys` (not `paid`) as `alreadyPaid` (B5-F1, BE-062 review).
 */
export type PayForProofsResult = { vouchers: Voucher[]; paid: string[]; paidKeys: string[]; refused: ProofRefusal[]; state: InvoicePairState; spent: U128String };

/**
 * Buyer helper for `keeper` and `solver` orders: one voucher per matching proof, each of `proof.amount_per_tx`, in sequence in epoch `epoch` starting from pair state
 * `state`. A proof is rejected (not paid) if signed by another account, uses another method, was already paid (`alreadyPaid`, also if it appears twice), or would exceed the
 * order budget (`alreadySpent` + what is paid here must not exceed `orderBudget`). Nothing is paid for orders with another pattern.
 */
export type PayForProofsArgs = {
  order: OrderDocument;
  epoch: number;
  state: InvoicePairState;
  proofs: readonly OnchainProof[];
  /**
   * Required (F4): the keys already paid, i.e. `paidKeys` from the previous call (for `keeper` and `solver` the same as the transaction hash, for `delegate` `proposal:<id>`); `[]`
   * is written explicitly on the first call. For `delegate` orders, entries that are not `proposal:<id>` are rejected, because a transaction hash does not protect the same proposal.
   */
  alreadyPaid: readonly string[];
  /** Required (F4): what is already paid for this order, in smallest credit units (`"0"` on the first call). */
  alreadySpent: U128String;
  /** Optional (F12): ask the chain whether that transaction is real, from that provider, with that method; `false` rejects it (`unverified`). Without this, proofs are trusted from the backend as-is. */
  verifyTx?: (proof: OnchainProof) => boolean;
  /** Required for `delegate` orders: the mandate whose hash is in the document (`mandate_hash`). */
  mandate?: DelegateMandate;
  /** Proof method used by the DAO for `delegate` orders (default `PROOF_METHODS.delegate`). */
  options?: OrderOptions;
  secretKey: VoucherSecretKey;
};

export function payForProofs(args: PayForProofsArgs): PayForProofsResult {
  const o = normalizeOrder(args.order, args.options);
  const delegate = o.kind === "delegate";
  const mandate = delegate ? normalizeMandate(args.mandate ?? fail("order_mandate_required", "a delegate order is paid against its mandate: provide mandate")) : null;
  if (mandate !== null && (mandateHash(mandate) !== o.mandate_hash || mandate.circle !== o.circle)) fail("order_bad_mandate", "this mandate is not the one whose hash is in the order");
  if (ORDER_PATTERN[o.kind] !== "proof" || o.proof === null) fail("order_not_proof_kind", `a ${o.kind} order is not paid per on-chain proof`);
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 1) fail("order_bad_state", `epoch must be an integer >= 1, got ${args.epoch}`);
  const budget = BigInt(orderBudget(o));
  const each = BigInt(o.proof!.amount_per_tx);
  if (!Array.isArray(args.alreadyPaid) || typeof args.alreadySpent !== "string" || !/^(0|[1-9]\d*)$/.test(args.alreadySpent)) {
    fail("order_bad_state", "alreadyPaid and alreadySpent are required (from the previous call)");
  }
  if (delegate) {
    const stray = args.alreadyPaid.find((k) => !/^proposal:\d+$/.test(k));
    if (stray !== undefined) fail("order_bad_state", `alreadyPaid of a delegate order contains paidKeys (proposal:<id>), not transaction hashes: ${JSON.stringify(stray)}`);
  }
  const seen = new Set(args.alreadyPaid);
  let spent = BigInt(args.alreadySpent);
  let seq = args.state.seq;
  let cumulative = BigInt(args.state.cumulativeAmount);
  const resource = orderResource(orderHash(o, args.options));
  const vouchers: Voucher[] = [];
  const paid: string[] = [];
  const paidKeys: string[] = [];
  const refused: ProofRefusal[] = [];
  for (const proof of args.proofs) {
    // a delegate is paid once per proposal, whatever the number of transactions on it; the other kinds once per transaction
    const key = delegate && Number.isSafeInteger(proof.proposal_id) ? `proposal:${proof.proposal_id}` : proof.txHash;
    const delegateRefusal: ProofRefusal["reason"] | null = !delegate
      ? null
      : proof.receiver !== mandate!.dao ? "wrong_receiver"
      : proof.action === undefined || !DELEGATE_VOTE_ACTIONS.includes(proof.action) || !Number.isSafeInteger(proof.proposal_id) ? "not_a_vote"
      : proof.proposal_kind === undefined || !mandate!.kinds.includes(proof.proposal_kind) ? "kind_not_in_mandate"
      : null;
    const reason: ProofRefusal["reason"] | null =
      proof.signer !== o.seller ? "wrong_signer" : proof.method !== o.proof!.method ? "wrong_method" : delegateRefusal !== null ? delegateRefusal : seen.has(key) ? "already_paid" : spent + each > budget ? "over_budget" : args.verifyTx !== undefined && !args.verifyTx(proof) ? "unverified" : null;
    if (reason !== null) {
      refused.push({ txHash: proof.txHash, reason });
      continue;
    }
    seq += 1;
    cumulative += each;
    spent += each;
    seen.add(key);
    paidKeys.push(key);
    vouchers.push(signVoucher({ circle: o.circle, payer: o.buyer, payee: o.seller, epoch: args.epoch, seq, cumulativeAmount: cumulative.toString(), unit: CREDIT_UNIT, resource }, args.secretKey));
    paid.push(proof.txHash);
  }
  return { vouchers, paid, paidKeys, refused, state: { seq, cumulativeAmount: cumulative.toString() }, spent: spent.toString() };
}

/**
 * Like `payForProofs`, but `verifyTx` may ask the chain (B5-F3, review BE-062): it can return a promise. Every proof that is not already paid is asked first, one after the other, then the
 * synchronous rules run with the answers; a proof that the chain does not confirm is `unverified`. An error of the verifier is an error of the call (nothing is signed), not a pass.
 */
export async function payForProofsAsync(args: Omit<PayForProofsArgs, "verifyTx"> & { verifyTx?: (proof: OnchainProof) => boolean | Promise<boolean> }): Promise<PayForProofsResult> {
  const { verifyTx, ...rest } = args;
  if (verifyTx === undefined) return payForProofs(rest);
  const paid = new Set(args.alreadyPaid);
  const answers = new Map<OnchainProof, boolean>();
  for (const proof of args.proofs) {
    const key = args.order.kind === "delegate" && Number.isSafeInteger(proof.proposal_id) ? `proposal:${proof.proposal_id}` : proof.txHash;
    if (!paid.has(key)) answers.set(proof, (await verifyTx(proof)) === true);
  }
  return payForProofs({ ...rest, verifyTx: (proof) => answers.get(proof) ?? true });
}

/**
 * A verifier for `payForProofsAsync` that asks a NEAR node (JSON-RPC `tx`, final) about the transaction of a proof: it must exist, every receipt must have succeeded, it must be signed by
 * `proof.signer`, be one `FunctionCall` of `proof.method`, and, when the proof names a `receiver` (a delegate's vote), go to that account. It does not check the arguments of the call (the
 * proposal and the action); the backend checks those when it accepts the claim. An answer of the node that is not understood is `false`, a network error is thrown.
 */
export function rpcTxVerifier(rpcUrl: string, fetchImpl: typeof fetch = fetch): (proof: OnchainProof) => Promise<boolean> {
  return async (proof) => {
    const res = await fetchImpl(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "x207", method: "tx", params: { tx_hash: proof.txHash, sender_account_id: proof.signer, wait_until: "FINAL" } }),
    });
    const body = (await res.json()) as { result?: { status?: unknown; transaction?: { signer_id?: string; receiver_id?: string; actions?: Array<{ FunctionCall?: { method_name?: string } }> }; receipts_outcome?: Array<{ outcome?: { status?: unknown } }> }; error?: { cause?: { name?: string } } };
    if (body.result === undefined) {
      const name = body.error?.cause?.name;
      if (name === "UNKNOWN_TRANSACTION" || name === "TIMEOUT_ERROR") return false;
      throw new Error(`rpc tx: ${JSON.stringify(body.error ?? body)}`);
    }
    const { status, transaction, receipts_outcome: receipts } = body.result;
    const done = typeof status === "object" && status !== null && ("SuccessValue" in status || "SuccessReceiptId" in status);
    const failed = (receipts ?? []).some((r) => typeof r.outcome?.status === "object" && r.outcome.status !== null && "Failure" in r.outcome.status);
    const actions = transaction?.actions ?? [];
    return done && !failed && transaction?.signer_id === proof.signer && actions.length === 1 && actions[0]?.FunctionCall?.method_name === proof.method
      && (proof.receiver === undefined || transaction.receiver_id === proof.receiver);
  };
}

/**
 * Payment ledger of one order on the buyer side (F4 and F5): records the milestones and transactions already paid and their amount, so one milestone is not paid twice and one proof is not
 * paid twice, also after the agent is run again (save `snapshot()` and rebuild with `OrderLedger.restore`). The seller must still register vouchers; this ledger only remembers
 * what has been signed.
 */
export class OrderLedger {
  readonly order: OrderDocument;
  readonly #milestones = new Set<number>();
  readonly #proofs = new Set<string>();
  #spent = 0n;
  #asking = false;

  constructor(order: OrderDocument, saved?: { milestones: readonly number[]; proofs: readonly string[]; spent: U128String }) {
    this.order = order;
    normalizeOrder(order, ownMethod(order));
    if (saved) {
      for (const m of saved.milestones) this.#milestones.add(m);
      for (const t of saved.proofs) this.#proofs.add(t);
      this.#spent = BigInt(saved.spent);
    }
  }
  static restore(order: OrderDocument, saved: { milestones: readonly number[]; proofs: readonly string[]; spent: U128String }): OrderLedger {
    return new OrderLedger(order, saved);
  }
  snapshot(): { milestones: number[]; proofs: string[]; spent: U128String } {
    return { milestones: [...this.#milestones], proofs: [...this.#proofs], spent: this.#spent.toString() };
  }
  get spent(): U128String {
    return this.#spent.toString();
  }

  /** Voucher for a confirmed milestone, recorded as paid; the same milestone twice is rejected. */
  payMilestone(args: { index: number; epoch: number; state: InvoicePairState; secretKey: VoucherSecretKey }): Voucher {
    const unsigned = milestoneVoucher({ order: this.order, index: args.index, epoch: args.epoch, state: args.state, paid: [...this.#milestones] });
    const amount = BigInt(unsigned.cumulativeAmount) - BigInt(args.state.cumulativeAmount);
    if (this.#spent + amount > BigInt(orderBudget(this.order))) fail("order_bad_state", "exceeds the order budget");
    const signed = signVoucher(unsigned, args.secretKey);
    this.#milestones.add(args.index);
    this.#spent += amount;
    return signed;
  }

  /** Like `payProofs`, with a `verifyTx` that may ask the chain (see `payForProofsAsync`). Not for two calls at once: the ledger is read before the chain is asked, so a second call is refused. */
  async payProofsAsync(args: { epoch: number; state: InvoicePairState; proofs: readonly OnchainProof[]; secretKey: VoucherSecretKey; verifyTx?: (proof: OnchainProof) => boolean | Promise<boolean>; mandate?: DelegateMandate; options?: OrderOptions }): Promise<PayForProofsResult> {
    if (this.#asking) fail("order_bad_state", "payProofsAsync is running: wait for its result before calling again");
    this.#asking = true;
    let result: PayForProofsResult;
    try {
      result = await payForProofsAsync({
      order: this.order, epoch: args.epoch, state: args.state, proofs: args.proofs, alreadyPaid: [...this.#proofs], alreadySpent: this.#spent.toString(), secretKey: args.secretKey,
      ...(args.verifyTx ? { verifyTx: args.verifyTx } : {}), ...(args.mandate ? { mandate: args.mandate } : {}), ...(args.options ? { options: args.options } : {}),
      });
    } finally {
      this.#asking = false;
    }
    for (const t of result.paidKeys) this.#proofs.add(t);
    this.#spent = BigInt(result.spent);
    return result;
  }

  /** Pay per on-chain proof, recording it in this ledger. */
  payProofs(args: { epoch: number; state: InvoicePairState; proofs: readonly OnchainProof[]; secretKey: VoucherSecretKey; verifyTx?: (proof: OnchainProof) => boolean; mandate?: DelegateMandate; options?: OrderOptions }): PayForProofsResult {
    const result = payForProofs({
      order: this.order, epoch: args.epoch, state: args.state, proofs: args.proofs, alreadyPaid: [...this.#proofs], alreadySpent: this.#spent.toString(), secretKey: args.secretKey,
      ...(args.verifyTx ? { verifyTx: args.verifyTx } : {}), ...(args.mandate ? { mandate: args.mandate } : {}), ...(args.options ? { options: args.options } : {}),
    });
    for (const t of result.paidKeys) this.#proofs.add(t);
    this.#spent = BigInt(result.spent);
    return result;
  }
}
