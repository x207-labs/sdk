// Role of the x207 client binding (SD-015, SD-018): cumulative vouchers per (payer, payee, epoch).
import type { PaymentCreationContext, PaymentResponseContext } from "@x402/core/client";
import type {
  DefaultAsset,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeClientHooks,
  SchemeNetworkClient,
} from "@x402/core/types";
import {
  CREDIT_DECIMALS,
  CREDIT_UNIT,
  grantResource,
  validatePaymentRequirements,
  type AccountId,
  type UnsignedVoucher,
  type VoucherSecretKey,
  type X207Payload,
} from "@x207/core";
import { ed25519Signer, type VoucherSigner } from "@x207/core/signers";
import type { BuyerMeter } from "./buyer-meter.js";
import type { MeterAnnouncement } from "../server/metering.js";
import { X207_SCHEME } from "../shared/circle.js";
import {
  MemoryVoucherStateStore,
  type VoucherPairKey,
  type VoucherState,
  type VoucherStateStore,
} from "./store.js";

export * from "./store.js";

const USD_CREDIT: DefaultAsset = { asset: "USD", decimals: CREDIT_DECIMALS, symbol: "USD" };
const U128_MAX = 340282366920938463463374607431768211455n;
const UINT_STRING = /^(?:0|[1-9]\d*)$/;

/** Local spending limit from the agent owner, in the smallest credit unit (decimal string). Checked before the voucher is signed. */
export type SpendLimit = {
  /** Limit for a single paid call. */
  maxPerCall?: string;
  /** Limit for the total of all payments by this payer in one epoch (across payees). */
  maxPerEpoch?: string;
};

/** Payment rejected by the client because of the owner's spending limit; no voucher was signed. */
export class SpendLimitError extends Error {
  readonly limit: "per_call" | "per_epoch";
  readonly amount: string;
  readonly max: string;
  readonly spent: string;

  constructor(limit: "per_call" | "per_epoch", amount: bigint, max: bigint, spent: bigint) {
    super(
      limit === "per_call"
        ? `spend limit per call exceeded: ${amount} > ${max}`
        : `spend limit per epoch exceeded: ${spent} spent + ${amount} > ${max}`,
    );
    this.name = "SpendLimitError";
    this.limit = limit;
    this.amount = amount.toString();
    this.max = max.toString();
    this.spent = spent.toString();
  }
}

export type X207ClientOptions = {
  payer: AccountId;
  /** ed25519 voucher key of the payer (ADR-06), not a NEAR access key. Give this or `signer`. */
  secretKey?: VoucherSecretKey;
  /** Async signer (SD-088), e.g. `evmSigner(privateKeyToAccount(key))` from `@x207/core/evm`; then `payer` is its `id` (the `0x` address). Give this or `secretKey`. */
  signer?: VoucherSigner;
  store?: VoucherStateStore;
  /**
   * Limit on waiting for a response before an unconfirmed voucher is released without commit, so
   * the queue does not stall if the connection drops. Default 60 seconds = `maxTimeoutSeconds` (ADR-25).
   */
  confirmTimeoutMs?: number;
  /**
   * F5 bundle leg (SD-048): `bundle_id` for payment to `payee` in `epoch`, or `undefined` if not a leg. A leg voucher is the same
   * bytes as a plain voucher; `bundleId` in the payload makes the facilitator check the leg limit and register via
   * `register_in_bundle` (reserved leg headroom).
   */
  bundleFor?: (payee: AccountId, epoch: number) => number | undefined;
  /** Local spending limit (SD-020): a voucher that exceeds it is not signed even if the contract headroom is sufficient. */
  spendLimit?: SpendLimit;
  /** The buyer's own count (SD-068): a 402 that announces `extra.meter` must match what the buyer requested, otherwise no voucher is signed. */
  meter?: BuyerMeter;
};

type InFlight = {
  epoch: number;
  amount: bigint;
  key: VoucherPairKey;
  next: VoucherState;
  release: () => void;
  timer: ReturnType<typeof setTimeout>;
};

type Resync = { epoch: number; lastSeq: number; lastCumulativeAmount: string };

