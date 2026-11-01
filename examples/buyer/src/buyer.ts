// Pembeli x207 minimal: satu wrapper `@x402/fetch` dan klien x207 (`x207:*` sudah terdaftar di dalamnya).
// Voucher dipakai selama headroom cukup; selebihnya klien jatuh ke entri `exact` bila agent mendaftarkannya.
import { wrapFetchWithPayment } from "@x402/fetch";
import type { AccountId, VoucherSecretKey } from "@x207/core";
import { X207PaymentClient, headroomFromRpc } from "@x207/scheme";

export type BuyerOptions = {
  /** Akun NEAR agent; anggota `active` lingkaran (lihat `onboardMember`). */
  accountId: AccountId;
  /** Kunci voucher ed25519 agent (ADR-06), bukan access key NEAR. */
  secretKey: VoucherSecretKey;
  rpcUrls?: readonly string[];
  fetch?: typeof fetch;
};

export function createBuyerFetch(options: BuyerOptions): typeof fetch {
  const client = new X207PaymentClient({
    payer: options.accountId,
    secretKey: options.secretKey,
    headroom: headroomFromRpc({
      ...(options.rpcUrls ? { rpcUrls: options.rpcUrls } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
  return wrapFetchWithPayment(options.fetch ?? fetch, client);
}
