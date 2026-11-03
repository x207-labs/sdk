// Pemilihan entri di klien (SD-019, Spec Binding x402 5.2): voucher x207 bila headroom cukup,
// selain itu entri lain (`exact` near:mainnet), tanpa kode tambahan di agent.
import { x402Client } from "@x402/core/client";
import type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
} from "@x402/core/types";
import type { AccountId, VoucherSecretKey } from "@x207/core";
import { X207_SCHEME } from "../shared/circle.js";
import { X207SchemeClient, type SpendLimit } from "./index.js";
import type { VoucherStateStore } from "./store.js";

type SelectPaymentRequirements = (
  x402Version: number,
  accepts: PaymentRequirements[],
) => PaymentRequirements;

export const X207_NETWORK_PREFIX = "x207:";
/** Cache perkiraan headroom maksimal 60 detik (K-34). */
export const HEADROOM_CACHE_MS = 60_000;

export const isX207Requirements = (requirements: PaymentRequirements): boolean =>
  requirements.scheme === X207_SCHEME && requirements.network.startsWith(X207_NETWORK_PREFIX);

const circleOf = (requirements: PaymentRequirements): string | undefined => {
  const circle = (requirements.extra as { circleContract?: unknown } | undefined)?.circleContract;
  return typeof circle === "string" ? circle : undefined;
};

/**
 * Membaca view `headroom(account_id)` kontrak lingkaran. `"0"` untuk anggota yang tidak `active`;
 * `null` bila bukan anggota.
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
 * Perkiraan headroom payer per kontrak lingkaran: view `headroom` dengan cache, dikurangi `amount`
 * yang sudah dibayar lewat x207 sejak cache dibaca. Tidak diketahui (view gagal) berarti `undefined`.
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

  /** Baca ulang view bila cache kosong atau lebih tua dari `cacheMs`. Kegagalan view tidak melempar. */
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

  /** Kurangi headroom setelah voucher senilai `amount` diterima. */
  consume(circleContract: AccountId, amount: string): void {
    const entry = this.entries.get(circleContract);
    if (!entry) return;
    entry.value = entry.value > BigInt(amount) ? entry.value - BigInt(amount) : 0n;
  }

  /** Server menolak `insufficient_credit`: anggap habis sampai cache dibaca ulang. */
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

/** Entri x207 yang membayar leg bundle: tidak memakai headroom bebas, jadi tidak ikut diperiksa dan tidak mengurangi perkiraan. */
const isBundleLeg = (requirements: PaymentRequirements, bundleFor: BundleLookup | undefined): boolean => {
  const epoch = (requirements.extra as { epoch?: unknown } | undefined)?.epoch;
  return bundleFor !== undefined && typeof epoch === "number" && bundleFor(requirements.payTo, epoch) !== undefined;
};

/** Pilih x207 bila headroom cukup (atau tidak diketahui) atau bila pembayaran adalah leg bundle, selain itu entri non-x207 pertama. */
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

/** Penolakan yang bisa dipulihkan dengan jatuh ke entri `exact`: headroom habis (SD-019) dan payer keluar (TC-SD-033-07). */
const RECOVERABLE_REASONS = new Set(["insufficient_credit", "member_exiting"]);

export type X207PaymentClientOptions = {
  payer: AccountId;
  /** Kunci voucher ed25519 payer (ADR-06), bukan access key NEAR. */
  secretKey: VoucherSecretKey;
  headroom: HeadroomSource;
  store?: VoucherStateStore;
  /** Leg bundle F5 (SD-048); lihat `X207ClientOptions.bundleFor`. */
  bundleFor?: BundleLookup;
  /** Batas belanja lokal pemilik (SD-020); lihat `X207ClientOptions.spendLimit`. */
  spendLimit?: SpendLimit;
  headroomCacheMs?: number;
  now?: () => number;
};

/**
 * `x402Client` yang sudah mendaftarkan `x207:*` dan memilih antara voucher dan entri lain.
 * Agent tinggal mendaftarkan `exact` NEAR sendiri (`register("near:*", …)`) lalu memakai
 * `wrapFetchWithPayment`; jatuh ke `exact` setelah `insufficient_credit` terjadi otomatis.
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
      secretKey: options.secretKey,
      ...(options.store ? { store: options.store } : {}),
      ...(options.bundleFor ? { bundleFor: options.bundleFor } : {}),
      ...(options.spendLimit ? { spendLimit: options.spendLimit } : {}),
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
