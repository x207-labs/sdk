// F8 Adaptor Aset Akses (SD-050, interface 0.0.6): tipe D10/D11 dari `abi.json` yang dipin dan antarmuka `AccessAssetAdapter` dengan lima fungsi
// `price`, `prove`, `deliver`, `meter`, `revoke` (Spec Antarmuka Kontrak 15, note Fitur F8). Prinsip: serahkan akses, bukan rahasia. `meter`
// selalu menghasilkan voucher ADR-17 biasa, dengan `payee` = pemberi grant (bukan akun broker), jadi inti x207 tidak berubah.
import type * as Abi from "./contract/types.generated.js";
import type { AccountId, U128String } from "./types.js";

import type { AssetClass } from "./marketplace.js";

/**
 * Kelas aset seperti disimpan registri D10: A dialihkan native, B kredensial turunan, C rahasia di broker TEE, D endpoint x402, dan X
 * (ditolak). `AssetClass` dari `marketplace.ts` adalah A sampai D saja, yaitu kelas yang boleh dipakai grant dan listing.
 */
export type RegisteredAssetClass = Abi.AssetClass;
/** Satu baris registri kelas aset D10, diset owner (DAO). */
export type AssetClassEntry = Abi.AssetClassEntry;
export type GrantLimits = Abi.GrantLimits;
export type GrantInput = Abi.GrantInput;
/** Satu grant D11. Tanpa field rahasia: yang disimpan hanya hash bukti dan status. */
export type AccessGrant = Abi.AccessGrant;
export type GrantStatus = Abi.GrantStatus;
export type GrantRole = Abi.GrantRole;
/** `GrantId` kontrak: angka, urutan sendiri dan terpisah dari `bundle_id`. */
export type GrantId = number;
/** Alasan `revoke_grant` (Spec 15.3). Dipakai event `grant_revoked`; method `revoke_grant` menyusul lewat CT-071. */
export type RevokeReason = "grantor" | "grantee" | "operator" | "expired" | "defaulted";

/** Unit harga yang dikenal kontrak (`GrantInput.unit`). */
export const GRANT_UNITS = ["call", "minute", "day", "once"] as const;
export type GrantUnit = (typeof GRANT_UNITS)[number];

/** Harga per unit sebuah grant, dalam satuan terkecil credit (6 desimal). */
export type PriceQuote = { assetType: string; unit: string; unitPrice: U128String };

/** Hasil `prove`: aset ada dan sesuai klaim. Bukan penilaian kualitas layanan. */
export type ProofResult = { valid: true } | { valid: false; reason: string };

/**
 * Tagihan pemakaian dari `meter`: bahan satu voucher kumulatif ADR-17. `payee` selalu pemberi grant dan `payer` penerima; `resource` memuat
 * `grantId` supaya facilitator dan penjual mengenali grant yang dibayar.
 */
export type MeterCharge = { payer: AccountId; payee: AccountId; amount: U128String; resource: string };

/** Pemakaian yang diukur: `quantity` unit (panggilan, menit, hari, atau 1 untuk `once`). */
export type Usage = { quantity: number };

/**
 * Lima fungsi adaptor. `Delivery` adalah apa yang pembeli terima dan tidak pernah berisi rahasia pemberi: endpoint (kelas D), kunci turunan
 * (kelas B), atau URL proxy (kelas C).
 */
export interface AccessAssetAdapter<Delivery = unknown, Evidence = unknown> {
  readonly assetClass: AssetClass;
  /** Harga dari grant. */
  price(grant: AccessGrant): PriceQuote | Promise<PriceQuote>;
  /** Buktikan aset ada dan sesuai grant (kelas B: `verifyFunctionCallKey`; kelas D: tidak perlu). */
  prove(grant: AccessGrant, evidence?: Evidence): ProofResult | Promise<ProofResult>;
  /** Serahkan akses ke penerima. */
  deliver(grant: AccessGrant): Delivery | Promise<Delivery>;
  /** Ukur pemakaian menjadi tagihan voucher ADR-17. */
  meter(grant: AccessGrant, usage: Usage): MeterCharge | Promise<MeterCharge>;
  /** Cabut akses. Kontrak yang mencatat status; adaptor menutup aksesnya (hapus kunci, hentikan proxy, tolak payer). */
  revoke(grant: AccessGrant, reason: RevokeReason): void | Promise<void>;
}

export class AccessGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessGrantError";
  }
}

/** `resource` voucher yang membayar sebuah grant: `x207:grant:<grantId>` (note Fitur F8). */
export const grantResource = (grantId: GrantId): string => `x207:grant:${grantId}`;

/** Kebalikan `grantResource`; `null` bila `resource` bukan resource grant. */
export function parseGrantResource(resource: string): GrantId | null {
  const match = /^x207:grant:(0|[1-9]\d*)$/.exec(resource);
  if (match === null) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Tagihan standar `quantity` × `unit_price` untuk grant `active`. `payee` = pemberi, bukan operator atau broker. Dipakai adaptor sebagai
 * dasar `meter`.
 */
export function meterGrant(grant: AccessGrant, usage: Usage): MeterCharge {
  if (grant.status !== "active") throw new AccessGrantError(`grant ${grant.grant_id} berstatus ${grant.status}, bukan active`);
  if (grant.grantee === null || grant.grantee === undefined) throw new AccessGrantError(`grant ${grant.grant_id} belum punya penerima`);
  if (!Number.isSafeInteger(usage.quantity) || usage.quantity < 1) throw new AccessGrantError("quantity harus integer >= 1");
  const amount = BigInt(grant.unit_price) * BigInt(usage.quantity);
  return { payer: grant.grantee, payee: grant.grantor, amount: amount.toString(), resource: grantResource(grant.grant_id) };
}

/** `price` standar: unit dan harga yang tertulis di grant. */
export const priceOfGrant = (grant: AccessGrant): PriceQuote => ({ assetType: grant.asset_type, unit: grant.unit, unitPrice: grant.unit_price });
