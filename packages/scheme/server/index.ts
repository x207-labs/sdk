// x207 binding server role (SD-015, SD-016): price, `extra` from the facilitator, and requirements.
import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { CREDIT_DECIMALS, CREDIT_UNIT, USDT_TOKEN_ID, type AccountId, type X207Extra } from "@x207/core";
import { assertCircleId, X207_SCHEME } from "../shared/circle.js";
import type { X207ExtraSource } from "./extra.js";
import type { MeterAnnouncement } from "./metering.js";
import { priceToAmount } from "./price.js";

export * from "./extra.js";
export * from "./middleware.js";
export * from "./endpoint-adapter.js";
export * from "./price.js";
export * from "./metering.js";
export * from "./metered-job.js";
export * from "./metered-endpoint.js";
export * from "./job-escrow.js";

/** `maxTimeoutSeconds` x402 (ADR-25). */
export const MAX_TIMEOUT_SECONDS = 60;
export const EXACT_NEAR_NETWORK = "near:mainnet";

export type X207SchemeServerOptions = {
  /** Source of `extra` (epoch and contract account) from the facilitator's `GET /supported`. */
  extra?: X207ExtraSource;
};

export class X207SchemeServer implements SchemeNetworkServer {
  readonly scheme = X207_SCHEME;
  readonly defaultAssetTransferMethod = "default";
  /** Verify before the handler, settle after it; a 5xx handler response is not billed (Binding Spec 5.3). */
  readonly paymentFlows = {
    default: { supported: ["authorization"], default: "authorization" },
  } as const;
  /** `epoch` changes every epoch; x402 does not compare it between requirements and `accepted`. */
  readonly dynamicExtraFields = ["epoch"];

  private readonly extra: X207ExtraSource | undefined;

  constructor(options: X207SchemeServerOptions = {}) {
    this.extra = options.extra;
  }

  getAssetDecimals(asset: string): number | undefined {
    return asset === "USD" ? CREDIT_DECIMALS : undefined;
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    assertCircleId(network);
    if (typeof price === "object") {
      if (price.asset !== "USD") throw new Error(`asset must be "USD", got ${JSON.stringify(price.asset)}`);
      if (!/^[1-9]\d*$/.test(price.amount)) throw new Error(`amount must be an integer > 0, got ${JSON.stringify(price.amount)}`);
      return { amount: price.amount, asset: "USD", extra: price.extra ?? (await this.extra?.get(network)) ?? staticExtra() };
    }
    const amount = priceToAmount(price);
    return { amount, asset: "USD", extra: (await this.extra?.get(network)) ?? staticExtra() };
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: SupportedKind,
    _facilitatorExtensions?: string[],
  ): Promise<PaymentRequirements> {
    const fromFacilitator = (supportedKind.extra ?? {}) as Partial<X207Extra>;
    return {
      ...requirements,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds || MAX_TIMEOUT_SECONDS,
      extra: { ...staticExtra(), ...fromFacilitator, ...requirements.extra },
    };
  }
}

const staticExtra = () => ({ unit: CREDIT_UNIT, decimals: CREDIT_DECIMALS });

export type BuildPaymentRequirementsOptions = {
  circleId: string;
  payTo: AccountId;
  price: string | number;
  /** Resource URL; used by the middleware for `PaymentRequired.resource`, not part of the requirements. */
  resource?: string;
  extra: X207ExtraSource;
  /** Amount already computed (SD-062, metered price): used instead of `price`. */
  amount?: string;
  /** Metered price announcement (SD-062): `extra.meter` in the x207 entry. */
  meter?: MeterAnnouncement;
  /** F8 grant endpoint (SD-053): `extra.grantId` in the x207 entry; `payTo` must be the grant giver, not the broker account. */
  grantId?: number;
};

/** The `batch-settlement` entry `x207:<circleId>` then the `exact` `near:mainnet` USDT entry (Spec Binding 5.3). */
export async function buildPaymentRequirements(
  options: BuildPaymentRequirementsOptions,
): Promise<PaymentRequirements[]> {
  const network = `x207:${options.circleId}`;
  assertCircleId(network);
  const amount = options.amount ?? priceToAmount(options.price);
  const extra = await options.extra.get(network);
  return [
    {
      scheme: X207_SCHEME,
      network,
      amount,
      asset: "USD",
      payTo: options.payTo,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: {
        circleContract: extra.circleContract, unit: extra.unit, decimals: extra.decimals, epoch: extra.epoch,
        ...(options.grantId === undefined ? {} : { grantId: options.grantId }),
        ...(options.meter === undefined ? {} : { meter: options.meter }),
      },
    },
    {
      scheme: "exact",
      network: EXACT_NEAR_NETWORK,
      amount,
      asset: USDT_TOKEN_ID,
      payTo: options.payTo,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: {},
    },
  ];
}
