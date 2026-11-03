// Membaca variabel lingkungan buyer example; variabel yang hilang disebut namanya (TC-SD-035-03).
import type { AccountId, VoucherSecretKey } from "@x207/core";

export type BuyerEnv = {
  accountId: AccountId;
  secretKey: VoucherSecretKey;
  sellerUrl: string;
  rpcUrls?: string[];
};

export function readBuyerEnv(env: Record<string, string | undefined>): BuyerEnv {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`variable ${name} is required`);
    return value;
  };
  const secretKey = required("VOUCHER_SECRET_KEY");
  if (!secretKey.startsWith("ed25519:")) throw new Error("VOUCHER_SECRET_KEY must be ed25519:<base58>");
  const rpcUrls = env.NEAR_RPC_URLS?.split(",").map((u) => u.trim()).filter(Boolean);
  return {
    accountId: required("ACCOUNT_ID"),
    secretKey: secretKey as VoucherSecretKey,
    sellerUrl: required("SELLER_URL"),
    ...(rpcUrls?.length ? { rpcUrls } : {}),
  };
}
