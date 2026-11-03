// Template scope dan listing per jenis aset on-chain batch 1 (SD-061, katalog #1 sampai #10, kelas A). Satu input per jenis menghasilkan: `limits.scope` untuk `offer_grant`
// (bentuk yang dibaca kontrak: `{nft_contract, token_id}`, `{ft_contract, amount}`, `{mt_contract, token_id, amount}`), `GrantInput` lengkap, satu sisi listing, `detail` JSON
// untuk listing (metadata jenis), peringatan risiko, dan panggilan titipan. Semua pemeriksaan murni dan tanpa jaringan; satu-satunya yang butuh jaringan, cek whitelist RWA,
// disuntik lewat `checkRwaWhitelist`. Nama `asset_type` dan metode serah sama dengan katalog (`scripts/lib/asset-catalog.mjs`).
import type { ContractCall } from "./contract/settlement.js";
import { buildFtEscrowDepositCall, buildMtEscrowDepositCall, buildNftEscrowDepositCall, escrowGrantScope, ftEscrowGrantScope, mtEscrowGrantScope, type GrantInput } from "./access.js";
import type { ListingSide } from "./marketplace.js";
import type { AccountId, U128String } from "./types.js";

export const ASSET_KINDS = ["nft", "ticket", "game-item", "coupon", "license", "ft", "rwa", "lst", "intents-balance", "pool-share"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** Kode galat yang stabil: backend (BE-049) dan frontend memetakan teks dari sini. */
export type AssetTemplateErrorCode =
  | "bad_kind" | "bad_account" | "bad_token_id" | "bad_amount" | "bad_decimals" | "bad_price" | "bad_expiry" | "bad_text" | "detail_too_long"
  | "ticket_event_over" | "ticket_offer_after_event" | "coupon_expired" | "coupon_offer_after_validity" | "license_terms_hash" | "license_seats"
  | "rwa_not_whitelisted" | "intents_token_id" | "pool_standard" | "secret_in_listing";

export class AssetTemplateError extends Error {
  constructor(readonly code: AssetTemplateErrorCode, message: string) {
    super(message);
    this.name = "AssetTemplateError";
  }
}

/** Dari mana kontrak membaca jenisnya: katalog D10 mengunci `asset_type`, kelas, dan metode serah. */
const KIND_TABLE: Record<AssetKind, { assetType: string; escrow: "nft" | "ft" | "mt" | "either" }> = {
  nft: { assetType: "nft:nep171", escrow: "nft" },
  ticket: { assetType: "ticket:event-nft", escrow: "nft" },
  "game-item": { assetType: "game:item-nft", escrow: "nft" },
  coupon: { assetType: "coupon:voucher-nft", escrow: "nft" },
  license: { assetType: "license:software-nft", escrow: "nft" },
  ft: { assetType: "token:nep141", escrow: "ft" },
  rwa: { assetType: "rwa:tokenized", escrow: "ft" },
  lst: { assetType: "lst:liquid-staking", escrow: "ft" },
  "intents-balance": { assetType: "intents:multi-token", escrow: "mt" },
  "pool-share": { assetType: "amm:lp-share", escrow: "either" },
};
export const DELIVERY_METHOD = { nft: "escrow_nft", ft: "escrow_ft", mt: "escrow_mt" } as const;

type Common = {
  /** Harga satu kali (`once`) dalam credit satuan terkecil, teks. */
  unitPrice: U128String;
  /** Batas penawaran grant, detik unix. Harus di masa depan dan tidak melewati batas jenisnya (acara, kupon). */
  expiresAt: number;
};
type NftRef = { nftContract: AccountId; tokenId: string };
type FtRef = { ftContract: AccountId; amount: U128String; decimals: number; symbol: string };
type MtRef = { mtContract: AccountId; tokenId: string; amount: U128String };

export type AssetInput =
  | ({ kind: "nft"; name?: string } & NftRef & Common)
  | ({ kind: "ticket"; event: { name: string; startsAt: number; endsAt: number } } & NftRef & Common)
  | ({ kind: "game-item"; game: { name: string; collection?: string } } & NftRef & Common)
  | ({ kind: "coupon"; description: string; validUntil: number } & NftRef & Common)
  | ({ kind: "license"; product: string; termsHash: string; seats: number } & NftRef & Common)
  | ({ kind: "ft" } & FtRef & Common)
  | ({ kind: "rwa"; whitelist?: { circleContract: boolean; grantor: boolean; buyer?: boolean } } & FtRef & Common)
  | ({ kind: "lst"; rate?: { nearPerToken: string; source: string; asOf: number } } & FtRef & Common)
  | ({ kind: "intents-balance"; label?: string } & MtRef & Common)
  | ({ kind: "pool-share"; pool: string; valueInfo?: string } & ({ standard: "nep141" } & FtRef | { standard: "nep245" } & MtRef) & Common);

export type AssetTemplate = {
  kind: AssetKind;
  assetType: string;
  assetClass: "A";
  deliveryMethod: string;
  /** `limits.scope` untuk `offer_grant`. */
  scope: string;
  grantInput: GrantInput;
  /** Satu sisi listing (`offer`), jumlah 1 lot dan nilai sama dengan harga. */
  side: ListingSide;
  /** Metadata jenis sebagai JSON kanonik ASCII, untuk `Listing.detail` (maksimal 2048 karakter). */
  detail: string;
  warnings: string[];
  /** Titipan pemberi setelah `offer_grant` mengembalikan `grantId`. */
  deposit(circleContract: AccountId, grantId: number): ContractCall;
};

const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const AMOUNT = /^[1-9]\d*$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const U128_MAX = 340282366920938463463374607431768211455n;
const fail = (code: AssetTemplateErrorCode, message: string): never => {
  throw new AssetTemplateError(code, message);
};

const account = (value: string, name: string): AccountId =>
  value.length >= 2 && value.length <= 64 && ACCOUNT.test(value) ? value : fail("bad_account", `${name} bukan akun NEAR: ${JSON.stringify(value)}`);
const tokenId = (value: string): string => (value.length >= 1 && value.length <= 128 ? value : fail("bad_token_id", "token_id harus 1 sampai 128 byte"));
const amount = (value: string): U128String =>
  AMOUNT.test(value) && BigInt(value) <= U128_MAX ? value : fail("bad_amount", `amount harus bilangan bulat desimal > 0 (satuan terkecil token), dapat ${JSON.stringify(value)}`);
const ascii = (value: string, name: string, max: number): string =>
  value.length >= 1 && value.length <= max && /^[\x20-\x7e]+$/.test(value) ? value : fail("bad_text", `${name} harus teks ASCII 1 sampai ${max} karakter`);
const seconds = (value: number, name: string): number => (Number.isSafeInteger(value) && value > 0 ? value : fail("bad_expiry", `${name} harus detik unix`));

/** `1500000` dengan 6 desimal menjadi `1.5`: hanya tampilan, tidak dikirim ke kontrak. */
export function formatTokenAmount(atomic: U128String, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) return fail("bad_decimals", "decimals harus bilangan bulat 0 sampai 38");
  const digits = amount(atomic).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

const FEE_WARNING = "Token dengan biaya transfer tidak didukung: kontrak harus menerima jumlah persis, jadi titipan dari token berbiaya ditolak dan token kembali ke pemberi.";
const REGISTER_WARNING = "Pembeli harus terdaftar di kontrak token (storage_deposit); kalau tidak, penyerahan gagal dan pembayarannya dibatalkan.";

/**
 * Dari satu input per jenis ke scope, grant, sisi listing, detail, peringatan, dan titipan. Melempar `AssetTemplateError` dengan kode yang stabil bila input tidak sah.
 * @param now detik unix saat ini (disuntik supaya test deterministik)
 */
export function buildAssetTemplate(input: AssetInput, now: number = Math.floor(Date.now() / 1000)): AssetTemplate {
  const entry = (KIND_TABLE as Record<string, (typeof KIND_TABLE)[AssetKind]>)[input.kind];
  if (!entry) return fail("bad_kind", `jenis aset tidak dikenal: ${JSON.stringify((input as { kind?: unknown }).kind)}`);
  if (!AMOUNT.test(input.unitPrice) || BigInt(input.unitPrice) > U128_MAX) fail("bad_price", `unitPrice harus bilangan bulat desimal > 0, dapat ${JSON.stringify(input.unitPrice)}`);
  seconds(input.expiresAt, "expiresAt");
  if (input.expiresAt <= now) fail("bad_expiry", "expiresAt sudah lewat");

  const warnings: string[] = [];
  const meta: Record<string, unknown> = { kind: input.kind };
  let escrow = entry.escrow;
  let scope: string;
  let deposit: AssetTemplate["deposit"];

  switch (input.kind) {
    case "nft":
    case "ticket":
    case "game-item":
    case "coupon":
    case "license": {
      const nft = account(input.nftContract, "nftContract");
      const token = tokenId(input.tokenId);
      scope = escrowGrantScope(nft, token);
      deposit = (circle, grantId) => buildNftEscrowDepositCall({ circleContract: circle, nftContract: nft, tokenId: token, grantId });
      meta.nft_contract = nft;
      meta.token_id = token;
      warnings.push("NFT yang dititipkan dipegang kontrak lingkaran sampai dibeli atau dibatalkan setelah masa penawaran; hanya pemberi yang mengambilnya kembali.");
      if (input.kind === "nft" && input.name !== undefined) meta.name = ascii(input.name, "name", 80);
      if (input.kind === "ticket") {
        const { name, startsAt, endsAt } = input.event;
        meta.event = { name: ascii(name, "event.name", 80), starts_at: seconds(startsAt, "event.startsAt"), ends_at: seconds(endsAt, "event.endsAt") };
        if (endsAt <= startsAt) fail("bad_expiry", "event.endsAt harus setelah event.startsAt");
        if (endsAt <= now) fail("ticket_event_over", "acara sudah selesai: tiket tidak bisa dilisting");
        if (input.expiresAt > endsAt) fail("ticket_offer_after_event", "penawaran tidak boleh berlaku sampai setelah acara selesai");
        warnings.push("Tiket hanya berlaku sampai acara selesai; kontrak tidak memeriksa pemakaiannya. Pembeli menanggung risiko tiket yang sudah dipakai atau ditolak penyelenggara.");
      }
      if (input.kind === "game-item") {
        meta.game = { name: ascii(input.game.name, "game.name", 80), ...(input.game.collection !== undefined ? { collection: ascii(input.game.collection, "game.collection", 80) } : {}) };
        warnings.push("Nilai item ditentukan oleh game; perubahan aturan game tidak dijamin kontrak.");
      }
      if (input.kind === "coupon") {
        meta.description = ascii(input.description, "description", 120);
        meta.valid_until = seconds(input.validUntil, "validUntil");
        if (input.validUntil <= now) fail("coupon_expired", "kupon sudah kedaluwarsa");
        if (input.expiresAt > input.validUntil) fail("coupon_offer_after_validity", "penawaran tidak boleh berlaku sampai setelah masa berlaku kupon");
        warnings.push("Kode kupon tidak boleh ada di listing: hanya NFT-nya yang dititipkan. Kupon yang terikat identitas pemilik tidak bisa dialihkan (kelas X).");
      }
      if (input.kind === "license") {
        meta.product = ascii(input.product, "product", 80);
        if (!HASH_HEX.test(input.termsHash)) fail("license_terms_hash", "termsHash harus 64 heksadesimal huruf kecil (hash syarat lisensi)");
        if (!Number.isSafeInteger(input.seats) || input.seats < 1) fail("license_seats", "seats harus bilangan bulat >= 1");
        meta.terms_hash = input.termsHash;
        meta.seats = input.seats;
        warnings.push("Syarat lisensi di terms_hash mengikat pembeli; banyak lisensi melarang dialihkan, dan kontrak tidak memeriksanya. Pemberi harus berhak mengalihkan.");
      }
      break;
    }
    case "ft":
    case "rwa":
    case "lst": {
      const ft = account(input.ftContract, "ftContract");
      const amt = amount(input.amount);
      const symbol = ascii(input.symbol, "symbol", 12);
      scope = ftEscrowGrantScope(ft, amt);
      deposit = (circle, grantId) => buildFtEscrowDepositCall({ circleContract: circle, ftContract: ft, amount: amt, grantId });
      Object.assign(meta, { ft_contract: ft, amount: amt, decimals: input.decimals, symbol, display: `${formatTokenAmount(amt, input.decimals)} ${symbol}` });
      warnings.push(FEE_WARNING, REGISTER_WARNING);
      if (input.kind === "rwa") {
        const check = input.whitelist;
        if (check === undefined) {
          warnings.push("Whitelist token belum diperiksa: token RWA bisa menolak penyerahan ke pembeli yang tidak di-whitelist; pembayaran pembeli lalu dibatalkan dan grant tetap ditawarkan.");
        } else {
          if (!check.circleContract || !check.grantor) fail("rwa_not_whitelisted", "kontrak lingkaran dan pemberi harus ada di whitelist token sebelum listing");
          if (check.buyer === false) warnings.push("Pembeli belum ada di whitelist token: penyerahan akan gagal sampai ia di-whitelist.");
          meta.whitelist = { circle_contract: check.circleContract, grantor: check.grantor, ...(check.buyer !== undefined ? { buyer: check.buyer } : {}) };
        }
        warnings.push("Token RWA tunduk pada aturan penerbitnya (whitelist, pembekuan, KYC); kontrak tidak menjamin nilainya.");
      }
      if (input.kind === "lst" && input.rate !== undefined) {
        if (!/^\d+(\.\d{1,24})?$/.test(input.rate.nearPerToken)) fail("bad_amount", "rate.nearPerToken harus bilangan desimal");
        meta.rate_info = { near_per_token: input.rate.nearPerToken, source: ascii(input.rate.source, "rate.source", 80), as_of: seconds(input.rate.asOf, "rate.asOf") };
        warnings.push("Nilai tukar ke NEAR hanya informasi dari sumber yang tertulis; bukan oracle dan tidak mengikat.");
      }
      if (input.kind === "lst") warnings.push("Liquid staking token punya risiko validator dan penundaan penarikan di protokolnya.");
      break;
    }
    case "intents-balance": {
      const mt = account(input.mtContract, "mtContract");
      const token = tokenId(input.tokenId);
      if (!/^nep(141|245):.+/.test(token)) fail("intents_token_id", "token_id saldo Intents harus berawalan nep141: atau nep245:");
      const amt = amount(input.amount);
      scope = mtEscrowGrantScope(mt, token, amt);
      deposit = (circle, grantId) => buildMtEscrowDepositCall({ circleContract: circle, mtContract: mt, tokenId: token, amount: amt, grantId });
      Object.assign(meta, { mt_contract: mt, token_id: token, amount: amt, ...(input.label !== undefined ? { label: ascii(input.label, "label", 80) } : {}) });
      warnings.push(FEE_WARNING, "Saldo Intents adalah multi-token milik penerbit lintas chain; hanya kontrak mock yang diuji (belum intents.near asli).");
      break;
    }
    case "pool-share": {
      meta.pool = ascii(input.pool, "pool", 80);
      if (input.valueInfo !== undefined) meta.value_info = ascii(input.valueInfo, "valueInfo", 120);
      if (input.standard === "nep141") {
        const ft = account(input.ftContract, "ftContract");
        const amt = amount(input.amount);
        const symbol = ascii(input.symbol, "symbol", 12);
        escrow = "ft";
        scope = ftEscrowGrantScope(ft, amt);
        deposit = (circle, grantId) => buildFtEscrowDepositCall({ circleContract: circle, ftContract: ft, amount: amt, grantId });
        Object.assign(meta, { standard: "nep141", ft_contract: ft, amount: amt, decimals: input.decimals, symbol, display: `${formatTokenAmount(amt, input.decimals)} ${symbol}` });
        warnings.push(FEE_WARNING, REGISTER_WARNING);
      } else if (input.standard === "nep245") {
        const mt = account(input.mtContract, "mtContract");
        const token = tokenId(input.tokenId);
        const amt = amount(input.amount);
        escrow = "mt";
        scope = mtEscrowGrantScope(mt, token, amt);
        deposit = (circle, grantId) => buildMtEscrowDepositCall({ circleContract: circle, mtContract: mt, tokenId: token, amount: amt, grantId });
        Object.assign(meta, { standard: "nep245", mt_contract: mt, token_id: token, amount: amt });
        warnings.push(FEE_WARNING);
      } else {
        return fail("pool_standard", "standard harus nep141 atau nep245");
      }
      warnings.push("Nilai share hanya informasi; kontrak tidak menghitung nilai pool dan harga share berubah dengan isi pool.");
      break;
    }
    default:
      return fail("bad_kind", "jenis aset tidak dikenal");
  }

  if (/"(code|secret|password|api_?key)"\s*:/i.test(JSON.stringify(meta))) fail("secret_in_listing", "listing tidak boleh memuat kode atau rahasia");
  const detail = JSON.stringify(meta);
  if (detail.length > 2048) fail("detail_too_long", `detail ${detail.length} karakter, maksimal 2048`);
  const deliveryMethod = DELIVERY_METHOD[escrow === "either" ? "ft" : escrow];
  return {
    kind: input.kind,
    assetType: entry.assetType,
    assetClass: "A",
    deliveryMethod,
    scope,
    grantInput: {
      asset_type: entry.assetType,
      delivery_method: deliveryMethod,
      limits: { scope, quota: null, expires_at: (BigInt(input.expiresAt) * 1_000_000_000n).toString() },
      unit: "once",
      unit_price: input.unitPrice,
      operator: null,
      proof_hash: null,
      proof_kind: null,
    },
    side: { asset_type: entry.assetType, asset_class: "A", quantity: 1, value: input.unitPrice },
    detail,
    warnings,
    deposit: (circleContract, grantId) => deposit(circleContract, grantId),
  };
}

/**
 * Cek whitelist token RWA lewat view token yang disuntik (tiap penerbit punya view sendiri; tidak ada standar). Mengembalikan akun yang tidak lolos; kosong berarti semua lolos.
 * @param check `(ftContract, account) => Promise<boolean>`
 */
export async function checkRwaWhitelist(
  check: (ftContract: AccountId, accountId: AccountId) => Promise<boolean>,
  ftContract: AccountId,
  accounts: readonly AccountId[],
): Promise<AccountId[]> {
  const failed: AccountId[] = [];
  for (const accountId of accounts) if (!(await check(ftContract, accountId))) failed.push(accountId);
  return failed;
}
