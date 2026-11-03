// Format invoice dan cicilan (SD-065, pipeline P8, ADR-44). Invoice adalah klaim issuer atas debtor di luar x207. Bila debtor menandatanganinya sebagai voucher biasa, klaim itu
// menjadi edge D2 `debtor -> issuer` dan ikut kliring F3; kontrak tidak berubah. Yang ditandatangani debtor adalah voucher yang sudah ada: `payer = debtor`, `payee = issuer`,
// `unit = "credit"`, `resource = "x207:invoice:<hash>"`, dan `cumulativeAmount` = kumulatif pasangan sebelumnya + jumlah invoice (CT-076).
//
// Cicilan (ADR-44): n voucher di n epoch berurutan, SEMUANYA ditandatangani debtor di depan, masing-masing dengan `seq` 1 pasangan di epochnya dan kumulatif sebesar cicilan itu.
// Voucher biasa debtor ke issuer di epoch yang sama baru dimulai di `seq` 2 dengan kumulatif yang sudah memuat cicilan (`installmentState`). Tidak ada voucher cadangan di depan:
// issuer bisa mendaftarkannya walau cicilan aslinya sudah dibayar, sehingga debtor membayar dua kali. Cicilan yang gagal (headroom habis) digeser SEKALI ke epoch berikutnya dengan
// voucher susulan (`catchUpVoucher`) yang ditandatangani debtor setelah gagal; gagal lagi menjadi `missed`, tanpa denda otomatis.
//
// BATAS YANG DIAKUI (bukan jaminan): kontrak hanya menolak `seq` yang tidak naik per (payer, payee, epoch) dan membolehkan celah `seq`. Debtor bisa memblokir voucher cicilan dengan
// mendaftarkan dulu voucher ber-`seq` lebih tinggi ke issuer; cicilan `seq` 1 lalu ditolak. Tanda tangan di depan adalah bukti, bukan jaminan pembayaran. Penangkalnya ada di luar
// format ini: status `blocked_by_debtor` dan reputasi (backend), serta jaminan CT-094 untuk invoice besar. Jaminan penuh butuh penguncian headroom lintas epoch di kontrak.
import { createHash } from "node:crypto";
import { CREDIT_UNIT } from "./constants.js";
import type { AccountId, U128String, UnsignedVoucher, Voucher } from "./types.js";
import { signVoucher, type VoucherSecretKey } from "./voucher.js";

export type InvoiceErrorCode =
  | "invoice_bad_id" | "invoice_bad_account" | "invoice_same_party" | "invoice_bad_amount" | "invoice_bad_memo" | "invoice_bad_resource"
  | "installment_count" | "installment_amount_too_small" | "installment_bad_epoch" | "installment_not_found" | "installment_already_shifted" | "installment_bad_state";

export class InvoiceError extends Error {
  constructor(readonly code: InvoiceErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "InvoiceError";
  }
}

/** Dokumen invoice. Hanya hash-nya yang masuk rantai (di `resource`); isi dan `memo` tetap di luar. */
export type InvoiceDocument = { id: string; issuer: AccountId; debtor: AccountId; amount: U128String; memo: string };

export const INVOICE_RESOURCE_PREFIX = "x207:invoice:";
/** Paling banyak cicilan per invoice: satu voucher per epoch, dan tiap epoch memakai headroom debtor. */
export const MAX_INSTALLMENTS = 24;

const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const AMOUNT = /^[1-9]\d*$/;
const ID = /^[A-Za-z0-9._:/-]{1,64}$/;
const U128_MAX = 340282366920938463463374607431768211455n;
const fail = (code: InvoiceErrorCode, message: string): never => {
  throw new InvoiceError(code, message);
};

function checkDocument(doc: InvoiceDocument): void {
  if (typeof doc.id !== "string" || !ID.test(doc.id)) fail("invoice_bad_id", "id harus 1 sampai 64 karakter [A-Za-z0-9._:/-]");
  for (const [name, value] of [["issuer", doc.issuer], ["debtor", doc.debtor]] as const) {
    if (typeof value !== "string" || value.length < 2 || value.length > 64 || !ACCOUNT.test(value)) fail("invoice_bad_account", `${name} bukan akun NEAR: ${JSON.stringify(value)}`);
  }
  if (doc.issuer === doc.debtor) fail("invoice_same_party", "issuer dan debtor harus akun yang berbeda");
  if (typeof doc.amount !== "string" || !AMOUNT.test(doc.amount) || BigInt(doc.amount) > U128_MAX) fail("invoice_bad_amount", `amount harus bilangan bulat desimal > 0 (satuan terkecil), dapat ${JSON.stringify(doc.amount)}`);
  if (typeof doc.memo !== "string" || doc.memo.length > 256 || !/^[\x20-\x7e]*$/.test(doc.memo)) fail("invoice_bad_memo", "memo harus teks ASCII paling banyak 256 karakter");
}

