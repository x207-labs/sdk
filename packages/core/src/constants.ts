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
