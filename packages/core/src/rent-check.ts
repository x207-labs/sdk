// Pemeriksaan sewa akses harian yang murni (SD-071): dipakai `DailyRent` (SDK penyewa) dan halaman sewa akses di frontend, jadi aturan "jangan bayar hari berikutnya untuk akses yang
// sudah mati" hanya ada satu. Tanpa jaringan dan tanpa waktu: pemanggil memberi jawaban broker, jam, dan hasil pemeriksaan langsung bila ada.

export type RentErrorCode = "rent_access_not_active" | "rent_access_expired" | "rent_direct_check_failed" | "rent_bill_over_cap" | "rent_bad_cap" | "rent_day_already_paid" | "rent_stopped" | "rent_bad_state";
export class RentError extends Error {
  readonly code: RentErrorCode;
  constructor(code: RentErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "RentError";
    this.code = code;
  }
}

/** Jawaban broker untuk satu akses (README broker, BE-060): hanya yang dipakai di sini. */
export type AccessView = {
  grantId: number;
  status: "active" | "revoke_pending" | "revoked";
  /** Akhir hari yang sudah dibayar, unix ms. */
  paidUntil: number;
  today?: { day: string; cost: string | null; billed: string | null };
};


const fail = (code: RentErrorCode, message: string): never => {
  throw new RentError(code, message);
};

/**
 * Lolos hanya bila broker mengatakan akses `active` dan masih terbayar sampai `nowMs`, dan, bila diberikan, pemeriksaan langsung ke penyedia (`directCheck`, mis. mencoba masuk)
 * berhasil. Selain itu melempar `RentError`.
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
