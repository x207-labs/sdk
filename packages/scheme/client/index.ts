// Peran client binding x207 (SD-015, SD-018): voucher kumulatif per (payer, payee, epoch).
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
  signVoucher,
  validatePaymentRequirements,
  type AccountId,
  type UnsignedVoucher,
  type VoucherSecretKey,
  type X207Payload,
} from "@x207/core";
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

/** Batas belanja lokal dari pemilik agent, dalam satuan terkecil credit (string desimal). Dicek sebelum voucher ditandatangani. */
export type SpendLimit = {
  /** Batas satu panggilan berbayar. */
  maxPerCall?: string;
  /** Batas total semua pembayaran payer ini dalam satu epoch (lintas payee). */
  maxPerEpoch?: string;
};

/** Pembayaran ditolak klien karena batas belanja pemilik; tidak ada voucher yang ditandatangani. */
export class SpendLimitError extends Error {
  readonly limit: "per_call" | "per_epoch";
  readonly amount: string;
  readonly max: string;
  readonly spent: string;

  constructor(limit: "per_call" | "per_epoch", amount: bigint, max: bigint, spent: bigint) {
    super(
      limit === "per_call"
        ? `batas belanja per panggilan terlampaui: ${amount} > ${max}`
        : `batas belanja per epoch terlampaui: ${spent} terpakai + ${amount} > ${max}`,
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
  /** Kunci voucher ed25519 payer (ADR-06), bukan access key NEAR. */
  secretKey: VoucherSecretKey;
  store?: VoucherStateStore;
  /**
   * Batas menunggu respons sebelum voucher yang belum terkonfirmasi dilepas tanpa commit, supaya
   * antrian tidak macet bila koneksi putus. Default 60 detik = `maxTimeoutSeconds` (ADR-25).
   */
  confirmTimeoutMs?: number;
  /**
   * Leg bundle F5 (SD-048): `bundle_id` untuk pembayaran ke `payee` di `epoch`, atau `undefined` bila bukan leg. Voucher leg sama
   * byte-nya dengan voucher biasa; `bundleId` di payload membuat facilitator memeriksa batas leg dan mendaftarkan lewat
   * `register_in_bundle` (headroom cadangan).
   */
  bundleFor?: (payee: AccountId, epoch: number) => number | undefined;
  /** Batas belanja lokal (SD-020): voucher yang melampauinya tidak ditandatangani walau headroom kontrak cukup. */
  spendLimit?: SpendLimit;
  /** Hitungan sendiri pembeli (SD-068): 402 yang mengumumkan `extra.meter` harus cocok dengan yang diminta pembeli, kalau tidak tidak ada voucher yang ditandatangani. */
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

/** `extensions.x207` pada `PAYMENT-RESPONSE` penolakan (Spec Binding 5.2, K-29). */
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
  private readonly secretKey: VoucherSecretKey;
  private readonly confirmTimeoutMs: number;
  private readonly bundleFor: ((payee: AccountId, epoch: number) => number | undefined) | undefined;
  private readonly spendLimit: SpendLimit | undefined;
  private readonly meter: BuyerMeter | undefined;
  /** Belanja per epoch yang sudah dicadangkan: voucher yang ditandatangani dan belum ditolak server. */
  private readonly spent = new Map<number, bigint>();
  /** `createPaymentPayload` x402 tidak menerima `resource`; hook sebelum pembuatan menitipkannya. */
  private readonly resources = new WeakMap<PaymentRequirements, string>();
  private readonly inFlight = new WeakMap<X207Payload, InFlight>();
  /** Ekor antrian per (payer, payee): paling banyak satu voucher belum terkonfirmasi. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly retried = new WeakSet<X207Payload>();
  private readonly retryPending = new Set<string>();

  constructor(options: X207ClientOptions) {
    this.payer = options.payer;
    this.secretKey = options.secretKey;
    this.store = options.store ?? new MemoryVoucherStateStore();
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 60_000;
    this.bundleFor = options.bundleFor;
    this.spendLimit = options.spendLimit;
    this.meter = options.meter;
  }

  /** Belanja epoch `epoch` yang terhitung terhadap `maxPerEpoch`. */
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
   * Tanpa ini `x402Client` menolak entri `asset: "USD"` lewat spendControls bawaannya, karena
   * "USD" bukan aset bawaan network mana pun.
   */
  findDefaultAsset(asset: string): DefaultAsset | undefined {
    return asset === USD_CREDIT.asset ? USD_CREDIT : undefined;
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (x402Version !== 2) throw new Error(`x402Version ${x402Version} tidak didukung, harus 2`);
    const checked = validatePaymentRequirements(requirements);
    if (!checked.ok) throw new Error(`requirements x207 tidak sah: ${checked.field} ${checked.message}`);
    const { payTo, amount, extra } = checked.value;
    // Endpoint grant (SD-053): resource voucher = `x207:grant:<grantId>`, payee = payTo pemberi (bukan akun broker yang melayani URL-nya)
    const resource = extra.grantId === undefined ? this.resources.get(requirements) : grantResource(extra.grantId);
    if (resource === undefined) {
      throw new Error("resource.url tidak diketahui: buat payload lewat x402Client agar hook terpasang");
    }

    this.meter?.authorize((requirements.extra as { meter?: MeterAnnouncement } | undefined)?.meter, amount);
    // Batas belanja dicek dan dicadangkan secara sinkron, sebelum antrian pasangan dan sebelum signVoucher.
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
      const { signature, ...voucher } = signVoucher(unsigned, this.secretKey);
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

  /** Melepas antrian satu voucher; mengembalikan datanya, atau `undefined` bila sudah dilepas. */
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
      // Ditolak server: voucher tidak jadi kewajiban, anggaran dikembalikan
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
