// SD-119 (contract 0.0.18, P1): the check a buyer runs BEFORE it pays for a NEAR account sold through the locker contract.
// The circle holds the escrow, but only the chain shows what the account really looks like: a key the seller kept, code that is not the official locker,
// or a locker that belongs to another circle or grant would let the seller keep the account after it was paid. `evaluateAccountLock` is pure; the readers
// below fetch the facts through the RPC with failover.
import { RPC_URLS } from "./constants.js";
import { isEndpointDown, withRpcFailover, type FailoverOptions } from "./rpc-failover.js";
import type { CircleViewFn } from "./contract/client.js";
import type { AccountId } from "./types.js";

/** Why the account is not safe to pay for. More than one can apply. */
export type AccountLockReason =
  | "keys_left" //                 the account still has an access key (the seller can move the account after the payment)
  | "code_not_official" //         the code on the account is not on the list of official locker code hashes (the circle's `get_locker_code_hashes`)
  | "no_official_list" //          the circle publishes no locker code hash, so nothing can be trusted
  | "locker_missing" //            the account has no locker (`get_state` does not answer)
  | "locker_other_circle" //       the locker reports another circle
  | "locker_other_grant" //        the locker reports another grant
  | "locker_not_held" //           the locker is not `held` (still `pending`, or already `released` / `returned`)
  | "escrow_missing" //            the circle has no account escrow for the grant
  | "escrow_not_held" //           the escrow is not `held` (delivered, cancelled)
  | "escrow_other_account"; //     the escrow of the grant is for another account

/** What the chain says about the sold account. */
export type AccountLockFacts = {
  /** Public keys of `view_access_key_list`. */
  keys: readonly string[];
  /** `code_hash` of `view_account` (base58). */
  codeHash: string;
  /** `get_state` of the locker, or null when the account has none. */
  locker: { circle: AccountId; grant_id: number; return_pubkey: string; state: string } | null;
  /** `get_account_escrow` of the circle. */
  escrow: { grant_id: number; account_id: AccountId; state: string } | null;
  /** `get_locker_code_hashes` of the circle. */
  officialCodeHashes: readonly string[];
};

export type AccountLockCheck = { ok: boolean; reasons: AccountLockReason[] };

/** Pure verdict. `ok` only when no reason applies: no key, official code, a locker of this circle and grant in state `held`, and a held escrow for this account. */
export function evaluateAccountLock(input: { circle: AccountId; grantId: number; soldAccount: AccountId; facts: AccountLockFacts }): AccountLockCheck {
  const { facts } = input;
  const reasons: AccountLockReason[] = [];
  if (facts.keys.length > 0) reasons.push("keys_left");
  if (facts.officialCodeHashes.length === 0) reasons.push("no_official_list");
  else if (!facts.officialCodeHashes.includes(facts.codeHash)) reasons.push("code_not_official");
  if (facts.locker === null) reasons.push("locker_missing");
  else {
    if (facts.locker.circle !== input.circle) reasons.push("locker_other_circle");
    if (facts.locker.grant_id !== input.grantId) reasons.push("locker_other_grant");
    if (facts.locker.state !== "held") reasons.push("locker_not_held");
  }
  if (facts.escrow === null) reasons.push("escrow_missing");
  else {
    if (facts.escrow.account_id !== input.soldAccount) reasons.push("escrow_other_account");
    if (facts.escrow.state !== "held") reasons.push("escrow_not_held");
  }
  return { ok: reasons.length === 0, reasons };
}

export type AccountLockReadOptions = {
  rpcUrls?: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  failover?: Pick<FailoverOptions, "rateLimitRetries" | "baseMs" | "sleep">;
};

class RpcRefusal extends Error {}

async function rpcQuery(options: AccountLockReadOptions, params: Record<string, unknown>): Promise<{ result?: Record<string, unknown>; refusal?: string }> {
  const urls = options.rpcUrls ?? RPC_URLS;
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return withRpcFailover(
    urls,
    async (url) => {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "x207", method: "query", params: { finality: "final", ...params } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const body = (await response.json()) as { result?: Record<string, unknown> & { error?: string }; error?: unknown };
      if (body.error !== undefined) throw new RpcRefusal(`RPC error: ${JSON.stringify(body.error)}`);
      if (body.result === undefined) throw new RpcRefusal("RPC answer without result");
      if (typeof body.result.error === "string") return { refusal: body.result.error };
      return { result: body.result };
    },
    { failoverOn: (error) => !(error instanceof RpcRefusal) && isEndpointDown(error), ...(options.failover ?? {}) },
  );
}

/** Reads the chain facts of the sold account: keys, code hash and the locker state (null when the account has no locker or no such method). */
export async function readAccountOnChain(soldAccount: AccountId, options: AccountLockReadOptions = {}): Promise<Pick<AccountLockFacts, "keys" | "codeHash" | "locker">> {
  const keysAnswer = await rpcQuery(options, { request_type: "view_access_key_list", account_id: soldAccount });
  if (keysAnswer.refusal !== undefined || keysAnswer.result === undefined) throw new Error(`view_access_key_list failed: ${keysAnswer.refusal ?? "no result"}`);
  const list = (keysAnswer.result.keys ?? []) as { public_key: string }[];
  const accountAnswer = await rpcQuery(options, { request_type: "view_account", account_id: soldAccount });
  if (accountAnswer.refusal !== undefined || accountAnswer.result === undefined) throw new Error(`view_account failed: ${accountAnswer.refusal ?? "no result"}`);
  const codeHash = String(accountAnswer.result.code_hash ?? "");
  const stateAnswer = await rpcQuery(options, { request_type: "call_function", account_id: soldAccount, method_name: "get_state", args_base64: Buffer.from("{}").toString("base64") });
  let locker: AccountLockFacts["locker"] = null;
  if (stateAnswer.refusal === undefined && stateAnswer.result !== undefined) {
    const bytes = stateAnswer.result.result as number[] | undefined;
    if (bytes !== undefined) {
      const view = JSON.parse(Buffer.from(bytes).toString("utf8")) as { circle: AccountId; grant_id: number; return_pubkey: string; state: string };
      locker = { circle: view.circle, grant_id: Number(view.grant_id), return_pubkey: view.return_pubkey, state: view.state };
    }
  }
  return { keys: list.map((k) => k.public_key), codeHash, locker };
}

export type CheckAccountLockOptions = AccountLockReadOptions & {
  circle: AccountId;
  circleView: CircleViewFn;
  grantId: number;
  soldAccount: AccountId;
  /** Test hook: replaces `readAccountOnChain`. */
  readAccount?: typeof readAccountOnChain;
};

/** The full pre-pay check: reads the sold account, the escrow and the official list from the circle, and returns the verdict. Throws only when the RPC is unreachable. */
export async function checkAccountLockBeforePay(options: CheckAccountLockOptions): Promise<AccountLockCheck & { facts: AccountLockFacts }> {
  const [onChain, escrow, hashes] = await Promise.all([
    (options.readAccount ?? readAccountOnChain)(options.soldAccount, options),
    options.circleView("get_account_escrow", { grant_id: options.grantId }),
    options.circleView("get_locker_code_hashes", {}),
  ]);
  const escrowView = escrow === null || escrow === undefined ? null : (escrow as { grant_id: number; account_id: AccountId; state: string });
  const facts: AccountLockFacts = { ...onChain, escrow: escrowView, officialCodeHashes: (hashes ?? []) as string[] };
  return { ...evaluateAccountLock({ circle: options.circle, grantId: options.grantId, soldAccount: options.soldAccount, facts }), facts };
}
