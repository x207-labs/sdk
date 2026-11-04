// Headroom includes pending vouchers and the per-pair voucher base (x402 Binding Spec 6.1, ADR-17).
import type { AccountId, ContractAbi, PairState, U128String } from "@x207/core";

export type PendingVoucherRef = {
  payee: AccountId;
  seq: number;
  cumulativeAmount: U128String;
  /** Failed registration attempts (ADR-23); absent means 0. */
  attempts?: number;
  /** Bundle leg voucher (SD-048): uses the leg reserve, so it does not reduce free headroom. */
  bundleId?: number | null;
};

/** On-chain reads and the D3 pending store needed by the facilitator. */
export interface HeadroomSources {
  /** View `headroom(account_id)`: `max(0, limit - outstanding_debt)`, `"0"` if not `active`. */
  headroom(account: AccountId): Promise<U128String>;
  /** View `obligation(epoch, debtor, creditor)`; `null` if none yet. */
  obligation(
    epoch: number,
    debtor: AccountId,
    creditor: AccountId,
  ): Promise<Pick<ContractAbi.ObligationView, "cumulative" | "last_seq"> | null>;
  /** Pending rows of the payer in `epoch` (one per payee). */
  pendingByPayer(payer: AccountId, epoch: number): Promise<readonly PendingVoucherRef[]>;
}

export type VoucherBase = Pick<PairState, "source"> & { seq: number; cumulativeAmount: U128String };

/**
 * `base(p, q)`: the pending row if there is one, otherwise the cumulative registered in `obligation`, otherwise `seq 0`.
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
 * Only the pending increase above the registered cumulative is subtracted, because the registered cumulative
 * is already in `outstanding_debt` (ADR-32 K-27). The result is never negative.
 */
export async function computeHeadroom(
  payer: AccountId,
  epoch: number,
  sources: HeadroomSources,
): Promise<U128String> {
  const [onchain, rows] = await Promise.all([sources.headroom(payer), sources.pendingByPayer(payer, epoch)]);
  const unregistered = await Promise.all(
    rows.map(async (row) => {
      if (row.bundleId !== undefined && row.bundleId !== null) return 0n;
      const registered = await sources.obligation(epoch, payer, row.payee);
      const increase = BigInt(row.cumulativeAmount) - BigInt(registered?.cumulative ?? "0");
      return increase > 0n ? increase : 0n;
    }),
  );
  const remaining = unregistered.reduce((left, amount) => left - amount, BigInt(onchain));
  return (remaining > 0n ? remaining : 0n).toString();
}
