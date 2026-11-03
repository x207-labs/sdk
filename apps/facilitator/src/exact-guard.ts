// Limits for the `exact` NEP-366 route (security review 3). The relayer pays the gas of every delegate action it submits, also when the inner `ft_transfer` fails
// (the payer moved its USDT away, or used the nonce in another transaction), and `/settle` is open to everybody. Three limits, all in the memory of one process:
//   1. `maxSponsoredGas`: the most gas a delegated `ft_transfer` may ask. Default = the gas the standard client asks (30 Tgas), not the 100 Tgas of the library.
//   2. a counter of failed settlements per payer (only a payer whose signature was verified, so nobody can pause another account): after `failureLimit` failures inside
//      `failureWindowMs` the payer is refused for `pauseMs`.
//   3. a rate limit per client on `/verify` and `/settle` (`RateLimiter`, used by `createApp`).
// What they do not do: a funded attacker with many accounts spends `failureLimit` failures per account and per window; the relayer balance is still the last limit. Watch it.
import { decodeSignedDelegateB64 } from "@x402/near";

/** The gas that the standard `@x402/near` client attaches to `ft_transfer` (`DEFAULT_FT_TRANSFER_GAS`). */
export const EXACT_DEFAULT_MAX_SPONSORED_GAS = 30_000_000_000_000n;
export const EXACT_GUARD_DEFAULTS = { failureLimit: 3, failureWindowMs: 10 * 60_000, pauseMs: 10 * 60_000 } as const;

export type ExactGuardOptions = {
  failureLimit?: number;
  failureWindowMs?: number;
  pauseMs?: number;
  now?: () => number;
};

export class ExactSenderGuard {
  readonly #failures = new Map<string, number[]>();
  readonly #pausedUntil = new Map<string, number>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #pauseMs: number;
  readonly #now: () => number;

  constructor(options: ExactGuardOptions = {}) {
    this.#limit = options.failureLimit ?? EXACT_GUARD_DEFAULTS.failureLimit;
    this.#windowMs = options.failureWindowMs ?? EXACT_GUARD_DEFAULTS.failureWindowMs;
    this.#pauseMs = options.pauseMs ?? EXACT_GUARD_DEFAULTS.pauseMs;
    this.#now = options.now ?? Date.now;
    if (![this.#limit, this.#windowMs, this.#pauseMs].every((n) => Number.isInteger(n) && n >= 1)) throw new Error("exact guard: limits must be positive integers");
  }

  /** Milliseconds until `payer` may settle again, or `0`. */
  pausedFor(payer: string): number {
    const until = this.#pausedUntil.get(payer);
    if (until === undefined) return 0;
    const left = until - this.#now();
    if (left <= 0) {
      this.#pausedUntil.delete(payer);
      return 0;
    }
    return left;
  }

  /** A settlement of `payer` was submitted and failed (the relayer paid the gas). */
  recordFailure(payer: string): void {
    const now = this.#now();
    const recent = (this.#failures.get(payer) ?? []).filter((t) => now - t < this.#windowMs);
    recent.push(now);
    if (recent.length >= this.#limit) {
      this.#pausedUntil.set(payer, now + this.#pauseMs);
      this.#failures.delete(payer);
    } else {
      this.#failures.set(payer, recent);
    }
    if (this.#failures.size > 10_000) this.#failures.clear(); // a flood of accounts must not grow the memory without bound
    if (this.#pausedUntil.size > 10_000) this.#pausedUntil.clear();
  }

  recordSuccess(payer: string): void {
    this.#failures.delete(payer);
  }
}

/** The account that signed an `exact` payload, only when the signature is valid; `undefined` otherwise (so a forged payload names nobody). */
export function verifiedExactPayer(payload: unknown): string | undefined {
  try {
    const signed = (payload as { payload?: { signedDelegateAction?: unknown } })?.payload?.signedDelegateAction;
    if (typeof signed !== "string") return undefined;
    const decoded = decodeSignedDelegateB64(signed);
    return decoded.verifySignature() ? decoded.delegate.senderId : undefined;
  } catch {
    return undefined;
  }
}

export type RateLimitOptions = { windowMs?: number; max?: number; now?: () => number };
export const RATE_LIMIT_DEFAULTS = { windowMs: 60_000, max: 600 } as const;

/** Fixed window counter per key. `hit` returns `0` when the request may go on, or the milliseconds until the window ends. */
export class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #windowMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(options: RateLimitOptions = {}) {
    this.#windowMs = options.windowMs ?? RATE_LIMIT_DEFAULTS.windowMs;
    this.#max = options.max ?? RATE_LIMIT_DEFAULTS.max;
    this.#now = options.now ?? Date.now;
    if (![this.#windowMs, this.#max].every((n) => Number.isInteger(n) && n >= 1)) throw new Error("rate limit: windowMs and max must be positive integers");
  }

  hit(key: string): number {
    const now = this.#now();
    const entry = this.#windows.get(key);
    if (!entry || now - entry.start >= this.#windowMs) {
      if (this.#windows.size > 10_000) this.#windows.clear();
      this.#windows.set(key, { start: now, count: 1 });
      return 0;
    }
    entry.count += 1;
    return entry.count > this.#max ? entry.start + this.#windowMs - now : 0;
  }
}
