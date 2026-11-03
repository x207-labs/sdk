// Harness near-sandbox untuk test integrasi sdk (TC-SD-011-17, TC-SD-012-07/08, TC-SD-013-01/02, TC-SD-028-19).
// Dijalankan lewat `npm run test:sandbox`. Mencari binary near-sandbox di X207_SANDBOX_BIN atau di build `contracts` (near-workspaces mengunduhnya
// saat `cargo test` pertama), dan wasm kontrak di `../contracts/target/near` (hasil `cargo near build`).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, parseNearAmount } from "near-api-js";
import type { ContractCall } from "@x207/core";

// Tanpa `new URL(..., import.meta.url)`: Vite menulis ulang pola itu menjadi URL http saat test frontend (jsdom) memuat harness ini.
const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../contracts");
export const CIRCLE_WASM = join(contractsDir, "target/near/x207_circle.wasm");
export const MOCK_INTENTS_WASM = join(contractsDir, "target/near/mock_intents/mock_intents.wasm");
export const MOCK_NFT_WASM = join(contractsDir, "target/near/mock_nft/mock_nft.wasm");
export const MOCK_MT_WASM = join(contractsDir, "target/near/mock_mt/mock_mt.wasm");
export const MOCK_RWA_WASM = join(contractsDir, "target/near/mock_rwa/mock_rwa.wasm");
export const MOCK_FT_WASM = join(contractsDir, "target/near/mock_ft/mock_ft.wasm");

export function findSandboxBinary(): string | null {
  if (process.env.X207_SANDBOX_BIN) return process.env.X207_SANDBOX_BIN;
  const build = join(contractsDir, "target/debug/build");
  if (!existsSync(build)) return null;
  for (const dir of readdirSync(build)) {
    const nearDir = join(build, dir, "out/.near");
    if (!dir.startsWith("near-sandbox-") || !existsSync(nearDir)) continue;
    for (const version of readdirSync(nearDir)) {
      const bin = join(nearDir, version, "near-sandbox");
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

/**
 * Test sandbox hanya jalan bila diminta (`npm run test:sandbox`, env X207_SANDBOX=1) dan binary serta kedua wasm
 * ada. Satu test butuh puluhan detik dan jauh lebih lama saat mesin sibuk, jadi tidak ikut `npm test`.
 */
export const sandboxAvailable =
  process.env.X207_SANDBOX === "1" && findSandboxBinary() !== null && existsSync(CIRCLE_WASM) && existsSync(MOCK_FT_WASM);

const freePort = () =>
  new Promise<number>((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => res(port));
    });
  });

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "x", method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

async function waitForRpc(rpcUrl: string, exited: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited()) throw new Error("near-sandbox exited before it was ready");
    try {
      const status = await rpcCall<{ sync_info: { latest_block_height: number } }>(rpcUrl, "status", []);
      if (status.sync_info.latest_block_height > 0) return;
    } catch {
      // belum listening
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("near-sandbox was not ready in time");
}

export type TxResult = {
  /** Hash transaksi. */
  hash: string;
  /** Nilai sukses akhir (JSON), atau `undefined` bila kosong. */
  value: unknown;
  /** Semua baris log dari seluruh receipt, berurutan. */
  logs: string[];
  /** Pesan kegagalan semua receipt yang gagal (kosong bila sukses). */
  failures: string[];
};

type Outcome = { logs: string[]; status: unknown };
type RawResult = { status: unknown; transaction_outcome: { id: string; outcome: Outcome }; receipts_outcome: Array<{ outcome: Outcome }> };

function summarize(raw: RawResult): TxResult {
  const outcomes = [raw.transaction_outcome.outcome, ...raw.receipts_outcome.map((r) => r.outcome)];
  const logs = outcomes.flatMap((o) => o.logs);
  const failures = outcomes.flatMap((o) => {
    const status = o.status as { Failure?: unknown };
    return status && typeof status === "object" && "Failure" in status ? [JSON.stringify(status.Failure)] : [];
  });
  let value: unknown;
  const final = raw.status as { SuccessValue?: string };
  if (final?.SuccessValue) value = JSON.parse(Buffer.from(final.SuccessValue, "base64").toString("utf8"));
  return { hash: raw.transaction_outcome.id, value, logs, failures };
}

export class SandboxAccount {
  readonly sandbox: Sandbox;
  readonly accountId: string;
  readonly account: Account;
  readonly secretKey: string;

  // Tanpa parameter property: agents mengimpor berkas ini dan memakai erasableSyntaxOnly.
  constructor(sandbox: Sandbox, accountId: string, account: Account, secretKey: string) {
    this.sandbox = sandbox;
    this.accountId = accountId;
    this.account = account;
    this.secretKey = secretKey;
  }

  /** Akun yang sama dengan function call key baru (ADR-11b): hanya boleh memanggil `contractId`, tanpa deposit. */
  async withFunctionCallKey(contractId: string): Promise<SandboxAccount> {
    const keyPair = KeyPair.fromRandom("ed25519");
    await this.account.addFunctionCallAccessKey({
      publicKey: keyPair.getPublicKey(), contractId, methodNames: [], allowance: BigInt(parseNearAmount(1)),
    });
    const restricted = new Account(this.accountId, this.sandbox.provider, KeyPairSigner.fromSecretKey(keyPair.toString() as never));
    return new SandboxAccount(this.sandbox, this.accountId, restricted, keyPair.toString());
  }

