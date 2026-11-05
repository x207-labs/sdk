// Registration scheduler (SD-028): relays `register_cumulative` per pair when the threshold is crossed or
// near `cutoff_at`; failures are kept in D3 and retried with backoff until `cutoff_at`
// (Spec Binding x402 6.3 and 13; ADR-17, ADR-23, K-31).
import { contractErrorCode, type AccountId, type ContractAbi, type Signature, type UnsignedVoucher } from "@x207/core";
import { DEFAULT_FLUSH_LEAD_SECONDS } from "@x207/scheme";
import type { PendingRow, PendingStore } from "./pending-store.js";

/** `registerThreshold` default: 1 credit (Spec Binding x402 6.3). */
export const DEFAULT_REGISTER_THRESHOLD = 1_000_000n;
/** Backoff delay: 5, 10, 20, 40 seconds, maximum 60 seconds (ADR-23). */
export const BACKOFF_BASE_SECONDS = 5;
export const BACKOFF_MAX_SECONDS = 60;

/**
 * `cumulative` (default, ADR-17): one `register_cumulative` per pair when the threshold is crossed. `per_request` (demo mode, SD-029):
 * each `/settle` registers its voucher immediately with `register_voucher`.
 */
export type RegisterMode = "cumulative" | "per_request";

/** Result of `registerNow` (SD-029, SD-030): `retrying` means a temporary failure that will be retried; `failed` means the row is dropped. */
export type RegisterOutcome =
  | { status: "registered" }
  | { status: "retrying"; code?: string; error: string }
  | { status: "failed"; code: string; error: string }
  | { status: "none" };

/** Contract side the scheduler needs; `register` throws if the transaction fails. */
export interface RegistrationChain {
  /** `bundleId` sends via `register_in_bundle` (F5 bundle leg, SD-048) instead of `register_cumulative`. */
  register(voucher: UnsignedVoucher, signature: Signature, mode: RegisterMode, bundleId?: number): Promise<void>;
  lastSeq(payer: AccountId, payee: AccountId, epoch: number): Promise<number>;
  /** View `get_epoch(epoch)`; `null` if the epoch is unknown. */
  getEpoch(epoch: number): Promise<ContractAbi.EpochView | null>;
}

export type SchedulerLogEntry = {
  event: string;
  payer: AccountId;
  payee: AccountId;
  epoch: number;
  seq: number;
  /** Spec code (e.g. `insufficient_credit`), not a contract code. */
  code?: string;
  error?: string;
  attempts?: number;
  nextAttemptAt?: number;
  /** `cumulative_amount − registered_cumulative`, the seller's risk when a row fails (K-31). */
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
  /** Rows that may be registered concurrently (SD-031): the number of relayer gas key lanes; 1 (default) for a regular access key. */
  concurrency?: number;
  /** Called after a voucher of `payer` was registered on chain (also when the contract already held it), e.g. to drop cached reads. */
  onRegistered?: (row: { payer: AccountId; payee: AccountId; epoch: number }) => void;
};

export type TickResult = {
  registered: number;
  retrying: number;
  dropped: number;
  failedAtCutoff: number;
};

/** Mapping of contract codes to spec codes; `drop` drops the row, `retry` retries with backoff. */
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

/** Delay before the next attempt after `attempts` failures (1 = 5 seconds). */
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
  /** Registrations in progress per pair, so `tick` and `registerNow` do not send twice. */
  readonly #inflight = new Map<string, Promise<RegisterOutcome | undefined>>();

  constructor(options: SchedulerOptions) {
    this.#opts = options;
    this.#now = options.now ?? Date.now;
    this.#threshold = options.registerThreshold ?? DEFAULT_REGISTER_THRESHOLD;
    this.#flushLeadMs = (options.flushLeadSeconds ?? DEFAULT_FLUSH_LEAD_SECONDS) * 1000;
  }

  /** Run `tick` periodically; unexpected errors are logged and do not stop the schedule. */
  start(intervalMs = 1000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        console.error("x207 scheduler tick failed:", error instanceof Error ? error.message : error);
      });
    }, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One round: process all rows that are not yet settled and are due. Overlapping rounds are skipped. */
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
   * Demo mode `per_request` (SD-029): register this pair's row now, without waiting for the threshold. Called by `/settle` and
   * waits until the transaction is final; a caller that applies a timeout (SD-030) does not stop this registration.
   */
  async registerNow(key: { payer: AccountId; payee: AccountId; epoch: number }): Promise<RegisterOutcome> {
    const row = this.#opts.store.get({ circleContract: this.#opts.circleContract, ...key });
    if (!row || row.registeredSeq >= row.seq) return { status: row ? "registered" : "none" };
    const result: TickResult = { registered: 0, retrying: 0, dropped: 0, failedAtCutoff: 0 };
    const outcome = await this.#process(row, new Map(), result, true);
    return outcome ?? { status: "retrying", error: "not time yet" };
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
        // `register_voucher` requires `seq = last_seq + 1`; if a seq was skipped (an earlier voucher is still queued), use the cumulative.
        if (mode !== "per_request" || row.bundleId !== null || contractErrorCode(error) !== "ERR_SEQ_GAP") throw error;
        this.#log("per_request_fallback", row, { code: "seq_gap" });
        await this.#opts.chain.register(row.voucher, row.signature, "cumulative");
      }
    } catch (error) {
      return this.#failed(row, key, error, result);
    }
    this.#opts.store.recordRegistered(key, row.seq, row.cumulativeAmount);
    this.#log("registered", row, {});
    this.#opts.onRegistered?.({ payer: row.payer, payee: row.payee, epoch: row.epoch });
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
      // Idempotent: the contract already holds this seq or a higher one (ADR-23).
      let last = -1;
      try {
        last = await this.#opts.chain.lastSeq(row.payer, row.payee, row.epoch);
      } catch {
        // failing to read last_seq is treated as not yet proven; retry below
      }
      if (last >= row.seq) {
        this.#opts.store.recordRegistered(key, row.seq, row.cumulativeAmount);
        this.#log("registered", row, { code: "seq_not_increasing" });
        this.#opts.onRegistered?.({ payer: row.payer, payee: row.payee, epoch: row.epoch });
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