/** `extensions.x207` on the rejection `PAYMENT-RESPONSE` (Spec Binding 5.2, K-29). */
function readResync(response: PaymentResponseContext["settleResponse"]): Resync | null {
  const ext = (response?.extensions as Record<string, any> | undefined)?.x207;
  if (typeof ext !== "object" || ext === null) return null;
  const { epoch, lastSeq, lastCumulativeAmount } = ext;
  const validAmount =
    typeof lastCumulativeAmount === "string" &&
    UINT_STRING.test(lastCumulativeAmount) &&
    BigInt(lastCumulativeAmount) <= U128_MAX;
  return Number.isSafeInteger(epoch) && Number.isSafeInteger(lastSeq) && lastSeq >= 0 && validAmount
    ? { epoch, lastSeq, lastCumulativeAmount }
    : null;
}

export class X207SchemeClient implements SchemeNetworkClient {
  readonly scheme = X207_SCHEME;
  readonly store: VoucherStateStore;

  private readonly payer: AccountId;
  private readonly signer: VoucherSigner;
  private readonly confirmTimeoutMs: number;
  private readonly bundleFor: ((payee: AccountId, epoch: number) => number | undefined) | undefined;
  private readonly spendLimit: SpendLimit | undefined;
  private readonly meter: BuyerMeter | undefined;
  /** Spend per epoch already reserved: vouchers signed and not yet rejected by the server. */
  private readonly spent = new Map<number, bigint>();
  /** x402 `createPaymentPayload` does not accept `resource`; the before-creation hook passes it along. */
  private readonly resources = new WeakMap<PaymentRequirements, string>();
  private readonly inFlight = new WeakMap<X207Payload, InFlight>();
  /** Queue tail per (payer, payee): at most one unconfirmed voucher. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly retried = new WeakSet<X207Payload>();
  private readonly retryPending = new Set<string>();

  constructor(options: X207ClientOptions) {
    this.payer = options.payer;
    if ((options.secretKey === undefined) === (options.signer === undefined)) throw new Error("X207SchemeClient needs exactly one of secretKey and signer");
    if (options.signer !== undefined && options.signer.scheme === "eip712" && options.signer.id !== options.payer) {
      throw new Error(`payer must be the signer address ${options.signer.id}`);
    }
    this.signer = options.signer ?? ed25519Signer(options.secretKey as VoucherSecretKey);
    this.store = options.store ?? new MemoryVoucherStateStore();
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 60_000;
    this.bundleFor = options.bundleFor;
    this.spendLimit = options.spendLimit;
    this.meter = options.meter;
  }

  /** Spend in epoch `epoch` counted against `maxPerEpoch`. */
  spentInEpoch(epoch: number): bigint {
    return this.spent.get(epoch) ?? 0n;
  }

  private reserve(epoch: number, amount: bigint): void {
    const limit = this.spendLimit;
    const spent = this.spentInEpoch(epoch);
    if (limit?.maxPerCall !== undefined && amount > BigInt(limit.maxPerCall)) {
      throw new SpendLimitError("per_call", amount, BigInt(limit.maxPerCall), spent);
    }
    if (limit?.maxPerEpoch !== undefined && spent + amount > BigInt(limit.maxPerEpoch)) {
      throw new SpendLimitError("per_epoch", amount, BigInt(limit.maxPerEpoch), spent);
    }
    this.spent.set(epoch, spent + amount);
  }

  private refund(epoch: number, amount: bigint): void {
    this.spent.set(epoch, this.spentInEpoch(epoch) - amount);
  }

  readonly schemeHooks: SchemeClientHooks = {
    onBeforePaymentCreation: async (context: PaymentCreationContext) => {
      this.resources.set(context.selectedRequirements, context.paymentRequired.resource.url);
    },
    onPaymentResponse: (context) => this.onPaymentResponse(context),
  };

