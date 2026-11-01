// Peran client binding x207 (SD-015). `createPaymentPayload` diisi SD-018.
import type {
  DefaultAsset,
  PaymentPayloadResult,
  SchemeNetworkClient,
} from "@x402/core/types";
import { CREDIT_DECIMALS } from "@x207/core";
import { NotImplementedError, X207_SCHEME } from "../shared/circle.js";

const USD_CREDIT: DefaultAsset = { asset: "USD", decimals: CREDIT_DECIMALS, symbol: "USD" };

export class X207SchemeClient implements SchemeNetworkClient {
  readonly scheme = X207_SCHEME;

  /**
   * Tanpa ini `x402Client` menolak entri `asset: "USD"` lewat spendControls bawaannya, karena
   * "USD" bukan aset bawaan network mana pun.
   */
  findDefaultAsset(asset: string): DefaultAsset | undefined {
    return asset === USD_CREDIT.asset ? USD_CREDIT : undefined;
  }

  async createPaymentPayload(): Promise<PaymentPayloadResult> {
    throw new NotImplementedError("X207SchemeClient.createPaymentPayload", "SD-018");
  }
}
