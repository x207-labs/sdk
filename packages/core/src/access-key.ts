// F8 kelas B (SD-052): `prove` untuk grant function-call key. Memeriksa lewat RPC `view_access_key` bahwa kunci yang dipasang broker di akun sewa
// persis sesuai batas grant: receiver_id sama, hanya method yang diizinkan, allowance tidak lebih besar, dan bukan kunci akses penuh. Protokol
// NEAR sendiri menolak method lain dan deposit pada function-call key; pemeriksaan ini membuktikan kuncinya memang dibatasi seperti janji grant.
import { RPC_URLS } from "./constants.js";
import type { AccessGrant, ProofResult } from "./access.js";
import type { AccountId } from "./types.js";

/** Isi `permission` sebuah access key seperti RPC mengembalikannya. */
export type AccessKeyPermission = "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
export type AccessKeyView = { nonce: number | string; permission: AccessKeyPermission };
/** Membaca satu access key; `null` bila kunci tidak ada di akun itu. Melempar bila RPC tidak terjangkau. */
export type ViewAccessKeyFn = (account: AccountId, publicKey: string) => Promise<AccessKeyView | null>;

export type ViewAccessKeyOptions = {
  rpcUrls?: readonly string[];
  fetch?: typeof fetch;
  /** Timeout per endpoint (default 10000 ms, ADR-25). */
  timeoutMs?: number;
  /** Default `final`; `optimistic` melihat kunci yang baru dipasang lebih cepat. */
  finality?: "final" | "optimistic";
};

/** `ViewAccessKeyFn` lewat RPC `query` `view_access_key` dengan failover antar endpoint. */
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
        if (body.error) throw new Error(`RPC error pada view_access_key: ${JSON.stringify(body.error)}`);
        if (body.result?.error) throw new Error(`view_access_key gagal: ${body.result.error}`);
        if (body.result === undefined || body.result.permission === undefined) throw new Error("view_access_key: jawaban RPC tanpa permission");
        return { nonce: body.result.nonce, permission: body.result.permission };
      } catch (error) {
        if ((error as Error).message.startsWith("RPC error") || (error as Error).message.startsWith("view_access_key")) throw error;
        failures.push(`${url}: ${(error as Error).message}`);
      }
    }
    throw new Error(`semua endpoint RPC gagal (${failures.join("; ")})`);
  };
}

/** Batas function-call key di `GrantLimits.scope` untuk kelas B: JSON `{receiver_id, method_names, allowance}` (Spec Antarmuka Kontrak 15.1). */
export type FunctionCallKeyScope = { receiver_id: AccountId; method_names: string[]; allowance: string };

const YOCTO = /^(0|[1-9]\d*)$/;

/** Baca `scope` kelas B; melempar `Error` dengan alasan bila bentuknya tidak sah. */
export function parseFunctionCallKeyScope(scope: string): FunctionCallKeyScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scope);
  } catch {
    throw new Error("scope bukan JSON");
  }
  const s = parsed as Partial<FunctionCallKeyScope> | null;
  if (typeof s !== "object" || s === null) throw new Error("scope harus objek");
  if (typeof s.receiver_id !== "string" || s.receiver_id === "") throw new Error("scope.receiver_id wajib");
  if (!Array.isArray(s.method_names) || s.method_names.length === 0 || !s.method_names.every((m) => typeof m === "string" && m !== "")) {
    throw new Error("scope.method_names harus daftar method yang tidak kosong");
  }
  if (typeof s.allowance !== "string" || !YOCTO.test(s.allowance)) throw new Error("scope.allowance harus string yoctoNEAR");
  return { receiver_id: s.receiver_id, method_names: s.method_names, allowance: s.allowance };
}

const invalid = (reason: string): ProofResult => ({ valid: false, reason });

/**
 * `prove` kelas B: kunci `publicKey` di akun `account` sesuai `grant`. `valid` bila kuncinya function-call key dengan `receiver_id` yang sama,
 * `method_names` tidak kosong dan seluruhnya ada di batas grant, serta `allowance` tidak lebih besar dari batas grant. Alasan penolakan:
 * `not_class_b`, `bad_scope`, `key_not_found`, `full_access_key`, `receiver_mismatch`, `method_not_allowed`, `allowance_exceeded`.
 * Melempar bila RPC tidak terjangkau: itu bukan bukti bahwa kunci salah.
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
  // daftar method kosong berarti semua method: lebih longgar dari grant
  const allowed = new Set(scope.method_names);
  if (permission.method_names.length === 0 || !permission.method_names.every((m) => allowed.has(m))) return invalid("method_not_allowed");
  // allowance null berarti tanpa batas
  if (permission.allowance === null || BigInt(permission.allowance) > BigInt(scope.allowance)) return invalid("allowance_exceeded");
  return { valid: true };
}
