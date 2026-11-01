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

export type X207FacilitatorOptions = {
  network: string;
  circleContract: AccountId;
  /** Akun relayer yang mengirim `register_cumulative`. */
  signers?: readonly AccountId[];
};

export class X207SchemeFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = X207_SCHEME;
  readonly caipFamily = X207_NETWORK_FAMILY;
  readonly circle: CircleConfig;
  private readonly signers: readonly AccountId[];

  constructor(options: X207FacilitatorOptions) {
    this.circle = defineCircleConfig(options);
    this.signers = options.signers ?? [];
  }

  getExtra(): Record<string, unknown> | undefined {
    throw new NotImplementedError("X207SchemeFacilitator.getExtra", "SD-016");
  }

  getSigners(_network?: string): string[] {
    return [...this.signers];
  }

  async verify(_payload?: PaymentPayload, _requirements?: PaymentRequirements): Promise<VerifyResponse> {
    throw new NotImplementedError("X207SchemeFacilitator.verify", "SD-024");
  }

  async settle(_payload?: PaymentPayload, _requirements?: PaymentRequirements): Promise<SettleResponse> {
    throw new NotImplementedError("X207SchemeFacilitator.settle", "SD-026");
  }
}
