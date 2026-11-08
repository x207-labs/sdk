// Entry selection on the client (SD-019, x402 Binding Spec 5.2): an x207 voucher if headroom is enough,
// otherwise another entry (`exact` near:mainnet), with no extra code in the agent.
import { x402Client } from "@x402/core/client";
import type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
} from "@x402/core/types";
import type { AccountId, VoucherSecretKey } from "@x207/core";
import type { VoucherSigner } from "@x207/core/signers";
import { X207_SCHEME } from "../shared/circle.js";
import { X207SchemeClient, type SpendLimit, type X207ClientOptions } from "./index.js";
import type { VoucherStateStore } from "./store.js";

type SelectPaymentRequirements = (
  x402Version: number,
  accepts: PaymentRequirements[],
) => PaymentRequirements;

export const X207_NETWORK_PREFIX = "x207:";
/** Headroom estimate cache of at most 60 seconds (K-34). */
export const HEADROOM_CACHE_MS = 60_000;

export const isX207Requirements = (requirements: PaymentRequirements): boolean =>
  requirements.scheme === X207_SCHEME && requirements.network.startsWith(X207_NETWORK_PREFIX);

const circleOf = (requirements: PaymentRequirements): string | undefined => {
  const circle = (requirements.extra as { circleContract?: unknown } | undefined)?.circleContract;
  return typeof circle === "string" ? circle : undefined;
};

/**
 * Reads the circle contract's `headroom(account_id)` view. `"0"` for members that are not `active`;
 * `null` if not a member.
 */
export type HeadroomSource = (circleContract: AccountId, payer: AccountId) => Promise<string | null>;

type Entry = { value: bigint; at: number };

export type HeadroomEstimatorOptions = {
  payer: AccountId;
  source: HeadroomSource;
  cacheMs?: number;
  now?: () => number;
};

/**
 * Payer headroom estimate per circle contract: the `headroom` view with a cache, minus the `amount`
 * already paid through x207 since the cache was read. Unknown (view failed) means `undefined`.
 */
export class HeadroomEstimator {
  private readonly payer: AccountId;
  private readonly source: HeadroomSource;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(options: HeadroomEstimatorOptions) {
    this.payer = options.payer;
    this.source = options.source;
    this.cacheMs = options.cacheMs ?? HEADROOM_CACHE_MS;
    this.now = options.now ?? Date.now;
  }

  /** Re-read the view if the cache is empty or older than `cacheMs`. A view failure does not throw. */
  async ensureFresh(circleContract: AccountId): Promise<void> {
    const entry = this.entries.get(circleContract);
    if (entry && this.now() - entry.at < this.cacheMs) return;
    try {
      const raw = await this.source(circleContract, this.payer);
      this.entries.set(circleContract, { value: raw === null ? 0n : BigInt(raw), at: this.now() });
    } catch {
      this.entries.delete(circleContract);
    }
  }

  estimate(circleContract: AccountId): bigint | undefined {
    return this.entries.get(circleContract)?.value;
  }

  /** Reduce headroom after a voucher worth `amount` is accepted. */
  consume(circleContract: AccountId, amount: string): void {
    const entry = this.entries.get(circleContract);
    if (!entry) return;
    entry.value = entry.value > BigInt(amount) ? entry.value - BigInt(amount) : 0n;
  }

  /** The server rejects `insufficient_credit`: treat as used up until the cache is re-read. */
  markExhausted(circleContract: AccountId): void {
    this.entries.set(circleContract, { value: 0n, at: this.now() });
  }
}

export class NoPayableRequirementsError extends Error {
  constructor() {
    super("no entry can be paid: x207 headroom is not enough and no other entry is supported");
    this.name = "NoPayableRequirementsError";
  }
}

export type BundleLookup = (payee: AccountId, epoch: number) => number | undefined;

/** x207 entry that pays a bundle leg: does not use free headroom, so it is not checked and does not reduce the estimate. */
const isBundleLeg = (requirements: PaymentRequirements, bundleFor: BundleLookup | undefined): boolean => {
  const epoch = (requirements.extra as { epoch?: unknown } | undefined)?.epoch;
  return bundleFor !== undefined && typeof epoch === "number" && bundleFor(requirements.payTo, epoch) !== undefined;
};

