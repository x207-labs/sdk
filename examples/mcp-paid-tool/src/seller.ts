// SD-083 spike, seller side: one MCP tool that costs a voucher of x207. `createPaymentWrapper` of @x402/mcp 2.29.0 wraps the handler; the scheme is the x207 `batch-settlement`
// on the network `x207:<circleId>` (`X207SchemeServer` of @x207/scheme registered in the `x402ResourceServer`); verify and settle go to the reference facilitator over HTTP.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { X207_SCHEME, X207SchemeServer } from "@x207/scheme";
import type { AccountId } from "@x207/core";
import { z } from "zod";

export type PaidToolServerOptions = {
  /** URL of the facilitator (`/verify`, `/settle`, `/supported`). */
  facilitatorUrl: string;
  /** Circle id, e.g. `agents-main` (network `x207:agents-main`). */
  circleId: string;
  /** NEAR account of the seller that receives the voucher. */
  payTo: AccountId;
  /** Price of one call, e.g. `"$0.02"` (one USD = one credit). */
  price?: string;
  /** Called once for each call that was paid and run, so a test can see that the tool ran only after the payment. */
  onRun?: (args: { text: string }) => void;
};

export async function createPaidToolServer(options: PaidToolServerOptions): Promise<McpServer> {
  const network = `x207:${options.circleId}` as `${string}:${string}`;
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: options.facilitatorUrl }));
  // X207SchemeServer is built on @x402/core 2.28 (the pin of the SDK), the resource server on 2.29 (the peer of @x402/mcp): the interface is the same, the classes are two copies
  resourceServer.register(network, new X207SchemeServer() as never);
  await resourceServer.initialize();
  const accepts = await resourceServer.buildPaymentRequirements({ scheme: X207_SCHEME, network, payTo: options.payTo, price: options.price ?? "$0.02" });
  const paid = createPaymentWrapper(resourceServer, { accepts });

  const server = new McpServer({ name: "x207-paid-tool", version: "0.0.1" });
  server.tool("ping", "Free health check", {}, async () => ({ content: [{ type: "text" as const, text: "pong" }] }));
  server.tool(
    "summarize",
    "Summarize a text. Costs one voucher of x207.",
    { text: z.string() },
    paid(async (args: { text: string }) => {
      options.onRun?.(args);
      return { content: [{ type: "text" as const, text: `summary: ${args.text.slice(0, 24)}` }] };
    }),
  );
  return server;
}
