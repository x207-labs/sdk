// Daily access rental, renter side (SD-071, pipeline P2, ADR-47). Access is rented per day: the renter pays one day ahead and signs the next day's voucher only if the access
// IS STILL RUNNING, so each party's loss is at most one day: a renter abandoned by the giver (access revoked early) does not pay for the next day, and a giver who is not paid
// revokes the access themself (broker). The pattern is the same as `BuyerMeter` (SD-068): the count and checks are on the renter's side, and without passing the checks no voucher is signed.
// For billed access (cloud roles, orgs with a spend limit) the provider bills the real cost per day, capped by `daily_cap` from the grant scope; a bill above the cap is not signed.
//
// This class has no network and no time: the caller supplies `view` (the answer of the broker's `GET /grants/{id}/access`) and, if any, the result of a direct check against the provider.
import { CREDIT_UNIT, RentError, checkAccessBeforeNextDay, signVoucher, type AccessView, type AccountId, type RentErrorCode, type U128String, type UnsignedVoucher, type Voucher, type VoucherSecretKey } from "@x207/core";

const fail = (code: RentErrorCode, message: string): never => {
  throw new RentError(code, message);
};
export type { AccessView };

export type DailyRentOptions = {
  circle: AccountId;
  payer: AccountId;
  payee: AccountId;
  grantId: number;
  /** Price of one rental day in the smallest credit unit. */
  dailyPrice: U128String;
  /** Real-cost limit per day from the grant scope (`daily_cap`), smallest credit unit; empty for access without cost. */
  dailyCap?: U128String | undefined;
  secretKey: VoucherSecretKey;
  /** The renter's clock, unix ms. */
  now: () => number;
};

const isAmount = (v: string): boolean => /^(0|[1-9]\d*)$/.test(v);

export class DailyRent {
  readonly #o: DailyRentOptions;
  #days = 0;
  #stopped = false;

  constructor(options: DailyRentOptions) {
    if (!isAmount(options.dailyPrice) || BigInt(options.dailyPrice) === 0n) fail("rent_bad_cap", "dailyPrice must be a decimal integer > 0");
    if (options.dailyCap !== undefined && !isAmount(options.dailyCap)) fail("rent_bad_cap", "dailyCap must be a decimal integer");
    this.#o = options;
  }

  /** Days already paid (voucher signed). */
  get daysPaid(): number {
    return this.#days;
  }
  get stopped(): boolean {
    return this.#stopped;
  }
  /** The renter stops renting: no more vouchers. */
  stop(): void {
    this.#stopped = true;
  }

  /**
   * Check before signing the NEXT day's voucher. Passes only if the broker says the access is `active` and paid up to now, and, if given, the direct check
   * against the provider (`directCheck`, e.g. trying to log in) succeeds: access revoked early is not paid for again.
   */
  async checkBeforeNextDay(view: AccessView, directCheck?: () => Promise<boolean>): Promise<void> {
    if (this.#stopped) fail("rent_stopped", "the rent has already been stopped");
    await checkAccessBeforeNextDay({ grantId: this.#o.grantId, view, nowMs: this.#o.now(), ...(directCheck ? { directCheck } : {}) });
  }

  /** Voucher for one rental day on top of the pair's state at `epoch`; `day` (e.g. `2026-11-04`) prevents paying the same day twice. */
  signDay(args: { day: string; epoch: number; state: { seq: number; cumulativeAmount: U128String } }): Voucher {
    if (this.#stopped) fail("rent_stopped", "the rent has already been stopped");
    if (this.#lastDay === args.day) fail("rent_day_already_paid", `day ${args.day} is already paid`);
    const voucher: UnsignedVoucher = {
      circle: this.#o.circle, payer: this.#o.payer, payee: this.#o.payee, epoch: args.epoch, seq: args.state.seq + 1,
      cumulativeAmount: (BigInt(args.state.cumulativeAmount) + BigInt(this.#o.dailyPrice)).toString(), unit: CREDIT_UNIT, resource: `x207:grant:${this.#o.grantId}`,
    };
    const signed = signVoucher(voucher, this.#o.secretKey);
    this.#lastDay = args.day;
    this.#days += 1;
    return signed;
  }
  #lastDay: string | null = null;

  /**
   * Real-cost bill for one day: `billed` from the provider (through the broker). Above `daily_cap` is rejected and the rental is stopped; with no cap, billed access must not be billed at all.
   * Returns the amount that may be signed.
   */
  checkBill(billed: U128String): U128String {
    if (!isAmount(billed)) fail("rent_bad_state", `bill must be a decimal integer, got ${JSON.stringify(billed)}`);
    const cap = this.#o.dailyCap;
    if (BigInt(billed) === 0n) return billed;
    if (cap === undefined) return fail("rent_bill_over_cap", "this access has no daily limit, so a real charge must not be billed");
    if (BigInt(billed) > BigInt(cap)) {
      this.#stopped = true;
      return fail("rent_bill_over_cap", `bill ${billed} is above the daily limit ${cap}: not signed, rent stopped`);
    }
    return billed;
  }

  signBill(args: { billed: U128String; epoch: number; state: { seq: number; cumulativeAmount: U128String } }): Voucher {
    const amount = this.checkBill(args.billed);
    const voucher: UnsignedVoucher = {
      circle: this.#o.circle, payer: this.#o.payer, payee: this.#o.payee, epoch: args.epoch, seq: args.state.seq + 1,
      cumulativeAmount: (BigInt(args.state.cumulativeAmount) + BigInt(amount)).toString(), unit: CREDIT_UNIT, resource: `x207:grant:${this.#o.grantId}:cost`,
    };
    return signVoucher(voucher, this.#o.secretKey);
  }
}