/** Pick x207 if headroom is enough (or unknown) or if the payment is a bundle leg, otherwise the first non-x207 entry. */
export function selectX207Requirements(estimator: HeadroomEstimator, bundleFor?: BundleLookup): SelectPaymentRequirements {
  return (_version, accepts) => {
    const payable = accepts.find((requirements) => {
      if (!isX207Requirements(requirements)) return false;
      if (isBundleLeg(requirements, bundleFor)) return true;
      const circle = circleOf(requirements);
      const headroom = circle === undefined ? undefined : estimator.estimate(circle);
      return headroom === undefined || headroom >= BigInt(requirements.amount);
    });
    const chosen = payable ?? accepts.find((requirements) => !isX207Requirements(requirements));
    if (!chosen) throw new NoPayableRequirementsError();
    return chosen;
  };
}

/** Rejections recoverable by falling back to the `exact` entry: headroom used up (SD-019) and payer left (TC-SD-033-07). */
const RECOVERABLE_REASONS = new Set(["insufficient_credit", "member_exiting"]);

export type X207PaymentClientOptions = {
  payer: AccountId;
  /** The payer's ed25519 voucher key (ADR-06), not a NEAR access key. Give this or `signer`. */
  secretKey?: VoucherSecretKey;
  /** Async signer, e.g. an EVM agent (SD-088); see `X207ClientOptions.signer`. Give this or `secretKey`. */
  signer?: VoucherSigner;
  headroom: HeadroomSource;
  store?: VoucherStateStore;
  /** F5 bundle leg (SD-048); see `X207ClientOptions.bundleFor`. */
  bundleFor?: BundleLookup;
  /** Owner's local spend limit (SD-020); see `X207ClientOptions.spendLimit`. */
  spendLimit?: SpendLimit;
  /** What a 402 may name (circles, payees, the open epoch); see `X207ClientOptions.accept`. */
  accept?: X207ClientOptions["accept"];
  headroomCacheMs?: number;
  now?: () => number;
};

/**
 * An `x402Client` that has registered `x207:*` and chooses between the voucher and other entries.
 * The agent only registers its own NEAR `exact` (`register("near:*", …)`) and then uses
 * `wrapFetchWithPayment`; falling back to `exact` after `insufficient_credit` happens automatically.
 */
export class X207PaymentClient extends x402Client {
  readonly headroom: HeadroomEstimator;
  readonly x207: X207SchemeClient;

  constructor(options: X207PaymentClientOptions) {
    const headroom = new HeadroomEstimator({
      payer: options.payer,
      source: options.headroom,
      ...(options.headroomCacheMs !== undefined ? { cacheMs: options.headroomCacheMs } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    super(selectX207Requirements(headroom, options.bundleFor));
    this.headroom = headroom;
    this.x207 = new X207SchemeClient({
      payer: options.payer,
      ...(options.secretKey !== undefined ? { secretKey: options.secretKey } : {}),
      ...(options.signer !== undefined ? { signer: options.signer } : {}),
      ...(options.store ? { store: options.store } : {}),
      ...(options.bundleFor ? { bundleFor: options.bundleFor } : {}),
      ...(options.spendLimit ? { spendLimit: options.spendLimit } : {}),
      ...(options.accept ? { accept: options.accept } : {}),
    });
    this.register("x207:*", this.x207);

    this.onPaymentResponse(async (context) => {
      const { requirements } = context;
      if (!isX207Requirements(requirements)) return undefined;
      const circle = circleOf(requirements);
      if (circle === undefined) return undefined;
      if (context.settleResponse?.success) {
        if (!isBundleLeg(requirements, options.bundleFor)) this.headroom.consume(circle, requirements.amount);
        return undefined;
      }
      if (RECOVERABLE_REASONS.has(context.paymentRequired?.error ?? "")) {
        this.headroom.markExhausted(circle);
        return { recovered: true };
      }
      return undefined;
    });
  }

  override async createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload> {
    const circles = new Set(
      paymentRequired.accepts.filter(isX207Requirements).map(circleOf).filter((c): c is string => c !== undefined),
    );
    await Promise.all([...circles].map((circle) => this.headroom.ensureFresh(circle)));
    return super.createPaymentPayload(paymentRequired);
  }
}
