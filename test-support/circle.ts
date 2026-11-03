// Fixture lingkaran di near-sandbox: kontrak `x207-circle`, mock NEP-141 sebagai USDT, dan akun anggota.
import { readFileSync } from "node:fs";
import { CIRCLE_WASM, MOCK_FT_WASM, MOCK_INTENTS_WASM, Sandbox, SandboxAccount, startSandbox } from "./sandbox.js";

/** Jendela pendek di dalam rentang sah (Spec Antarmuka Kontrak 3.4), sama dengan `short_params` di contracts. */
export const SHORT_PARAMS = {
  epoch_length: 300, payment_window: 900, proposal_window: 60, base_limit_ratio: 8000,
  limit_growth: 1000, limit_cap: "1000000000", limit_decay: 0,
  fees: { clearing_fee_bps: 0, solver_fee_bps: 0 }, admission: "open",
};

/** Methods of `probes/mock_intents` that the tests call; a wasm without one of them is a stale build (security review 3, F1). */
export const MOCK_INTENTS_METHODS = ["new", "set_mode", "mt_transfer_call", "mt_resolve", "balance_of", "ft_withdraw", "withdraw_resolve", "last_msg", "received"];

/** Fails with a clear message when the built `mock_intents` wasm lacks an export, instead of a "method not found" that looks like a bug of the circle. */
export function assertMockIntentsWasm(path: string = MOCK_INTENTS_WASM): void {
  let exported: string[];
  try {
    exported = WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(path))).map((e) => e.name);
  } catch (error) {
    throw new Error(`mock_intents wasm cannot be read at ${path} (${(error as Error).message}); build it: in contracts/: cargo near build non-reproducible-wasm --manifest-path probes/mock_intents/Cargo.toml`);
  }
  const missing = MOCK_INTENTS_METHODS.filter((name) => !exported.includes(name));
  if (missing.length > 0) {
    throw new Error(`mock_intents wasm is older than probes/mock_intents/src/lib.rs (no export: ${missing.join(", ")}); delete ${path} and build it again: in contracts/: cargo near build non-reproducible-wasm --manifest-path probes/mock_intents/Cargo.toml`);
  }
}

export const CREDIT = 1_000_000n;
export const TERMS_HASH = "a".repeat(64);

export type CircleFixture = {
  sandbox: Sandbox;
  circleId: string;
  circle: SandboxAccount;
  usdt: SandboxAccount;
  /** Hanya dengan `deployCircle(params, { mockIntents: true })`: kontrak `mock_intents` yang menjadi `intents_id` kontrak lingkaran. */
  intents?: SandboxAccount;
  /** Akun anggota yang dibuat `member()`, dengan 1.000 USDT mock. */
  members: Map<string, SandboxAccount>;
  member(name: string): Promise<SandboxAccount>;
  stop(): Promise<void>;
};

/** Sandbox baru dengan kontrak ter-deploy dan di-`new`. */
export type DeployCircleOptions = {
  /**
   * `intents_id` kontrak lingkaran diisi akun dengan wasm `mock_intents` (method `new`, `mt_transfer_call`, `ft_withdraw`, `balance_of`),
   * untuk test residual lewat Intents (`mt_on_transfer`, `withdraw_intents_balance`, interface 0.0.9). Butuh
   * `cargo near build non-reproducible-wasm --manifest-path probes/mock_intents/Cargo.toml` di `contracts`. Bawaan: akun kosong.
   */
  mockIntents?: boolean;
};

export async function deployCircle(params: object = SHORT_PARAMS, options: DeployCircleOptions = {}): Promise<CircleFixture> {
  const sandbox = await startSandbox();
  try {
    const usdt = await sandbox.createAccount("usdt", "10");
    await sandbox.deploy(usdt, MOCK_FT_WASM);
    await usdt.call({ receiverId: usdt.accountId, methodName: "new", args: {}, deposit: 0n });

    let intents: SandboxAccount | undefined;
    if (options.mockIntents) {
      assertMockIntentsWasm();
      intents = await sandbox.createAccount("intents", "10");
      await sandbox.deploy(intents, MOCK_INTENTS_WASM);
      const initialized = await intents.call({ receiverId: intents.accountId, methodName: "new", args: {}, deposit: 0n });
      if (initialized.failures.length > 0) throw new Error(`mock_intents new failed: ${initialized.failures.join("; ")}`);
    }

    const circle = await sandbox.createAccount("x207-circle", "100");
    await sandbox.deploy(circle, CIRCLE_WASM);
    const created = await circle.call({
      receiverId: circle.accountId,
      methodName: "new",
      args: {
        owner_id: `dao.${sandbox.rootAccountId}`, circle_id: "agents-main", usdt_token_id: usdt.accountId,
        intents_id: intents?.accountId ?? `intents.${sandbox.rootAccountId}`, params,
      },
      deposit: 0n,
    });
    if (created.failures.length > 0) throw new Error(`new failed: ${created.failures.join("; ")}`);

    const members = new Map<string, SandboxAccount>();
    return {
      sandbox, circleId: "agents-main", circle, usdt, ...(intents ? { intents } : {}), members,
      async member(name) {
        const existing = members.get(name);
        if (existing) return existing;
        const account = await sandbox.createAccount(name, "20");
        const minted = await usdt.call({
          receiverId: usdt.accountId, methodName: "mint",
          args: { account_id: account.accountId, amount: (1000n * CREDIT).toString() }, deposit: 0n,
        });
        if (minted.failures.length > 0) throw new Error(`mint failed: ${minted.failures.join("; ")}`);
        members.set(name, account);
        return account;
      },
      stop: () => sandbox.stop(),
    };
  } catch (error) {
    await sandbox.stop();
    throw error;
  }
}
