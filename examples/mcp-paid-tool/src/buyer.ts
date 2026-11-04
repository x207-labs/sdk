// SD-083 spike, buyer side: `createx402MCPClient` of @x402/mcp 2.29.0 with the x207 scheme client registered for `x207:<circleId>`. The voucher is signed with the ed25519 voucher key of the
// agent (ADR-06), not with a NEAR access key; a call that costs money is paid automatically after the server answers 402.
import { createx402MCPClient } from "@x402/mcp";
import { X207SchemeClient } from "@x207/scheme";
import type { AccountId, VoucherSecretKey } from "@x207/core";

export type PayingMcpClientOptions = {
  accountId: AccountId;
  secretKey: VoucherSecretKey;
  circleId: string;
  /** Human in the loop: return false to refuse a payment. Default: pay. */
  onPaymentRequested?: (amount: string, payTo: string) => boolean;
};

export function createPayingMcpClient(options: PayingMcpClientOptions) {
  return createx402MCPClient({
    name: "x207-paying-agent",
    version: "0.0.1",
    schemes: [{ network: `x207:${options.circleId}`, client: new X207SchemeClient({ payer: options.accountId, secretKey: options.secretKey }) as never }],
    autoPayment: true,
    onPaymentRequested: async ({ paymentRequired }) => {
      const first = paymentRequired.accepts[0];
      return options.onPaymentRequested?.(first?.amount ?? "0", first?.payTo ?? "") ?? true;
    },
  });
}
