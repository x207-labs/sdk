// Minimal x207 buyer: one `@x402/fetch` wrapper and the x207 client (`x207:*` is already registered in it).
// The voucher is used while headroom is sufficient; beyond that the client falls back to the `exact` entry if the agent registered it.
import { wrapFetchWithPayment } from "@x402/fetch";
import type { AccountId, VoucherSecretKey } from "@x207/core";
import { X207PaymentClient, headroomFromRpc } from "@x207/scheme";

export type BuyerOptions = {
  /** NEAR account of the agent; an `active` member of the circle (see `onboardMember`). */
  accountId: AccountId;
  /** The agent's ed25519 voucher key (ADR-06), not a NEAR access key. */
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
