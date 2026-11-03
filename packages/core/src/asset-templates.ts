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
  | "rwa_not_whitelisted" | "intents_token_id" | "pool_standard" | "secret_in_listing" | "ft_metadata_mismatch" | "circle_usdt";

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
/** `metadata`: hasil `ft_metadata`; bila ada, desimal dan simbol harus sama dengan ketikan pemilik (SD-066, X3). */
type FtRef = { ftContract: AccountId; amount: U128String; decimals: number; symbol: string; metadata?: FtMetadata };
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
  value.length >= 2 && value.length <= 64 && ACCOUNT.test(value) ? value : fail("bad_account", `${name} is not a NEAR account: ${JSON.stringify(value)}`);
// ASCII only (SD-066, X1): the listing format (`validateListing`) accepts only printable ASCII in the detail, so a token id with another character would pass the grant and the
// deposit and then be refused as a listing, with the asset held in escrow until the grant expires.
const tokenId = (value: string): string =>
  value.length >= 1 && value.length <= 128 && /^[\x20-\x7e]+$/.test(value) ? value : fail("bad_token_id", "token_id must be ASCII text of 1 to 128 characters");
const amount = (value: string): U128String =>
  AMOUNT.test(value) && BigInt(value) <= U128_MAX ? value : fail("bad_amount", `amount must be a decimal integer > 0 (smallest token unit), got ${JSON.stringify(value)}`);
const ascii = (value: string, name: string, max: number): string =>
  value.length >= 1 && value.length <= max && /^[\x20-\x7e]+$/.test(value) ? value : fail("bad_text", `${name} must be ASCII text of 1 to ${max} characters`);
const seconds = (value: number, name: string): number => (Number.isSafeInteger(value) && value > 0 ? value : fail("bad_expiry", `${name} must be unix seconds`));

/** `1500000` dengan 6 desimal menjadi `1.5`: hanya tampilan, tidak dikirim ke kontrak. */
export function formatTokenAmount(atomic: U128String, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) return fail("bad_decimals", "decimals must be an integer from 0 to 38");
  const digits = amount(atomic).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Hal yang hanya diketahui pemanggil (lingkaran dan token), disuntik supaya template tetap murni. */
export type AssetTemplateOptions = {
  /** USDT milik lingkaran (SD-066, X6): kontrak menolak titipannya (`ERR_ESCROW_USDT`), jadi template menolaknya lebih awal. */
  circleUsdt?: AccountId;
};

/** Hasil `ft_metadata` token (SD-066, X3): desimal dan simbol dibandingkan dengan ketikan pemilik. */
export type FtMetadata = { decimals: number; symbol: string };

const METADATA_WARNING = "Decimals and symbol are not checked against the token (ft_metadata): the amount display uses the owner's typed values, so wrong decimals make the amount display wrong compared with the smallest unit escrowed.";

