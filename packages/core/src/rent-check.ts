// Pure daily access-rent check (SD-071): used by `DailyRent` (renter SDK) and the access-rent page in the frontend, so the rule "do not pay for the next day of access that is
// already dead" exists only once. No network and no time: the caller supplies the broker answer, the clock, and the direct check result if any.

export type RentErrorCode = "rent_access_not_active" | "rent_access_expired" | "rent_direct_check_failed" | "rent_bill_over_cap" | "rent_bad_cap" | "rent_day_already_paid" | "rent_stopped" | "rent_bad_state";
export class RentError extends Error {
  readonly code: RentErrorCode;
  constructor(code: RentErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "RentError";
    this.code = code;
  }
}

/** Broker answer for one access (broker README, BE-060): only what is used here. */
export type AccessView = {
  grantId: number;
  status: "active" | "revoke_pending" | "revoked";
  /** End of the day already paid, unix ms. */
  paidUntil: number;
  today?: { day: string; cost: string | null; billed: string | null };
};


const fail = (code: RentErrorCode, message: string): never => {
  throw new RentError(code, message);
};

/**
 * Passes only if the broker says the access is `active` and still paid up to `nowMs`, and, if given, the direct check to the provider (`directCheck`, e.g. trying to log in)
 * succeeds. Otherwise throws `RentError`.
 */
export async function checkAccessBeforeNextDay(args: { grantId: number; view: AccessView; nowMs: number; directCheck?: () => Promise<boolean> }): Promise<void> {
  const { view } = args;
  if (view.grantId !== args.grantId) fail("rent_bad_state", `broker answer is for grant ${view.grantId}, not ${args.grantId}`);
  if (view.status !== "active") fail("rent_access_not_active", `broker answered ${view.status}: the next day is not paid`);
  if (view.paidUntil < args.nowMs) fail("rent_access_expired", "the paid day has passed and access was not extended");
  if (args.directCheck !== undefined) {
    let ok = false;
    try {
      ok = await args.directCheck();
    } catch {
      ok = false;
    }
    if (!ok) fail("rent_direct_check_failed", "direct check with the provider failed: access is not running");
  }
}