/** JSON kanonik `{id, issuer, debtor, amount, memo}` (urutan key tetap, tanpa spasi); sama dengan format AG-021. */
export function serializeInvoice(doc: InvoiceDocument): string {
  checkDocument(doc);
  const { id, issuer, debtor, amount, memo } = doc;
  return JSON.stringify({ id, issuer, debtor, amount, memo });
}

/** sha256 atas JSON kanonik; heks huruf kecil 64 karakter. */
export function invoiceHash(doc: InvoiceDocument): string {
  return createHash("sha256").update(serializeInvoice(doc)).digest("hex");
}

/** `x207:invoice:<hash>`. */
export function invoiceResource(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) fail("invoice_bad_resource", "hash invoice harus 64 heksadesimal huruf kecil");
  return `${INVOICE_RESOURCE_PREFIX}${hash}`;
}

/** Hash dari `resource` voucher invoice, atau `null` bila bukan resource invoice. */
export function parseInvoiceResource(resource: string): string | null {
  if (!resource.startsWith(INVOICE_RESOURCE_PREFIX)) return null;
  const hash = resource.slice(INVOICE_RESOURCE_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

/** Keadaan pasangan (debtor, issuer) di satu epoch: `seq` terakhir dan kumulatif yang sudah terdaftar (0 dan "0" bila belum ada voucher). */
export type InvoicePairState = { seq: number; cumulativeAmount: U128String };

const checkState = (state: InvoicePairState): void => {
  if (!Number.isSafeInteger(state.seq) || state.seq < 0 || !/^(0|[1-9]\d*)$/.test(state.cumulativeAmount)) fail("installment_bad_state", `keadaan pasangan tidak sah: ${JSON.stringify(state)}`);
};

/** Voucher invoice biasa (satu kali bayar): melanjutkan keadaan pasangan di epoch `epoch`. */
export function invoiceVoucher(args: { circle: AccountId; doc: InvoiceDocument; epoch: number; state: InvoicePairState }): UnsignedVoucher {
  checkState(args.state);
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 1) fail("installment_bad_epoch", `epoch harus bilangan bulat >= 1, dapat ${args.epoch}`);
  return {
    circle: args.circle, payer: args.doc.debtor, payee: args.doc.issuer, epoch: args.epoch, seq: args.state.seq + 1,
    cumulativeAmount: (BigInt(args.state.cumulativeAmount) + BigInt(args.doc.amount)).toString(), unit: CREDIT_UNIT, resource: invoiceResource(invoiceHash(args.doc)),
  };
}

export const signInvoiceVoucher = (voucher: UnsignedVoucher, secretKey: VoucherSecretKey): Voucher => signVoucher(voucher, secretKey);

/** Jadwal epoch: epoch yang sedang berjalan, kapan dibuka (detik unix), dan `epoch_length` (detik). */
export type EpochClock = { epoch: number; openedAt: number; epochLength: number };

/**
 * Epoch yang berjalan pada `time` (detik unix) menurut jadwal nominal `openedAt + n × epochLength`. Ini perkiraan: kontrak membuka epoch berikutnya saat `close_epoch` dipanggil,
 * jadi epoch yang sebenarnya bisa bergeser; issuer tetap harus mendaftarkan sebelum `cutoff_at` epoch itu. Waktu sebelum `openedAt` ditolak.
 */
export function epochForTime(time: number, clock: EpochClock): number {
  if (!Number.isFinite(time) || !Number.isSafeInteger(clock.epoch) || clock.epoch < 1 || !(clock.epochLength > 0) || time < clock.openedAt) {
    return fail("installment_bad_epoch", "waktu harus tidak lebih awal dari pembukaan epoch yang berjalan, dengan epochLength > 0");
  }
  return clock.epoch + Math.floor((time - clock.openedAt) / clock.epochLength);
}

export type Installment = { index: number; epoch: number; amount: U128String };
export type InstallmentPlan = { circle: AccountId; doc: InvoiceDocument; hash: string; resource: string; installments: Installment[] };

/**
 * Rencana `count` cicilan di epoch `firstEpoch`, `firstEpoch + 1`, ... Jumlah dibagi rata; sisa pembagian dibagikan satu satuan terkecil ke cicilan pertama, jadi jumlah semua cicilan
 * persis jumlah invoice. `count` 1 sampai `MAX_INSTALLMENTS`, dan tiap cicilan paling sedikit 1 satuan terkecil.
 */
export function planInstallments(args: { circle: AccountId; doc: InvoiceDocument; firstEpoch: number; count: number }): InstallmentPlan {
  const { circle, doc, firstEpoch, count } = args;
  const hash = invoiceHash(doc);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_INSTALLMENTS) fail("installment_count", `count harus bilangan bulat 1 sampai ${MAX_INSTALLMENTS}, dapat ${count}`);
  if (!Number.isSafeInteger(firstEpoch) || firstEpoch < 1) fail("installment_bad_epoch", `firstEpoch harus bilangan bulat >= 1, dapat ${firstEpoch}`);
  const total = BigInt(doc.amount);
  if (total < BigInt(count)) fail("installment_amount_too_small", `jumlah ${doc.amount} tidak cukup untuk ${count} cicilan`);
  const base = total / BigInt(count);
  const extra = Number(total % BigInt(count));
  return {
    circle, doc, hash, resource: invoiceResource(hash),
    installments: Array.from({ length: count }, (_, i) => ({ index: i + 1, epoch: firstEpoch + i, amount: (base + (i < extra ? 1n : 0n)).toString() })),
  };
}

