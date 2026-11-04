// Client voucher state store (x402 Binding Spec 5.2). State key: (payer, payee, epoch).
import type { AccountId, U128String } from "@x207/core";

export type VoucherPairKey = { payer: AccountId; payee: AccountId; epoch: number };

/** `seq` and `cumulativeAmount` of the last confirmed voucher; `{0, "0"}` if none yet. */
export type VoucherState = { seq: number; cumulativeAmount: U128String };

export interface VoucherStateStore {
  get(key: VoucherPairKey): Promise<VoucherState>;
  /** Called only after `PAYMENT-RESPONSE` `success: true`, or on resynchronisation. */
  commit(key: VoucherPairKey, state: VoucherState): Promise<void>;
}

const storeKey = ({ payer, payee, epoch }: VoucherPairKey): string =>
  JSON.stringify([payer, payee, epoch]);

export class MemoryVoucherStateStore implements VoucherStateStore {
  private readonly states = new Map<string, VoucherState>();

  async get(key: VoucherPairKey): Promise<VoucherState> {
    return { ...(this.states.get(storeKey(key)) ?? { seq: 0, cumulativeAmount: "0" }) };
  }

  async commit(key: VoucherPairKey, state: VoucherState): Promise<void> {
    this.states.set(storeKey(key), { ...state });
  }
}
