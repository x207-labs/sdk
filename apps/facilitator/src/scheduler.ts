// Penjadwal registrasi (SD-028): relay `register_cumulative` per pasangan saat ambang terlewati atau
// menjelang `cutoff_at`; gagal disimpan di D3 dan diulang dengan backoff sampai `cutoff_at`
// (Spec Binding x402 6.3 dan 13; ADR-17, ADR-23, K-31).
import { contractErrorCode, type AccountId, type ContractAbi, type Ed25519Signature, type UnsignedVoucher } from "@x207/core";
import { DEFAULT_FLUSH_LEAD_SECONDS } from "@x207/scheme";
import type { PendingRow, PendingStore } from "./pending-store.js";

/** `registerThreshold` default: 1 credit (Spec Binding x402 6.3). */
export const DEFAULT_REGISTER_THRESHOLD = 1_000_000n;
/** Jeda backoff: 5, 10, 20, 40 detik, maksimum 60 detik (ADR-23). */
export const BACKOFF_BASE_SECONDS = 5;
export const BACKOFF_MAX_SECONDS = 60;

/**
 * `cumulative` (default, ADR-17): satu `register_cumulative` per pasangan saat ambang terlewati. `per_request` (mode demo, SD-029):
 * setiap `/settle` langsung mendaftarkan vouchernya dengan `register_voucher`.
 */
export type RegisterMode = "cumulative" | "per_request";

/** Hasil `registerNow` (SD-029, SD-030): `retrying` berarti gagal sementara dan akan diulang; `failed` berarti baris dibuang. */
export type RegisterOutcome =
  | { status: "registered" }
  | { status: "retrying"; code?: string; error: string }
  | { status: "failed"; code: string; error: string }
  | { status: "none" };

/** Sisi kontrak yang dibutuhkan penjadwal; `register` melempar bila transaksi gagal. */
export interface RegistrationChain {
  /** `bundleId` mengirim lewat `register_in_bundle` (leg bundle F5, SD-048) alih-alih `register_cumulative`. */
  register(voucher: UnsignedVoucher, signature: Ed25519Signature, mode: RegisterMode, bundleId?: number): Promise<void>;
  lastSeq(payer: AccountId, payee: AccountId, epoch: number): Promise<number>;
  /** View `get_epoch(epoch)`; `null` bila epoch tidak dikenal. */
  getEpoch(epoch: number): Promise<ContractAbi.EpochView | null>;
}

export type SchedulerLogEntry = {
  event: string;
  payer: AccountId;
  payee: AccountId;
  epoch: number;
  seq: number;
  /** Kode spec (mis. `insufficient_credit`), bukan kode kontrak. */
  code?: string;
  error?: string;
  attempts?: number;
  nextAttemptAt?: number;
  /** `cumulative_amount − registered_cumulative`, risiko penjual saat baris gagal (K-31). */
  risk?: string;
};

export type SchedulerOptions = {
  circleContract: AccountId;
  store: PendingStore;
  chain: RegistrationChain;
  /** Unix ms. */
  now?: () => number;
  log?: (entry: SchedulerLogEntry) => void;
  registerThreshold?: bigint;
  flushLeadSeconds?: number;
  mode?: RegisterMode;
  /** Baris yang boleh didaftarkan bersamaan (SD-031): jumlah jalur gas key relayer; 1 (bawaan) untuk kunci akses biasa. */
  concurrency?: number;
};

export type TickResult = {
  registered: number;
  retrying: number;
  dropped: number;
  failedAtCutoff: number;
};

/** Pemetaan kode kontrak ke kode spec; `drop` membuang baris, `retry` mengulang dengan backoff. */
const ERROR_MAP: Record<string, { code: string; action: "drop" | "retry" }> = {
  ERR_WRONG_CIRCLE: { code: "circle_mismatch", action: "drop" },
  ERR_BAD_UNIT: { code: "invalid_payload", action: "drop" },
  ERR_RESOURCE_NOT_ASCII: { code: "invalid_payload", action: "drop" },
  ERR_SELF_PAYMENT: { code: "self_payment", action: "drop" },
  ERR_EPOCH_MISMATCH: { code: "epoch_mismatch", action: "drop" },
  ERR_PAST_CUTOFF: { code: "epoch_closing", action: "drop" },
  ERR_PAYER_NOT_ACTIVE: { code: "member_not_active", action: "drop" },
  ERR_PAYEE_NOT_ACTIVE: { code: "payee_not_active", action: "drop" },
  ERR_EXITING: { code: "member_exiting", action: "drop" },
  ERR_CUMULATIVE_DECREASED: { code: "cumulative_decreased", action: "drop" },
  ERR_BAD_SIGNATURE: { code: "invalid_signature", action: "drop" },
  ERR_INSUFFICIENT_CREDIT: { code: "insufficient_credit", action: "retry" },
  ERR_SEQ_NOT_INCREASING: { code: "seq_not_increasing", action: "retry" },
  ERR_BUNDLE_LEG_EXCEEDED: { code: "bundle_leg_exceeded", action: "drop" },
  ERR_BUNDLE_LEG: { code: "not_a_bundle_leg", action: "drop" },
  ERR_UNKNOWN_BUNDLE: { code: "bundle_unknown", action: "drop" },
};