  /**
   * Without this `x402Client` rejects `asset: "USD"` entries through its default spendControls, because
   * "USD" is not a default asset of any network.
   */
  findDefaultAsset(asset: string): DefaultAsset | undefined {
    return asset === USD_CREDIT.asset ? USD_CREDIT : undefined;
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (x402Version !== 2) throw new Error(`x402Version ${x402Version} is not supported, must be 2`);
    const checked = validatePaymentRequirements(requirements);
    if (!checked.ok) throw new Error(`x207 requirements not valid: ${checked.field} ${checked.message}`);
    const { payTo, amount, extra } = checked.value;
    // Grant endpoint (SD-053): voucher resource = `x207:grant:<grantId>`, payee = the grantor's payTo (not the broker account serving its URL)
    const resource = extra.grantId === undefined ? this.resources.get(requirements) : grantResource(extra.grantId);
    if (resource === undefined) {
      throw new Error("resource.url unknown: build the payload through x402Client so the hook is installed");
    }

    this.meter?.authorize((requirements.extra as { meter?: MeterAnnouncement } | undefined)?.meter, amount);
    // Spending limit is checked and reserved synchronously, before the pair queue and before signVoucher.
    this.reserve(extra.epoch, BigInt(amount));
    const key: VoucherPairKey = { payer: this.payer, payee: payTo, epoch: extra.epoch };
    const pairId = JSON.stringify([key.payer, key.payee]);
    let release: () => void;
    try {
      release = await this.acquire(pairId);
    } catch (error) {
      this.refund(extra.epoch, BigInt(amount));
      throw error;
    }
    try {
      const last = await this.store.get(key);
      const next: VoucherState = {
        seq: last.seq + 1,
        cumulativeAmount: (BigInt(last.cumulativeAmount) + BigInt(amount)).toString(),
      };
      const unsigned: UnsignedVoucher = {
        circle: extra.circleContract,
        payer: this.payer,
        payee: payTo,
        epoch: extra.epoch,
        seq: next.seq,
        cumulativeAmount: next.cumulativeAmount,
        unit: CREDIT_UNIT,
        resource,
      };
      const { signature, ...voucher } = await this.signer.signVoucher(unsigned);
      const bundleId = this.bundleFor?.(payTo, extra.epoch);
      const payload: X207Payload = { voucher, signature, ...(bundleId === undefined ? {} : { bundleId }) };

      const timer = setTimeout(() => this.settleFlight(payload), this.confirmTimeoutMs);
      timer.unref?.();
      this.inFlight.set(payload, { key, next, release, timer, epoch: extra.epoch, amount: BigInt(amount) });
      if (this.retryPending.delete(pairId)) this.retried.add(payload);
      return { x402Version: 2, payload };
    } catch (error) {
      release();
      this.refund(extra.epoch, BigInt(amount));
      throw error;
    }
  }

  private acquire(pairId: string): Promise<() => void> {
    const previous = this.queues.get(pairId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => turn);
    this.queues.set(pairId, tail);
    void tail.then(() => {
      if (this.queues.get(pairId) === tail) this.queues.delete(pairId);
    });
    return previous.then(() => release);
  }

  /** Releases one voucher from the queue; returns its data, or `undefined` if already released. */
  private settleFlight(payload: X207Payload): InFlight | undefined {
    const flight = this.inFlight.get(payload);
    if (!flight) return undefined;
    this.inFlight.delete(payload);
    clearTimeout(flight.timer);
    flight.release();
    return flight;
  }

  private async onPaymentResponse(context: PaymentResponseContext): Promise<void | { recovered: true }> {
    const payload = context.paymentPayload.payload as X207Payload;
    const flight = this.inFlight.get(payload);
    if (!flight) return undefined;
    const response = context.settleResponse;
    try {
      if (context.error || !response) return undefined;
      if (response.success) {
        await this.store.commit(flight.key, flight.next);
        return undefined;
      }
      // Rejected by the server: the voucher does not become an obligation, the budget is returned
      this.refund(flight.epoch, flight.amount);
      const resync = readResync(response);
      if (!resync) return undefined;
      await this.store.commit(
        { payer: flight.key.payer, payee: flight.key.payee, epoch: resync.epoch },
        { seq: resync.lastSeq, cumulativeAmount: resync.lastCumulativeAmount },
      );
      if (this.retried.has(payload)) return undefined;
      this.retryPending.add(JSON.stringify([flight.key.payer, flight.key.payee]));
      return { recovered: true };
    } finally {
      this.settleFlight(payload);
    }
  }
}
export * from "./select.js";
export * from "./headroom-rpc.js";
export * from "./buyer-meter.js";
export * from "./daily-rent.js";
