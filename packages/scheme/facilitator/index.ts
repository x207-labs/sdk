// Role of the x207 binding facilitator (SD-015). `verify` is filled by SD-024, `settle` by SD-026, `getExtra` by SD-016.
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { CREDIT_DECIMALS, CREDIT_UNIT, type AccountId } from "@x207/core";
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

/** Source of the running epoch (`get_epoch` view) for `extra.epoch` in `/supported` (SD-032). */
export interface EpochSource {
  currentEpoch(): Promise<number>;
}

/** Maximum age of the cached `extra.epoch` (TC-SD-032-02). */
export const EXTRA_EPOCH_TTL_MS = 60_000;

export type X207FacilitatorOptions = {
  network: string;
  circleContract: AccountId;
  /** Relayer account that sends `register_cumulative`. */
  signers?: readonly AccountId[];
  /** Data source for `verify` (SD-024); without it `verify` throws `NotImplementedError`. */
  verify?: VerifyOptions;
  /** D3 pending store for `settle` (SD-026); without it `settle` throws `NotImplementedError`. */
  store?: PendingWriter;
  /** Source of `extra.epoch`; without it `getExtra` throws `NotImplementedError`. */
  epochSource?: EpochSource;
  /** Current time in ms; default `Date.now`. */
  now?: () => number;
};

export class X207SchemeFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = X207_SCHEME;
  readonly caipFamily = X207_NETWORK_FAMILY;
  readonly circle: CircleConfig;
  private readonly signers: readonly AccountId[];
  private readonly verifyOptions: VerifyOptions | undefined;
  private readonly store: PendingWriter | undefined;
  private readonly epochSource: EpochSource | undefined;
  private readonly now: () => number;
  private cachedEpoch: { value: number; at: number } | undefined;

  constructor(options: X207FacilitatorOptions) {
    this.circle = defineCircleConfig(options);
    this.signers = options.signers ?? [];
    this.verifyOptions = options.verify;
    this.store = options.store;
    this.epochSource = options.epochSource;
    this.now = options.now ?? Date.now;
  }

  /** Re-read the epoch if the cache is empty or older than `EXTRA_EPOCH_TTL_MS`. Called before `getSupported`. */
  async refreshExtra(): Promise<void> {
    if (!this.epochSource) throw new NotImplementedError("X207SchemeFacilitator.refreshExtra", "SD-032");
    if (this.cachedEpoch && this.now() - this.cachedEpoch.at < EXTRA_EPOCH_TTL_MS) return;
    this.cachedEpoch = { value: await this.epochSource.currentEpoch(), at: this.now() };
  }

  getExtra(): Record<string, unknown> | undefined {
    if (!this.epochSource) throw new NotImplementedError("X207SchemeFacilitator.getExtra", "SD-032");
    return {
      circleContract: this.circle.circleContract,
      unit: CREDIT_UNIT,
      decimals: CREDIT_DECIMALS,
      ...(this.cachedEpoch ? { epoch: this.cachedEpoch.value } : {}),
    };
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
