// F8 Adaptor Aset Akses (SD-050, interface 0.0.8): tipe D10/D11 dari `abi.json` yang dipin dan antarmuka `AccessAssetAdapter` dengan lima fungsi
// `price`, `prove`, `deliver`, `meter`, `revoke` (Spec Antarmuka Kontrak 15, note Fitur F8). Prinsip: serahkan akses, bukan rahasia. `meter`
// selalu menghasilkan voucher ADR-17 biasa, dengan `payee` = pemberi grant (bukan akun broker), jadi inti x207 tidak berubah.
import type * as Abi from "./contract/types.generated.js";
import type { AccountId, U128String } from "./types.js";
import type { ContractCall } from "./contract/settlement.js";

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
/** Alasan `revoke_grant` (Spec 15.3), juga di event `grant_revoked`. */
export type RevokeReason = Abi.RevokeReason;

/**
 * Escrow kelas A (interface 0.0.7, CT-075): NFT dipegang kontrak lingkaran sampai grant selesai. Grant kelas A tidak memakai `accept_grant`
 * (ditolak); pembeli memanggil `complete_escrow` dengan voucher bertanda tangan, pemberi bisa `cancel_escrow` setelah `expires_at`.
 */
export type EscrowState = Abi.EscrowState;
/** Langkah yang diselesaikan `on_escrow_resolved`, juga di event `escrow_failed`. */
export type EscrowStep = Abi.EscrowStep;
/** Hasil view `get_escrow`; `null` bila grant tidak punya escrow. */
export type EscrowView = Abi.EscrowView;

/**
 * `limits.scope` wajib untuk grant kelas A (interface 0.0.8): JSON dengan `nft_contract` dan `token_id`, tanpa itu `offer_grant` menjawab
 * `ERR_BAD_GRANT` dan `nft_on_transfer` menolak NFT lain dengan `ERR_ESCROW_NFT_MISMATCH`.
 */
export const escrowGrantScope = (nftContract: AccountId, tokenId: string): string => JSON.stringify({ nft_contract: nftContract, token_id: tokenId });

/**
 * Titipan NFT pemberi grant kelas A: `nft_transfer_call` NEP-171 di kontrak NFT ke kontrak lingkaran dengan `msg` `{"grant_id":N}` (tanpa `action`, beda dengan token),
 * deposit 1 yoctoNEAR. Hanya NFT dan kontrak yang tertulis di scope (`escrowGrantScope`) yang diterima (`ERR_ESCROW_NFT_MISMATCH`).
 */
export function buildNftEscrowDepositCall(input: { circleContract: AccountId; nftContract: AccountId; tokenId: string; grantId: GrantId }): ContractCall {
  if (!Number.isSafeInteger(input.grantId) || input.grantId < 1) throw new AccessGrantError(`grantId must be an integer >= 1, got ${input.grantId}`);
  if (input.tokenId.length < 1 || input.tokenId.length > 128) throw new AccessGrantError("tokenId must be 1 to 128 bytes");
  return {
    receiverId: input.nftContract,
    methodName: "nft_transfer_call",
    args: { receiver_id: input.circleContract, token_id: input.tokenId, msg: JSON.stringify({ grant_id: input.grantId }) },
    deposit: 1n,
  };
}

/**
 * Escrow kelas A untuk token fungible NEP-141 (interface 0.0.10, CT-090): jumlah persis yang dipegang kontrak lingkaran. Hasil view `get_ft_escrow`; `null`
 * bila grant tidak punya escrow token. Token dengan transfer fee are not supported: kontrak memegang jumlah yang benar-benar tiba, dan jumlah itu harus
 * sama dengan `amount` di `limits.scope`, jadi titipan dari token berbiaya ditolak.
 */
export type FtEscrowView = Abi.FtEscrowView;

/**
 * Escrow kelas A untuk satu multi-token NEP-245 (interface 0.0.11, CT-092): jumlah persis dari satu `token_id` di satu kontrak multi-token, misalnya saldo
 * `nep141:<usdt>` di NEAR Intents atau share pool. Hasil view `get_mt_escrow`; `null` bila grant tidak punya escrow multi-token. Satu titipan hanya boleh
 * memuat satu token dan satu jumlah (`ERR_ESCROW_MT_BATCH` untuk titipan batch). Token bertransfer fee are not supported seperti pada NEP-141.
 */
export type MtEscrowView = Abi.MtEscrowView;

/**
 * `limits.scope` grant kelas A untuk multi-token: JSON dengan `mt_contract`, `token_id` dan `amount` (satuan terkecil token itu, teks). Titipan harus sama
 * persis; kontrak, token, atau jumlah lain ditolak (`ERR_ESCROW_MT_MISMATCH`, `ERR_ESCROW_MT_AMOUNT`).
 */
export const mtEscrowGrantScope = (mtContract: AccountId, tokenId: string, amount: U128String): string => {
  if (tokenId.length === 0) throw new AccessGrantError("tokenId must not be empty");
  if (!/^[1-9]\d*$/.test(amount)) throw new AccessGrantError(`amount must be an integer string > 0, got ${JSON.stringify(amount)}`);
  return JSON.stringify({ mt_contract: mtContract, token_id: tokenId, amount });
};

