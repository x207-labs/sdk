// Fixture lingkaran di near-sandbox: kontrak `x207-circle`, mock NEP-141 sebagai USDT, dan akun anggota.
import { CIRCLE_WASM, MOCK_FT_WASM, Sandbox, SandboxAccount, startSandbox } from "./sandbox.js";

/** Jendela pendek di dalam rentang sah (Spec Antarmuka Kontrak 3.4), sama dengan `short_params` di contracts. */
export const SHORT_PARAMS = {
  epoch_length: 300, payment_window: 900, proposal_window: 60, base_limit_ratio: 8000,
  limit_growth: 1000, limit_cap: "1000000000", limit_decay: 0,
  fees: { clearing_fee_bps: 0, solver_fee_bps: 0 }, admission: "open",
};

export const CREDIT = 1_000_000n;
export const TERMS_HASH = "a".repeat(64);

export type CircleFixture = {
  sandbox: Sandbox;
  circleId: string;
  circle: SandboxAccount;
  usdt: SandboxAccount;
  /** Akun anggota yang dibuat `member()`, dengan 1.000 USDT mock. */
  members: Map<string, SandboxAccount>;
  member(name: string): Promise<SandboxAccount>;
  stop(): Promise<void>;
};

/** Sandbox baru dengan kontrak ter-deploy dan di-`new`. */
export async function deployCircle(params: object = SHORT_PARAMS): Promise<CircleFixture> {
  const sandbox = await startSandbox();
  try {
    const usdt = await sandbox.createAccount("usdt", "10");
    await sandbox.deploy(usdt, MOCK_FT_WASM);
    await usdt.call({ receiverId: usdt.accountId, methodName: "new", args: {}, deposit: 0n });

    const circle = await sandbox.createAccount("x207-circle", "100");
    await sandbox.deploy(circle, CIRCLE_WASM);
    const created = await circle.call({
      receiverId: circle.accountId,
      methodName: "new",
      args: {
        owner_id: `dao.${sandbox.rootAccountId}`, circle_id: "agents-main", usdt_token_id: usdt.accountId,
        intents_id: `intents.${sandbox.rootAccountId}`, params,
      },
      deposit: 0n,
    });
    if (created.failures.length > 0) throw new Error(`new gagal: ${created.failures.join("; ")}`);

    const members = new Map<string, SandboxAccount>();
    return {
      sandbox, circleId: "agents-main", circle, usdt, members,
      async member(name) {
        const existing = members.get(name);
        if (existing) return existing;
        const account = await sandbox.createAccount(name, "20");
        const minted = await usdt.call({
          receiverId: usdt.accountId, methodName: "mint",
          args: { account_id: account.accountId, amount: (1000n * CREDIT).toString() }, deposit: 0n,
        });
        if (minted.failures.length > 0) throw new Error(`mint gagal: ${minted.failures.join("; ")}`);
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
