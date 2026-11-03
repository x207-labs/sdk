import { describe, expect, it } from "vitest";
import { RentError, generateVoucherKeypair, verifyVoucher, type AccessView } from "@x207/core";
import { DailyRent } from "@x207/scheme";

const keys = generateVoucherKeypair();
const NOW = Date.UTC(2026, 10, 4, 10);
const price = "2000000";
const rent = (over: Partial<ConstructorParameters<typeof DailyRent>[0]> = {}) =>
  new DailyRent({ circle: "x207-circle.near", payer: "renter.x207-circle.near", payee: "owner.x207-circle.near", grantId: 7, dailyPrice: price, dailyCap: "5000000", secretKey: keys.secretKey, now: () => NOW, ...over });
const view = (over: Partial<AccessView> = {}): AccessView => ({ grantId: 7, status: "active", paidUntil: NOW + 3_600_000, ...over });
const code = async (fn: () => unknown): Promise<string> => {
  try {
    await fn();
    return "no error";
  } catch (e) {
    return e instanceof RentError ? e.code : `other: ${String(e)}`;
  }
};

describe("SD-071 daily rent of an access, renter side", () => {
  it("TC-SD-071-06 the renter pays the next day only while the access works: active and paid, and the direct check of the provider passes", async () => {
    const r = rent();
    await r.checkBeforeNextDay(view(), async () => true);
    expect(await code(() => r.checkBeforeNextDay(view({ status: "revoked" })))).toBe("rent_access_not_active"); // taken back early by the owner
    expect(await code(() => r.checkBeforeNextDay(view({ status: "revoke_pending" })))).toBe("rent_access_not_active");
    expect(await code(() => r.checkBeforeNextDay(view({ paidUntil: NOW - 1 })))).toBe("rent_access_expired");
    expect(await code(() => r.checkBeforeNextDay(view(), async () => false))).toBe("rent_direct_check_failed"); // the broker says active but the key does not log in
    expect(await code(() => r.checkBeforeNextDay(view(), async () => { throw new Error("timeout"); }))).toBe("rent_direct_check_failed");
    expect(await code(() => r.checkBeforeNextDay(view({ grantId: 8 })))).toBe("rent_bad_state");
  });

  it("TC-SD-071-07 an access taken back early is not paid for the next day: the renter loses at most the one day it paid in advance", async () => {
    const r = rent();
    let state = { seq: 0, cumulativeAmount: "0" };
    const pay = (day: string) => {
      const v = r.signDay({ day, epoch: 42, state });
      state = { seq: v.seq, cumulativeAmount: v.cumulativeAmount };
      return v;
    };
    // day 1 is paid in advance (the 402 of the broker), day 2 after the check
    const d1 = pay("2026-11-04");
    expect(d1).toMatchObject({ payer: "renter.x207-circle.near", payee: "owner.x207-circle.near", seq: 1, cumulativeAmount: price, resource: "x207:grant:7" });
    expect(verifyVoucher(d1, keys.publicKey)).toBe(true);
    await r.checkBeforeNextDay(view());
    expect(pay("2026-11-05")).toMatchObject({ seq: 2, cumulativeAmount: "4000000" });
    // the owner takes it back during day 2: the check fails and nothing more is signed
    expect(await code(() => r.checkBeforeNextDay(view({ status: "revoked" })))).toBe("rent_access_not_active");
    expect(r.daysPaid).toBe(2);
    expect(state.cumulativeAmount).toBe("4000000");
  });

  it("TC-SD-071-08 one day is paid once; a stopped rent signs nothing more", async () => {
    const r = rent();
    const state = { seq: 0, cumulativeAmount: "0" };
    r.signDay({ day: "2026-11-04", epoch: 42, state });
    expect(await code(() => r.signDay({ day: "2026-11-04", epoch: 42, state }))).toBe("rent_day_already_paid");
    r.stop();
    expect(r.stopped).toBe(true);
    expect(await code(() => r.signDay({ day: "2026-11-05", epoch: 42, state }))).toBe("rent_stopped");
    expect(await code(() => r.checkBeforeNextDay(view()))).toBe("rent_stopped");
  });

  it("TC-SD-071-09 the real cost of a day is signed up to the daily cap and not above it; above the cap the rent stops; an access with no cap is not billed", async () => {
    const r = rent({ dailyCap: "5000000" });
    expect(r.checkBill("0")).toBe("0");
    expect(r.checkBill("5000000")).toBe("5000000");
    const v = r.signBill({ billed: "3000000", epoch: 42, state: { seq: 4, cumulativeAmount: "10000000" } });
    expect(v).toMatchObject({ seq: 5, cumulativeAmount: "13000000", resource: "x207:grant:7:cost" });
    expect(verifyVoucher(v, keys.publicKey)).toBe(true);
    expect(await code(() => r.signBill({ billed: "5000001", epoch: 42, state: { seq: 5, cumulativeAmount: "13000000" } }))).toBe("rent_bill_over_cap");
    expect(r.stopped).toBe(true); // a bill above the cap ends the rent
    expect(await code(() => r.signDay({ day: "2026-11-06", epoch: 42, state: { seq: 5, cumulativeAmount: "13000000" } }))).toBe("rent_stopped");
    const free = rent({ dailyCap: undefined });
    expect(free.checkBill("0")).toBe("0");
    expect(await code(() => free.checkBill("1"))).toBe("rent_bill_over_cap");
    expect(await code(() => rent().checkBill("1.5"))).toBe("rent_bad_state");
  });

  it("TC-SD-071-10 the options are checked: a price above zero and a cap that is a whole number", async () => {
    expect(await code(() => rent({ dailyPrice: "0" }))).toBe("rent_bad_cap");
    expect(await code(() => rent({ dailyPrice: "1.5" }))).toBe("rent_bad_cap");
    expect(await code(() => rent({ dailyCap: "-1" }))).toBe("rent_bad_cap");
  });
});