const installmentAt = (plan: InstallmentPlan, index: number): Installment =>
  plan.installments.find((i) => i.index === index) ?? fail("installment_not_found", `cicilan ${index} tidak ada; rencana ini punya ${plan.installments.length}`);

/**
 * Voucher cicilan `index`, ditandatangani di depan: `seq` 1 pasangan di epochnya dan kumulatif sebesar cicilan itu. Hanya benar bila pasangan belum punya voucher di epoch itu;
 * tidak ada parameter keadaan karena memang begitu aturannya.
 */
export function installmentVoucher(plan: InstallmentPlan, index: number): UnsignedVoucher {
  const item = installmentAt(plan, index);
  return {
    circle: plan.circle, payer: plan.doc.debtor, payee: plan.doc.issuer, epoch: item.epoch, seq: 1, cumulativeAmount: item.amount, unit: CREDIT_UNIT, resource: plan.resource,
  };
}

/** Semua voucher cicilan bertanda tangan, satu per epoch, dalam satu kali tanda tangan di depan. */
export const signInstallments = (plan: InstallmentPlan, secretKey: VoucherSecretKey): Voucher[] =>
  plan.installments.map((i) => signVoucher(installmentVoucher(plan, i.index), secretKey));

/**
 * Keadaan pasangan di epoch cicilan `index` sesudah cicilan itu terdaftar: voucher biasa debtor ke issuer di epoch itu mulai di `seq` 2 dengan kumulatif yang sudah memuat cicilan.
 * Untuk mengisi `VoucherStateStore` klien supaya voucher berikutnya tidak memakai `seq` 1 lagi.
 */
export function installmentState(plan: InstallmentPlan, index: number): { epoch: number; state: InvoicePairState } {
  const item = installmentAt(plan, index);
  return { epoch: item.epoch, state: { seq: 1, cumulativeAmount: item.amount } };
}

/**
 * Voucher susulan untuk cicilan `index` yang gagal didaftarkan karena headroom habis: digeser SEKALI ke epoch berikutnya (`epoch` cicilan + 1), melanjutkan keadaan pasangan di epoch
 * itu (`state`, apa yang terdaftar sekarang, termasuk cicilan epoch itu sendiri bila ada). Panggil hanya setelah kegagalan terjadi; JANGAN menandatangani voucher ini di depan.
 * `alreadyShifted` true berarti cicilan ini sudah pernah digeser: gagal lagi menjadi `missed`, dan fungsi ini menolak.
 *
 * PERINGATAN (tinjauan BE-062, F9): fungsi ini menandatangani di atas `state` APA PUN yang diberikan. `state` harus dibaca dari KONTRAK oleh penandatangan sendiri (view `obligation`),
 * tidak pernah dari penagih atau backend: keadaan yang digelembungkan membuat debtor membayar selisihnya kepada penagih. Pakai `catchUpVoucherFromChain` bila bisa, yang membaca keadaan itu sendiri.
 */
export function catchUpVoucher(plan: InstallmentPlan, index: number, state: InvoicePairState, alreadyShifted: boolean): UnsignedVoucher {
  const item = installmentAt(plan, index);
  if (alreadyShifted) fail("installment_already_shifted", `cicilan ${index} sudah digeser sekali; gagal lagi berarti missed`);
  checkState(state);
  return {
    circle: plan.circle, payer: plan.doc.debtor, payee: plan.doc.issuer, epoch: item.epoch + 1, seq: state.seq + 1,
    cumulativeAmount: (BigInt(state.cumulativeAmount) + BigInt(item.amount)).toString(), unit: CREDIT_UNIT, resource: plan.resource,
  };
}

/** View `obligation` kontrak untuk satu pasangan di satu epoch (hasil `ObligationView`, atau `null` bila pasangan belum punya voucher di epoch itu). */
export type ViewObligationFn = (args: { epoch: number; debtor: AccountId; creditor: AccountId }) => Promise<{ cumulative: string; last_seq: number } | null>;

/**
 * Seperti `catchUpVoucher`, tetapi keadaan pasangan di epoch tujuan dibaca sendiri dari kontrak lewat `viewObligation` (F9): penandatangan tidak bisa diberi keadaan palsu oleh pihak lain.
 */
export async function catchUpVoucherFromChain(plan: InstallmentPlan, index: number, viewObligation: ViewObligationFn, alreadyShifted: boolean): Promise<UnsignedVoucher> {
  const item = installmentAt(plan, index);
  const row = await viewObligation({ epoch: item.epoch + 1, debtor: plan.doc.debtor, creditor: plan.doc.issuer });
  return catchUpVoucher(plan, index, { seq: row?.last_seq ?? 0, cumulativeAmount: row?.cumulative ?? "0" }, alreadyShifted);
}
