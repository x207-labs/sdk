// F8 class B (SD-052): `prove` for function-call key grants. Checks through the RPC `view_access_key` that the key the broker installed on the rental account
// matches the grant limits exactly: same receiver_id, only the allowed methods, allowance not larger, and not a full-access key. The NEAR
// protocol itself rejects other methods and deposits on a function-call key; this check proves the key is really restricted as the grant promised.
import { RPC_URLS } from "./constants.js";
import type { AccessGrant, ProofResult } from "./access.js";
import type { AccountId } from "./types.js";

/** The `permission` content of an access key as the RPC returns it. */
export type AccessKeyPermission = "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
export type AccessKeyView = { nonce: number | string; permission: AccessKeyPermission };
/** Reads one access key; `null` if the key is not on that account. Throws if the RPC is unreachable. */
export type ViewAccessKeyFn = (account: AccountId, publicKey: string) => Promise<AccessKeyView | null>;

export type ViewAccessKeyOptions = {
  rpcUrls?: readonly string[];
  fetch?: typeof fetch;
  /** Timeout per endpoint (default 10000 ms, ADR-25). */
  timeoutMs?: number;
  /** Default `final`; `optimistic` sees a newly installed key sooner. */
  finality?: "final" | "optimistic";
};

/** `ViewAccessKeyFn` through the RPC `query` `view_access_key` with failover between endpoints. */
export function createViewAccessKeyFn(options: ViewAccessKeyOptions = {}): ViewAccessKeyFn {
  const urls = options.rpcUrls ?? RPC_URLS;
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (account, publicKey) => {
    const failures: string[] = [];
    for (const url of urls) {
      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: "x207", method: "query",
            params: { request_type: "view_access_key", finality: options.finality ?? "final", account_id: account, public_key: publicKey },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          failures.push(`${url}: HTTP ${response.status}`);
          continue;
        }
        const body = (await response.json()) as { result?: AccessKeyView & { error?: string }; error?: { cause?: { name?: string }; data?: unknown } };
        const missing = body.error?.cause?.name === "UNKNOWN_ACCESS_KEY" || /does not exist|UNKNOWN_ACCESS_KEY/.test(`${body.result?.error ?? ""}${JSON.stringify(body.error?.data ?? "")}`);
        if (missing) return null;
        if (body.error) throw new Error(`RPC error in view_access_key: ${JSON.stringify(body.error)}`);
        if (body.result?.error) throw new Error(`view_access_key failed: ${body.result.error}`);
        if (body.result === undefined || body.result.permission === undefined) throw new Error("view_access_key: RPC answer without permission");
        return { nonce: body.result.nonce, permission: body.result.permission };
      } catch (error) {
        if ((error as Error).message.startsWith("RPC error") || (error as Error).message.startsWith("view_access_key")) throw error;
        failures.push(`${url}: ${(error as Error).message}`);
      }
    }
    throw new Error(`all RPC endpoints failed (${failures.join("; ")})`);
  };
}

/** Function-call key limits in `GrantLimits.scope` for class B: JSON `{receiver_id, method_names, allowance}` (Contract Interface Spec 15.1). */
export type FunctionCallKeyScope = { receiver_id: AccountId; method_names: string[]; allowance: string };

const YOCTO = /^(0|[1-9]\d*)$/;

/** Read the class B `scope`; throws an `Error` with a reason if the shape is not valid. */
export function parseFunctionCallKeyScope(scope: string): FunctionCallKeyScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scope);
  } catch {
    throw new Error("scope is not JSON");
  }
  const s = parsed as Partial<FunctionCallKeyScope> | null;
  if (typeof s !== "object" || s === null) throw new Error("scope must be an object");
  if (typeof s.receiver_id !== "string" || s.receiver_id === "") throw new Error("scope.receiver_id is required");
  if (!Array.isArray(s.method_names) || s.method_names.length === 0 || !s.method_names.every((m) => typeof m === "string" && m !== "")) {
    throw new Error("scope.method_names must be a non-empty list of methods");
  }
  if (typeof s.allowance !== "string" || !YOCTO.test(s.allowance)) throw new Error("scope.allowance must be a yoctoNEAR string");
  return { receiver_id: s.receiver_id, method_names: s.method_names, allowance: s.allowance };
}

const invalid = (reason: string): ProofResult => ({ valid: false, reason });

/**
 * Class B `prove`: key `publicKey` on account `account` matches `grant`. `valid` if the key is a function-call key with the same `receiver_id`,
 * non-empty `method_names` all within the grant limits, and `allowance` not larger than the grant limit. Rejection reasons:
 * `not_class_b`, `bad_scope`, `key_not_found`, `full_access_key`, `receiver_mismatch`, `method_not_allowed`, `allowance_exceeded`.
 * Throws if the RPC is unreachable: that is not proof the key is wrong.
 */
export async function verifyFunctionCallKey(account: AccountId, publicKey: string, grant: AccessGrant, view: ViewAccessKeyFn): Promise<ProofResult> {
  if (grant.class !== "B") return invalid("not_class_b");
  let scope: FunctionCallKeyScope;
  try {
    scope = parseFunctionCallKeyScope(grant.limits.scope);
  } catch (error) {
    return invalid(`bad_scope: ${(error as Error).message}`);
  }
  const key = await view(account, publicKey);
  if (key === null) return invalid("key_not_found");
  if (key.permission === "FullAccess" || !("FunctionCall" in key.permission)) return invalid("full_access_key");
  const permission = key.permission.FunctionCall;
  if (permission.receiver_id !== scope.receiver_id) return invalid("receiver_mismatch");
  // an empty method list means all methods: looser than the grant
  const allowed = new Set(scope.method_names);
  if (permission.method_names.length === 0 || !permission.method_names.every((m) => allowed.has(m))) return invalid("method_not_allowed");
  // allowance null means no limit
  if (permission.allowance === null || BigInt(permission.allowance) > BigInt(scope.allowance)) return invalid("allowance_exceeded");
  return { valid: true };
}
