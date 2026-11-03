// Konstanta tunggal x207 (SD-003, ADR-32 K-34). Nilai ini hanya didefinisikan di sini; modul lain
// mengimpor. `spec/test-vectors/constants.json` mencerminkan isinya untuk CI Rust `contracts`.

/** 1 credit = 1 USD; satuan terkecil 10^-6 (1 credit = 1_000_000 unit). */
export const CREDIT_DECIMALS = 6 as const;
export const CREDIT_UNIT = "credit" as const;

export const USDT_TOKEN_ID = "usdt.tether-token.near";
export const INTENTS_ID = "intents.near";
export const SPUTNIK_DAO_FACTORY = "sputnik-dao.near";

/** FastNEAR sebagai utama, RPC publik NEAR sebagai cadangan failover. */
export const RPC_URLS = [
  "https://rpc.mainnet.fastnear.com",
  "https://rpc.mainnet.near.org",
] as const;

export const ONE_CLICK_API_URL = "https://1click.chaindefuser.com";
export const NEAR_AI_CLOUD_URL = "https://cloud-api.near.ai/v1";

/** Batas leg satu bundle di kontrak (interface 0.0.8, `ERR_BAD_BUNDLE`): lebih dari ini log `bundle_committed` melewati 16 KiB. */
export const MAX_BUNDLE_LEGS = 64;
/** Limits of interface 0.0.8 (ADR-40): open intents of one member, bundles of one participant per epoch, items one `prune_epoch` call removes at most. */
export const MAX_OPEN_INTENTS_PER_MEMBER = 64;
export const MAX_BUNDLES_PER_MEMBER_PER_EPOCH = 16;
export const PRUNE_MAX_ITEMS_PER_CALL = 200;

/**
 * Least deposit of `join`, in yoctoNEAR: `JOIN_STORAGE_DEPOSIT` of the contract (Spec Antarmuka Kontrak, `join`). The only place in this repository that
 * writes the number: `buildJoinCall`, the frontend, the agents and the tests read it from here. 0.0.12 needs 0.35 NEAR (ADR-41, raised from 0.32 because the worst
 * storage of one member grew with the bond of CT-094 to 34 236 bytes, 0.3424 NEAR); 0.0.11 refunds the excess above its own 0.32 (`member.rs`), and a contract before
 * 0.0.9 asks for 0.01 NEAR and returns what is above it in the same receipt chain, so this value also works against them. The deposit is not returned when the member exits.
 */
export const JOIN_STORAGE_DEPOSIT = 350_000_000_000_000_000_000_000n;

/** `JOIN_STORAGE_DEPOSIT` or any yoctoNEAR amount as a short NEAR text for messages, e.g. `0.01`. */
export function formatNear(yocto: bigint): string {
  const whole = yocto / 10n ** 24n;
  const fraction = (yocto % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