/** Jeda sebelum percobaan berikutnya setelah `attempts` kegagalan (1 = 5 detik). */
export function backoffSeconds(attempts: number): number {
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_SECONDS);
}

export class RegistrationScheduler {
  readonly #opts: SchedulerOptions;
  readonly #now: () => number;
  readonly #threshold: bigint;
  readonly #flushLeadMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  /** Registrasi yang sedang berjalan per pasangan, supaya `tick` dan `registerNow` tidak mengirim dua kali. */
  readonly #inflight = new Map<string, Promise<RegisterOutcome | undefined>>();

  constructor(options: SchedulerOptions) {
    this.#opts = options;
    this.#now = options.now ?? Date.now;
    this.#threshold = options.registerThreshold ?? DEFAULT_REGISTER_THRESHOLD;
    this.#flushLeadMs = (options.flushLeadSeconds ?? DEFAULT_FLUSH_LEAD_SECONDS) * 1000;
  }

  /** Jalankan `tick` berkala; kesalahan tak terduga dicatat dan tidak menghentikan jadwal. */
  start(intervalMs = 1000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        console.error("x207 scheduler tick gagal:", error instanceof Error ? error.message : error);
      });
    }, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Satu putaran: proses semua baris yang belum lunas dan sudah waktunya. Putaran yang tumpang tindih dilewati. */
  async tick(): Promise<TickResult> {
    const result: TickResult = { registered: 0, retrying: 0, dropped: 0, failedAtCutoff: 0 };
    if (this.#running) return result;
    this.#running = true;
    try {
      const cutoffs = new Map<number, number | undefined>();
      const rows = this.#opts.store.listOpen(this.#opts.circleContract);
      const workers = Math.max(1, Math.min(this.#opts.concurrency ?? 1, rows.length));
      let next = 0;
      await Promise.all(
        Array.from({ length: workers }, async () => {
          while (next < rows.length) await this.#process(rows[next++]!, cutoffs, result);
        }),
      );
    } finally {
      this.#running = false;
    }
    return result;
  }

  async #cutoffMs(epoch: number, cache: Map<number, number | undefined>, row: PendingRow): Promise<number | undefined> {
    if (cache.has(epoch)) return cache.get(epoch);
    let cutoff: number | undefined;
    try {
      const view = await this.#opts.chain.getEpoch(epoch);
      if (view) cutoff = Number(BigInt(view.cutoff_at) / 1_000_000n);
    } catch (error) {
      this.#log("cutoff_unknown", row, { error: errorText(error) });
    }
    cache.set(epoch, cutoff);
    return cutoff;
  }

  /**
   * Mode demo `per_request` (SD-029): daftarkan baris pasangan ini sekarang, tanpa menunggu ambang. Dipanggil `/settle` dan
   * menunggu sampai transaksi final; pemanggil yang menerapkan timeout (SD-030) tidak menghentikan registrasi ini.
   */
  async registerNow(key: { payer: AccountId; payee: AccountId; epoch: number }): Promise<RegisterOutcome> {
    const row = this.#opts.store.get({ circleContract: this.#opts.circleContract, ...key });
    if (!row || row.registeredSeq >= row.seq) return { status: row ? "registered" : "none" };
    const result: TickResult = { registered: 0, retrying: 0, dropped: 0, failedAtCutoff: 0 };
    const outcome = await this.#process(row, new Map(), result, true);
    return outcome ?? { status: "retrying", error: "belum waktunya" };
  }

  #process(row: PendingRow, cutoffs: Map<number, number | undefined>, result: TickResult, force = false): Promise<RegisterOutcome | undefined> {
    const id = `${row.payer}\u0000${row.payee}\u0000${row.epoch}`;
    const running = this.#inflight.get(id);
    if (running) return force ? running : Promise.resolve(undefined);
    const attempt = this.#processRow(row, cutoffs, result, force).finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, attempt);
    return attempt;
  }

  async #processRow(row: PendingRow, cutoffs: Map<number, number | undefined>, result: TickResult, force: boolean): Promise<RegisterOutcome | undefined> {
    const now = this.#now();
    if (!force && row.nextAttemptAt !== null && now < row.nextAttemptAt) return undefined;

    const unregistered = BigInt(row.cumulativeAmount) - BigInt(row.registeredCumulative);
    const cutoff = await this.#cutoffMs(row.epoch, cutoffs, row);
    const key = { circleContract: row.circleContract, payer: row.payer, payee: row.payee, epoch: row.epoch };

    if (cutoff !== undefined && now >= cutoff) {
      this.#opts.store.markFailed(key, row.lastError ?? "cutoff");
      this.#log("registration_failed_until_cutoff", row, { risk: unregistered.toString(), error: row.lastError ?? undefined });
      result.failedAtCutoff += 1;
      return { status: "failed", code: "epoch_closing", error: row.lastError ?? "cutoff" };
    }

    const mode = this.#opts.mode ?? "cumulative";
    const due =
      force || mode === "per_request" || row.attempts >= 1 || unregistered >= this.#threshold || (cutoff !== undefined && now >= cutoff - this.#flushLeadMs);
    if (!due) return undefined;

    try {
      try {
        if (row.bundleId === null) await this.#opts.chain.register(row.voucher, row.signature, mode);
        else await this.#opts.chain.register(row.voucher, row.signature, mode, row.bundleId);
      } catch (error) {
        // `register_voucher` wajib `seq = last_seq + 1`; bila ada seq yang dilewati (voucher sebelumnya masih antre), pakai kumulatif.
        if (mode !== "per_request" || row.bundleId !== null || contractErrorCode(error) !== "ERR_SEQ_GAP") throw error;
        this.#log("per_request_fallback", row, { code: "seq_gap" });
        await this.#opts.chain.register(row.voucher, row.signature, "cumulative");
      }
    } catch (error) {
      return this.#failed(row, key, error, result);
    }
    this.#opts.store.recordRegistered(key, row.seq, row.cumulativeAmount);
    this.#log("registered", row, {});
    result.registered += 1;
    return { status: "registered" };
  }

  async #failed(
    row: PendingRow,
    key: Parameters<PendingStore["recordFailure"]>[0],
    error: unknown,
    result: TickResult,
  ): Promise<RegisterOutcome> {
    const text = errorText(error);
    const mapped = ERROR_MAP[contractErrorCode(error) ?? ""];

    if (contractErrorCode(error) === "ERR_SEQ_NOT_INCREASING") {
      // Idempoten: kontrak sudah memegang seq ini atau yang lebih tinggi (ADR-23).
      let last = -1;
      try {
        last = await this.#opts.chain.lastSeq(row.payer, row.payee, row.epoch);
      } catch {
        // gagal membaca last_seq diperlakukan sebagai belum terbukti; retry di bawah
      }
      if (last >= row.seq) {
        this.#opts.store.recordRegistered(key, row.seq, row.cumulativeAmount);
        this.#log("registered", row, { code: "seq_not_increasing" });
        result.registered += 1;
        return { status: "registered" };
      }
    }

    if (mapped?.action === "drop") {
      this.#opts.store.markFailed(key, `${mapped.code}: ${text}`);
      this.#log("registration_dropped", row, { code: mapped.code, error: text });
      result.dropped += 1;
      return { status: "failed", code: mapped.code, error: text };
    }

    const attempts = row.attempts + 1;
    const nextAttemptAt = this.#now() + backoffSeconds(attempts) * 1000;
    this.#opts.store.recordFailure(key, text, nextAttemptAt);
    this.#log("registration_retry", row, { code: mapped?.code, error: text, attempts, nextAttemptAt });
    result.retrying += 1;
    return { status: "retrying", ...(mapped ? { code: mapped.code } : {}), error: text };
  }

  #log(event: string, row: PendingRow, extra: Partial<SchedulerLogEntry>): void {
    const entry: SchedulerLogEntry = { event, payer: row.payer, payee: row.payee, epoch: row.epoch, seq: row.seq };
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) (entry as Record<string, unknown>)[k] = v;
    (this.#opts.log ?? ((e) => console.log(JSON.stringify(e))))(entry);
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
