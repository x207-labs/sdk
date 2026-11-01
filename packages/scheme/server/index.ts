// Peran server binding x207 (SD-015). `parsePrice` dan `enhancePaymentRequirements` diisi SD-016.
import type {
  AssetAmount,
  PaymentRequirements,
  SchemeNetworkServer,
} from "@x402/core/types";
import { NotImplementedError, X207_SCHEME } from "../shared/circle.js";

export class X207SchemeServer implements SchemeNetworkServer {
  readonly scheme = X207_SCHEME;
  readonly defaultAssetTransferMethod = "default";
  /** Verify sebelum handler, settle sesudahnya; handler 5xx tidak ditagih (Spec Binding 5.3). */
  readonly paymentFlows = {
    default: { supported: ["authorization"], default: "authorization" },
  } as const;

  async parsePrice(): Promise<AssetAmount> {
    throw new NotImplementedError("X207SchemeServer.parsePrice", "SD-016");
  }

  async enhancePaymentRequirements(): Promise<PaymentRequirements> {
    throw new NotImplementedError("X207SchemeServer.enhancePaymentRequirements", "SD-016");
  }
}
