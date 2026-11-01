// Headroom termasuk voucher pending dan basis voucher per pasangan (Spec Binding x402 6.1, ADR-17).
import type { AccountId, ContractAbi, PairState, U128String } from "@x207/core";

export type PendingVoucherRef = {
  payee: AccountId;
  seq: number;
  cumulativeAmount: U128String;
};

/** Pembacaan on-chain dan pending store D3 yang dibutuhkan facilitator. */
export interface HeadroomSources {
  /** View `headroom(account_id)`: `max(0, limit - outstanding_debt)`, `"0"` bila tidak `active`. */
  headroom(account: AccountId): Promise<U128String>;
  /** View `obligation(epoch, debtor, creditor)`; `null` bila belum ada. */
  obligation(
    epoch: number,
    debtor: AccountId,
    creditor: AccountId,
  ): Promise<Pick<ContractAbi.ObligationView, "cumulative" | "last_seq"> | null>;
  /** Baris pending payer di `epoch` (satu per payee). */
  pendingByPayer(payer: AccountId, epoch: number): Promise<readonly PendingVoucherRef[]>;
}

export type VoucherBase = Pick<PairState, "source"> & { seq: number; cumulativeAmount: U128String };

/**
 * `base(p, q)`: baris pending bila ada, selain itu kumulatif terdaftar di `obligation`, selain itu `seq 0`.
 */
export async function computeBase(
  payer: AccountId,
  payee: AccountId,
  epoch: number,
  sources: HeadroomSources,
): Promise<VoucherBase> {
  const pending = (await sources.pendingByPayer(payer, epoch)).find((row) => row.payee === payee);
  if (pending) return { seq: pending.seq, cumulativeAmount: pending.cumulativeAmount, source: "pending" };
  const registered = await sources.obligation(epoch, payer, payee);
  if (registered) return { seq: registered.last_seq, cumulativeAmount: registered.cumulative, source: "onchain" };
  return { seq: 0, cumulativeAmount: "0", source: "none" };
}

/**
 * `computeHeadroom(p) = max(0, headroom(p) - sum_q max(0, pending(p, q, e) - registered(p, q, e)))`.
 * Hanya kenaikan pending di atas kumulatif terdaftar yang dikurangkan, karena kumulatif terdaftar
 * sudah ada di `outstanding_debt` (ADR-32 K-27). Hasil tidak pernah negatif.
 */
export async function computeHeadroom(
  payer: AccountId,
  epoch: number,
  sources: HeadroomSources,
): Promise<U128String> {
  const [onchain, rows] = await Promise.all([sources.headroom(payer), sources.pendingByPayer(payer, epoch)]);
  const unregistered = await Promise.all(
    rows.map(async (row) => {
      const registered = await sources.obligation(epoch, payer, row.payee);
      const increase = BigInt(row.cumulativeAmount) - BigInt(registered?.cumulative ?? "0");
      return increase > 0n ? increase : 0n;
    }),
  );
  const remaining = unregistered.reduce((left, amount) => left - amount, BigInt(onchain));
  return (remaining > 0n ? remaining : 0n).toString();
}
