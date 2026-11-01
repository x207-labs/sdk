// Penyimpanan state voucher klien (Spec Binding x402 5.2). Kunci state: (payer, payee, epoch).
import type { AccountId, U128String } from "@x207/core";

export type VoucherPairKey = { payer: AccountId; payee: AccountId; epoch: number };

/** `seq` dan `cumulativeAmount` voucher terakhir yang dikonfirmasi; `{0, "0"}` bila belum ada. */
export type VoucherState = { seq: number; cumulativeAmount: U128String };

export interface VoucherStateStore {
  get(key: VoucherPairKey): Promise<VoucherState>;
  /** Dipanggil hanya setelah `PAYMENT-RESPONSE` `success: true`, atau saat resinkronisasi. */
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