  /** Kirim function call dan tunggu final; kegagalan dikembalikan di `failures`, tidak dilempar. */
  async call(
    call: Pick<ContractCall, "receiverId" | "methodName" | "args" | "deposit" | "gas">,
    waitUntil: "FINAL" | "EXECUTED_OPTIMISTIC" = "FINAL",
  ): Promise<TxResult> {
    let raw: RawResult;
    try {
      raw = (await this.account.callFunctionRaw({
        contractId: call.receiverId,
        methodName: call.methodName,
        args: call.args,
        deposit: call.deposit,
        gas: call.gas ?? 150_000_000_000_000n,
        waitUntil,
      })) as unknown as RawResult;
    } catch (error) {
      // near-api-js melempar bila transaksi gagal di akhir; log receipt hilang, pesan panic tetap ada.
      return { hash: "", value: undefined, logs: [], failures: [error instanceof Error ? error.message : String(error)] };
    }
    return summarize(raw);
  }
}

export class Sandbox {
  readonly provider: JsonRpcProvider;
  readonly rpcUrl: string;
  readonly rootAccountId: string;
  readonly #rootSecretKey: string;
  readonly #stopFn: () => Promise<void>;

  constructor(rpcUrl: string, rootAccountId: string, rootSecretKey: string, stopFn: () => Promise<void>) {
    this.rpcUrl = rpcUrl;
    this.rootAccountId = rootAccountId;
    this.#rootSecretKey = rootSecretKey;
    this.#stopFn = stopFn;
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  root(): SandboxAccount {
    return new SandboxAccount(this, this.rootAccountId, new Account(this.rootAccountId, this.provider, KeyPairSigner.fromSecretKey(this.#rootSecretKey as never)), this.#rootSecretKey);
  }

  /** Buat `<name>.<root>` dengan saldo NEAR dan kunci baru. */
  async createAccount(name: string, nearBalance = "20"): Promise<SandboxAccount> {
    const keyPair = KeyPair.fromRandom("ed25519");
    const accountId = `${name}.${this.rootAccountId}`;
    await this.root().account.createAccount({
      newAccountId: accountId,
      publicKey: keyPair.getPublicKey(),
      nearToTransfer: BigInt(parseNearAmount(Number(nearBalance))),
    });
    return new SandboxAccount(this, accountId, new Account(accountId, this.provider, KeyPairSigner.fromSecretKey(keyPair.toString() as never)), keyPair.toString());
  }

  /** Objek akun baru dari kunci yang ada; dipakai setelah `fastForward` karena Account menyimpan block hash lama. */
  accountFrom(accountId: string, secretKey: string): SandboxAccount {
    return new SandboxAccount(this, accountId, new Account(accountId, this.provider, KeyPairSigner.fromSecretKey(secretKey as never)), secretKey);
  }

  async deploy(account: SandboxAccount, wasmPath: string): Promise<void> {
    await account.account.deployContract(readFileSync(wasmPath));
  }

  /** View function; hasil JSON. */
  async view<T>(contractId: string, methodName: string, args: object = {}): Promise<T> {
    const result = await rpcCall<{ result: number[] }>(this.rpcUrl, "query", {
      request_type: "call_function", finality: "optimistic", account_id: contractId, method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
  }

  async blockTimestampMs(): Promise<number> {
    const block = await rpcCall<{ header: { timestamp_nanosec: string } }>(this.rpcUrl, "block", { finality: "optimistic" });
    return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
  }

  /** Maju `blocks` blok sekaligus (`sandbox_fast_forward`); waktu blok ikut maju. */
  async fastForward(blocks: number): Promise<void> {
    await rpcCall(this.rpcUrl, "sandbox_fast_forward", { delta_height: blocks });
  }

  /** Maju sampai waktu blok mencapai `targetMs` (unix ms). */
  async advanceTo(targetMs: number): Promise<void> {
    while ((await this.blockTimestampMs()) < targetMs) {
      const missingSeconds = Math.ceil((targetMs - (await this.blockTimestampMs())) / 1000);
      await this.fastForward(Math.min(Math.max(missingSeconds, 20), 4000));
    }
  }

  stop(): Promise<void> {
    return this.#stopFn();
  }
}

export async function startSandbox(timeoutMs = 180_000): Promise<Sandbox> {
  const bin = findSandboxBinary();
  if (!bin) throw new Error("near-sandbox not found; set X207_SANDBOX_BIN or run `cargo test` in contracts");
  const home = mkdtempSync(join(tmpdir(), "x207-sdk-sandbox-"));
  const init = spawnSync(bin, ["--home", home, "init", "--chain-id", "localnet"], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`near-sandbox init failed: ${init.stderr}`);
  const rpcPort = await freePort();
  const netPort = await freePort();
  const configPath = join(home, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.rpc.addr = `127.0.0.1:${rpcPort}`;
  config.network.addr = `127.0.0.1:${netPort}`;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const validator = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8")) as { account_id: string; secret_key: string };
  const child = spawn(bin, ["--home", home, "run"], { stdio: "ignore" });
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  try {
    await waitForRpc(rpcUrl, () => child.exitCode !== null, timeoutMs);
  } catch (error) {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  const stop = () =>
    new Promise<void>((res) => {
      const cleanup = () => {
        rmSync(home, { recursive: true, force: true });
        res();
      };
      if (child.exitCode !== null) return cleanup();
      child.once("exit", cleanup);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    });
  return new Sandbox(rpcUrl, validator.account_id, validator.secret_key, stop);
}