/**
 * Titipan pemberi grant untuk multi-token: `mt_transfer_call` NEP-245 (satu token) di kontrak multi-token ke kontrak lingkaran, dengan `msg` yang sama
 * seperti titipan NEP-141 (`{"action":"escrow","grant_id":N}`), jumlah persis dari scope, dan deposit 1 yoctoNEAR. Titipan batch (`mt_batch_transfer_call`)
 * ditolak kontrak.
 */
export function buildMtEscrowDepositCall(input: { circleContract: AccountId; mtContract: AccountId; tokenId: string; amount: U128String; grantId: GrantId }): ContractCall {
  mtEscrowGrantScope(input.mtContract, input.tokenId, input.amount);
  return {
    receiverId: input.mtContract,
    methodName: "mt_transfer_call",
    args: { receiver_id: input.circleContract, token_id: input.tokenId, amount: input.amount, approval: null, memo: null, msg: buildFtEscrowMsg(input.grantId) },
    deposit: 1n,
  };
}

/**
 * `limits.scope` grant kelas A untuk token NEP-141: JSON dengan `ft_contract` dan `amount` (satuan terkecil token, teks). Titipan harus sama persis dengan
 * jumlah ini; kontrak token lain atau jumlah lain ditolak saat titip.
 */
export const ftEscrowGrantScope = (ftContract: AccountId, amount: U128String): string => {
  if (!/^[1-9]\d*$/.test(amount)) throw new AccessGrantError(`amount must be an integer string > 0, got ${JSON.stringify(amount)}`);
  return JSON.stringify({ ft_contract: ftContract, amount });
};

/** `msg` titipan token: `{"action":"escrow","grant_id":N}` (diterima `ft_on_transfer` dari token mana pun selain USDT lingkaran). */
export function buildFtEscrowMsg(grantId: GrantId): string {
  if (!Number.isSafeInteger(grantId) || grantId < 1) throw new AccessGrantError(`grantId must be an integer >= 1, got ${grantId}`);
  return JSON.stringify({ action: "escrow", grant_id: grantId });
}

/**
 * Titipan pemberi grant: `ft_transfer_call` di kontrak token ke kontrak lingkaran dengan `msg` escrow dan jumlah persis dari scope. Deposit 1 yoctoNEAR
 * (standar NEP-141). Pemberi harus sudah menawarkan grant (`offer_grant`) dengan scope yang sama, dan harus anggota aktif.
 */
export function buildFtEscrowDepositCall(input: { circleContract: AccountId; ftContract: AccountId; amount: U128String; grantId: GrantId }): ContractCall {
  ftEscrowGrantScope(input.ftContract, input.amount);
  return {
    receiverId: input.ftContract,
    methodName: "ft_transfer_call",
    args: { receiver_id: input.circleContract, amount: input.amount, msg: buildFtEscrowMsg(input.grantId) },
    deposit: 1n,
  };
}

/**
 * Pembeli harus terdaftar di kontrak token (NEP-145 `storage_balance_of` tidak `null`) sebelum `complete_escrow`: kalau tidak, `ft_transfer` ke pembeli
 * gagal dan pembayaran dibatalkan. Helper ini membaca view di kontrak token dan menolak sebelum transaksi dikirim.
 * @param view membaca view di kontrak mana pun: `(contractId, method, args) => hasil JSON`
 */
export async function assertBuyerRegisteredAtToken(
  view: (contractId: AccountId, methodName: string, args: object) => Promise<unknown>,
  ftContract: AccountId,
  buyer: AccountId,
): Promise<void> {
  let balance: unknown;
  try {
    balance = await view(ftContract, "storage_balance_of", { account_id: buyer });
  } catch (error) {
    throw new AccessGrantError(`storage_balance_of at ${ftContract} failed for ${buyer}: ${(error as Error).message}`);
  }
  if (balance === null || balance === undefined) {
    throw new AccessGrantError(`${buyer} is not registered at ${ftContract} (storage_deposit): the token payment would fail and be cancelled`);
  }
}

/**
 * Semua grant `offered` dan `active` milik satu akun dalam satu peran. `grants_of` berhalaman sejak interface 0.0.8 dan tidak lagi memuat
 * grant yang sudah berakhir (`get_grant` tetap menjawabnya), jadi halaman dibaca sampai halaman yang tidak penuh.
 */
export async function listGrantsOf(view: (methodName: string, args: object) => Promise<unknown>, accountId: AccountId, role: GrantRole, pageSize = 50): Promise<AccessGrant[]> {
  const all: AccessGrant[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = (await view("grants_of", { account_id: accountId, role, from_index: from, limit: pageSize })) as AccessGrant[];
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}

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
  if (grant.status !== "active") throw new AccessGrantError(`grant ${grant.grant_id} has status ${grant.status}, not active`);
  if (grant.grantee === null || grant.grantee === undefined) throw new AccessGrantError(`grant ${grant.grant_id} has no grantee yet`);
  if (!Number.isSafeInteger(usage.quantity) || usage.quantity < 1) throw new AccessGrantError("quantity must be an integer >= 1");
  const amount = BigInt(grant.unit_price) * BigInt(usage.quantity);
  return { payer: grant.grantee, payee: grant.grantor, amount: amount.toString(), resource: grantResource(grant.grant_id) };
}

/** `price` standar: unit dan harga yang tertulis di grant. */
export const priceOfGrant = (grant: AccessGrant): PriceQuote => ({ assetType: grant.asset_type, unit: grant.unit, unitPrice: grant.unit_price });