/** Teks bebas yang tidak boleh berisi rahasia (SD-066, X5): kunci privat, kata sandi, kunci API, token layanan, dan kode kupon. Heuristik, bukan jaminan. */
const SECRET_TEXT: RegExp[] = [
  /\b(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{20,}/,
  /\b(?:password|passwd|passphrase|secret|api[_-]?key|private[_-]?key|seed[_ ]phrase)\b\s*[:=]/i,
  /\bsk[_-](?:live|test)?[_-]?[A-Za-z0-9]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\b(?:k[o]de|code|voucher|coupon|kupon)\b[^\n]{0,24}?\b[A-Z0-9]{3,}(?:-[A-Z0-9]{2,})+\b/,
  /\b[A-Z0-9]{3,}(?:-[A-Z0-9]{3,}){2,}\b/,
];
const NOT_FREE_TEXT = new Set(["terms_hash", "token_id", "ft_contract", "nft_contract", "mt_contract", "display", "termsHash", "tokenId", "ftContract", "nftContract", "mtContract", "kind"]);
function hasSecretText(value: unknown, key = ""): boolean {
  if (typeof value === "string") return !NOT_FREE_TEXT.has(key) && SECRET_TEXT.some((r) => r.test(value));
  if (Array.isArray(value)) return value.some((v) => hasSecretText(v, key));
  if (value !== null && typeof value === "object") return Object.entries(value).some(([k, v]) => hasSecretText(v, k));
  return false;
}

function checkMetadata(ft: AccountId, decimals: number, symbol: string, metadata: FtMetadata | undefined, warnings: string[]): void {
  if (metadata === undefined) {
    warnings.push(METADATA_WARNING);
    return;
  }
  if (metadata.decimals !== decimals || metadata.symbol !== symbol) {
    fail("ft_metadata_mismatch", `decimals or symbol differ from ft_metadata ${ft}: typed ${decimals} ${symbol}, token ${metadata.decimals} ${metadata.symbol}`);
  }
}

const FEE_WARNING = "Tokens with a transfer fee are not supported: the contract must receive the exact amount, so a deposit of a fee-charging token is rejected and the token goes back to the giver.";
const REGISTER_WARNING = "The buyer must be registered at the token contract (storage_deposit); otherwise the handover fails and its payment is cancelled.";

/**
 * Dari satu input per jenis ke scope, grant, sisi listing, detail, peringatan, dan titipan. Melempar `AssetTemplateError` dengan kode yang stabil bila input tidak sah.
 * @param now detik unix saat ini (disuntik supaya test deterministik)
 */
export function buildAssetTemplate(input: AssetInput, now: number = Math.floor(Date.now() / 1000), options: AssetTemplateOptions = {}): AssetTemplate {
  const entry = (KIND_TABLE as Record<string, (typeof KIND_TABLE)[AssetKind]>)[input.kind];
  if (!entry) return fail("bad_kind", `unknown asset kind: ${JSON.stringify((input as { kind?: unknown }).kind)}`);
  if (!AMOUNT.test(input.unitPrice) || BigInt(input.unitPrice) > U128_MAX) fail("bad_price", `unitPrice must be a decimal integer > 0, got ${JSON.stringify(input.unitPrice)}`);
  seconds(input.expiresAt, "expiresAt");
  if (input.expiresAt <= now) fail("bad_expiry", "expiresAt is in the past");

  // before the length checks: a long key typed in a free text field must be named as a secret, not as "too long"
  if (hasSecretText(input)) fail("secret_in_listing", "listing must not contain a code or secret");
  const warnings: string[] = [];
  const noUsdt = (ft: AccountId): void => {
    if (options.circleUsdt !== undefined && ft === options.circleUsdt) fail("circle_usdt", "circle USDT is not an escrow asset: the contract rejects its deposit (ERR_ESCROW_USDT)");
  };
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
      warnings.push("The escrowed NFT is held by the circle contract until it is bought or cancelled after the offer window; only the giver can take it back.");
      if (input.kind === "nft" && input.name !== undefined) meta.name = ascii(input.name, "name", 80);
      if (input.kind === "ticket") {
        const { name, startsAt, endsAt } = input.event;
        meta.event = { name: ascii(name, "event.name", 80), starts_at: seconds(startsAt, "event.startsAt"), ends_at: seconds(endsAt, "event.endsAt") };
        // one key for every kind that has a time limit (BE-049 reads `valid_until`); for a ticket it is the end of the event
        meta.valid_until = endsAt;
        if (endsAt <= startsAt) fail("bad_expiry", "event.endsAt must be after event.startsAt");
        if (endsAt <= now) fail("ticket_event_over", "the event is over: the ticket cannot be listed");
        if (input.expiresAt > endsAt) fail("ticket_offer_after_event", "the offer must not stay valid past the end of the event");
        warnings.push("A ticket is only valid until the event ends; the contract does not check its use. The buyer bears the risk of a ticket that was already used or is refused by the organizer.");
      }
      if (input.kind === "game-item") {
        meta.game = { name: ascii(input.game.name, "game.name", 80), ...(input.game.collection !== undefined ? { collection: ascii(input.game.collection, "game.collection", 80) } : {}) };
        warnings.push("The item value is set by the game; changes to the game rules are not guaranteed by the contract.");
      }
      if (input.kind === "coupon") {
        meta.description = ascii(input.description, "description", 120);
        meta.valid_until = seconds(input.validUntil, "validUntil");
        if (input.validUntil <= now) fail("coupon_expired", "the coupon is expired");
        if (input.expiresAt > input.validUntil) fail("coupon_offer_after_validity", "the offer must not stay valid past the coupon validity");
        warnings.push("The coupon code must not be in the listing: only its NFT is escrowed. A coupon bound to the owner's identity cannot be transferred (class X).");
      }
      if (input.kind === "license") {
        meta.product = ascii(input.product, "product", 80);
        if (!HASH_HEX.test(input.termsHash)) fail("license_terms_hash", "termsHash must be 64 lowercase hex characters (license terms hash)");
        if (!Number.isSafeInteger(input.seats) || input.seats < 1) fail("license_seats", "seats must be an integer >= 1");
        meta.terms_hash = input.termsHash;
        meta.seats = input.seats;
        warnings.push("The license terms in terms_hash bind the buyer; many licenses forbid transfer, and the contract does not check this. The giver must be entitled to transfer.");
      }
      break;
    }
    case "ft":
    case "rwa":
    case "lst": {
      const ft = account(input.ftContract, "ftContract");
      noUsdt(ft);
      const amt = amount(input.amount);
      const symbol = ascii(input.symbol, "symbol", 12);
      checkMetadata(ft, input.decimals, symbol, input.metadata, warnings);
      scope = ftEscrowGrantScope(ft, amt);
      deposit = (circle, grantId) => buildFtEscrowDepositCall({ circleContract: circle, ftContract: ft, amount: amt, grantId });
      Object.assign(meta, { ft_contract: ft, amount: amt, decimals: input.decimals, symbol, display: `${formatTokenAmount(amt, input.decimals)} ${symbol}` });
      warnings.push(FEE_WARNING, REGISTER_WARNING);
      if (input.kind === "rwa") {
        const check = input.whitelist;
        if (check === undefined) {
          warnings.push("Token whitelist not checked: an RWA token can refuse the handover to a buyer who is not whitelisted; the buyer payment is then cancelled and the grant stays on offer.");
        } else {
          if (!check.circleContract || !check.grantor) fail("rwa_not_whitelisted", "the circle contract and the giver must be in the token whitelist before listing");
          if (check.buyer === false) warnings.push("The buyer is not in the token whitelist yet: the handover fails until the buyer is whitelisted.");
          meta.whitelist = { circle_contract: check.circleContract, grantor: check.grantor, ...(check.buyer !== undefined ? { buyer: check.buyer } : {}) };
        }
        warnings.push("The circle keeps its own list of accepted tokens (circle list): an RWA listing can be rejected by the backend if this token is not on it, so check via listings/check before offer_grant and the escrow.");
        warnings.push("An RWA token is subject to its issuer's rules (whitelist, freeze, KYC); the contract does not guarantee its value.");
      }
      if (input.kind === "lst" && input.rate !== undefined) {
        if (!/^\d+(\.\d{1,24})?$/.test(input.rate.nearPerToken)) fail("bad_amount", "rate.nearPerToken must be a decimal number");
        meta.rate_info = { near_per_token: input.rate.nearPerToken, source: ascii(input.rate.source, "rate.source", 80), as_of: seconds(input.rate.asOf, "rate.asOf") };
        warnings.push("The exchange rate to NEAR is only information from the stated source; it is not an oracle and not binding.");
      }
      if (input.kind === "lst") warnings.push("A liquid staking token carries validator risk and withdrawal delays in its protocol.");
      break;
    }
    case "intents-balance": {
      const mt = account(input.mtContract, "mtContract");
      const token = tokenId(input.tokenId);
      if (!/^nep(141|245):.+/.test(token)) fail("intents_token_id", "the Intents balance token_id must start with nep141: or nep245:");
      if (options.circleUsdt !== undefined && token === `nep141:${options.circleUsdt}`) noUsdt(options.circleUsdt);
      const amt = amount(input.amount);
      scope = mtEscrowGrantScope(mt, token, amt);
      deposit = (circle, grantId) => buildMtEscrowDepositCall({ circleContract: circle, mtContract: mt, tokenId: token, amount: amt, grantId });
      Object.assign(meta, { mt_contract: mt, token_id: token, amount: amt, ...(input.label !== undefined ? { label: ascii(input.label, "label", 80) } : {}) });
      warnings.push(FEE_WARNING, "An Intents balance is a cross-chain multi-token owned by the issuer; only a mock contract is tested (not the real Intents contract yet).");
      break;
    }
    case "pool-share": {
      meta.pool = ascii(input.pool, "pool", 80);
      if (input.valueInfo !== undefined) meta.value_info = ascii(input.valueInfo, "valueInfo", 120);
      if (input.standard === "nep141") {
        const ft = account(input.ftContract, "ftContract");
        noUsdt(ft);
        const amt = amount(input.amount);
        const symbol = ascii(input.symbol, "symbol", 12);
        checkMetadata(ft, input.decimals, symbol, input.metadata, warnings);
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
        return fail("pool_standard", "standard must be nep141 or nep245");
      }
      warnings.push("The share value is only information; the contract does not compute the pool value and the share price changes with the pool content.");
      break;
    }
    default:
      return fail("bad_kind", "unknown asset kind");
  }

  if (/"(code|secret|password|api_?key)"\s*:/i.test(JSON.stringify(meta)) || hasSecretText(meta)) fail("secret_in_listing", "listing must not contain a code or secret");
  const detail = JSON.stringify(meta);
  if (detail.length > 2048) fail("detail_too_long", `detail is ${detail.length} characters, maximum 2048`);
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
