// Peran facilitator binding x207 (SD-015). `verify` diisi SD-024, `settle` SD-026, `getExtra` SD-016.
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { AccountId } from "@x207/core";
import {
  NotImplementedError,
  X207_NETWORK_FAMILY,
  X207_SCHEME,
  defineCircleConfig,
  type CircleConfig,
} from "../shared/circle.js";
import { settlePayment } from "./settle.js";
import type { PendingWriter } from "./settle.js";
import { verifyPayment, type VerifyOptions } from "./verify.js";

export type X207FacilitatorOptions = {
  network: string;
  circleContract: AccountId;
  /** Akun relayer yang mengirim `register_cumulative`. */
  signers?: readonly AccountId[];
  /** Sumber data `verify` (SD-024); tanpa ini `verify` melempar `NotImplementedError`. */
  verify?: VerifyOptions;
  /** Pending store D3 untuk `settle` (SD-026); tanpa ini `settle` melempar `NotImplementedError`. */
  store?: PendingWriter;
};

export class X207SchemeFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = X207_SCHEME;
  readonly caipFamily = X207_NETWORK_FAMILY;
  readonly circle: CircleConfig;
  private readonly signers: readonly AccountId[];
  private readonly verifyOptions: VerifyOptions | undefined;
  private readonly store: PendingWriter | undefined;

  constructor(options: X207FacilitatorOptions) {
    this.circle = defineCircleConfig(options);
    this.signers = options.signers ?? [];
    this.verifyOptions = options.verify;
    this.store = options.store;
  }

  getExtra(): Record<string, unknown> | undefined {
    throw new NotImplementedError("X207SchemeFacilitator.getExtra", "SD-016");
  }

  getSigners(_network?: string): string[] {
    return [...this.signers];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    if (!this.verifyOptions) throw new NotImplementedError("X207SchemeFacilitator.verify", "SD-024");
    return verifyPayment(this.circle, this.verifyOptions, payload, requirements);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    if (!this.verifyOptions || !this.store) throw new NotImplementedError("X207SchemeFacilitator.settle", "SD-026");
    return settlePayment(this.circle, { ...this.verifyOptions, store: this.store }, payload, requirements);
  }
}

export * from "./headroom.js";
export * from "./settle.js";
export * from "./verify.js";
