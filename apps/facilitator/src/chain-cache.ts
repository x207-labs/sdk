// Short-lived cache in front of the chain reads of `verify` (UM-032 follow-up). A paid call made 10 JSON-RPC requests to the facilitator
// (`/verify` and the second `verify` inside `/settle`); the free public endpoints stall at that rate. What may be stale, and for how long:
//
//  - `get_epoch` (30 s): the epoch number and phase change only after `cutoff_at`, and `verify` already rejects by clock from
//    `cutoff_at - flushLead`, so a stale epoch view cannot let a voucher in for a closed epoch. After `close_epoch` a voucher of the new
//    epoch is refused `epoch_mismatch` for at most this long; the client then reads `/supported`.
//  - `member` (15 s): status, voucher key, exit request. A member that was suspended or asked to leave in the last 15 s can still get
//    vouchers accepted; registering them on chain fails (`ERR_PAYER_NOT_ACTIVE`, `ERR_EXITING`) and the row is dropped, so the loss is
//    the unregistered vouchers of that window, the seller delay risk of ADR-23.
//  - `headroom` and `obligation` (10 s): they move together when a registration lands or a bundle reserves headroom. Registrations made by
//    this facilitator call `invalidatePayer`, so its own registrations are never missed. A change made by someone else (a `commit_bundle`
//    that reserves headroom of the payer, a registration by another relayer) is seen after at most 10 s; until then the headroom check
//    can pass a voucher that the contract will refuse (`ERR_INSUFFICIENT_CREDIT`), again a dropped row and not a debt.
//  - `get_bundle` (30 s): the status and the legs of a committed bundle do not change inside an epoch.
//
// The contract stays the final gate: nothing here lets a debt exist that the limit does not cover. A TTL of 0 turns an entry off.
import type { AccountId, ContractAbi } from "@x207/core";
import type { VerifyChain } from "@x207/scheme";

export type ChainCacheOptions = {
  epochMs?: number;
  memberMs?: number;
  headroomMs?: number;
  obligationMs?: number;
  bundleMs?: number;
  /** Unix ms. */
  now?: () => number;
};

export const CHAIN_CACHE_DEFAULTS = { epochMs: 30_000, memberMs: 15_000, headroomMs: 10_000, obligationMs: 10_000, bundleMs: 30_000 } as const;

type Entry<T> = { at: number; value: Promise<T> };

class Ttl<T> {
  readonly #entries = new Map<string, Entry<T>>();
  constructor(private readonly ttlMs: number, private readonly now: () => number) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return load();
    const hit = this.#entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = load();
    this.#entries.set(key, { at: this.now(), value });
    // a failed read is not kept: the next call asks the chain again
    value.catch(() => {
      if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
    });
    return value;
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of this.#entries.keys()) if (predicate(key)) this.#entries.delete(key);
  }
}

/** Counters for the tests and for the operator: how many reads were answered from memory. */
export type ChainCacheStats = { hits: number; misses: number };

export class CachedVerifyChain implements VerifyChain {
  readonly stats: ChainCacheStats = { hits: 0, misses: 0 };
  readonly #epoch: Ttl<ContractAbi.EpochView | null>;
  readonly #member: Ttl<ContractAbi.MemberView | null>;
  readonly #headroom: Ttl<string>;
  readonly #obligation: Ttl<Pick<ContractAbi.ObligationView, "cumulative" | "last_seq"> | null>;
  readonly #bundle: Ttl<ContractAbi.BundleView | null>;

  constructor(private readonly inner: VerifyChain & { bundle(bundleId: number): Promise<ContractAbi.BundleView | null> }, options: ChainCacheOptions = {}) {
    const now = options.now ?? Date.now;
    const ttl = { ...CHAIN_CACHE_DEFAULTS, ...options };
    this.#epoch = new Ttl(ttl.epochMs, now);
    this.#member = new Ttl(ttl.memberMs, now);
    this.#headroom = new Ttl(ttl.headroomMs, now);
    this.#obligation = new Ttl(ttl.obligationMs, now);
    this.#bundle = new Ttl(ttl.bundleMs, now);
  }

  #count<T>(cache: Ttl<T>, key: string, load: () => Promise<T>): Promise<T> {
    let loaded = false;
    const value = cache.get(key, () => {
      loaded = true;
      return load();
    });
    if (loaded) this.stats.misses += 1;
    else this.stats.hits += 1;
    return value;
  }

  getEpoch() {
    return this.#count(this.#epoch, "epoch", () => this.inner.getEpoch());
  }

  member(account: AccountId) {
    return this.#count(this.#member, account, () => this.inner.member(account));
  }

  headroom(account: AccountId) {
    return this.#count(this.#headroom, account, () => this.inner.headroom(account));
  }

  obligation(epoch: number, debtor: AccountId, creditor: AccountId) {
    return this.#count(this.#obligation, `${epoch}\u0000${debtor}\u0000${creditor}`, () => this.inner.obligation(epoch, debtor, creditor));
  }

  bundle(bundleId: number) {
    return this.#count(this.#bundle, String(bundleId), () => this.inner.bundle(bundleId));
  }

  pendingByPayer(payer: AccountId, epoch: number) {
    return this.inner.pendingByPayer(payer, epoch);
  }

  /** Forget what is known about the debt of `payer`: call it after this facilitator registered a voucher of the payer. */
  invalidatePayer(payer: AccountId): void {
    this.#headroom.deleteWhere((key) => key === payer);
    this.#obligation.deleteWhere((key) => key.split("\u0000")[1] === payer);
  }
}
