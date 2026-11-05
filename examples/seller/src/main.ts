// Runs the seller: `FACILITATOR_URL=… CIRCLE_ID=… PAY_TO=… npm run start -w @x207/example-seller`.
import { serve } from "@hono/node-server";
import { createSeller } from "./seller.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`variable ${name} is required`);
  return value;
};

const app = createSeller({
  facilitatorUrl: required("FACILITATOR_URL"),
  circleId: required("CIRCLE_ID"),
  payTo: required("PAY_TO"),
  // optional: BASE_SEPOLIA_PAY_TO=0x… adds `exact` on Base Sepolia (USDC testnet); BASE_SEPOLIA_FACILITATOR_URL overrides the public testnet facilitator
  ...(process.env.BASE_SEPOLIA_PAY_TO
    ? {
        baseSepolia: {
          payTo: process.env.BASE_SEPOLIA_PAY_TO,
          ...(process.env.BASE_SEPOLIA_FACILITATOR_URL ? { facilitatorUrl: process.env.BASE_SEPOLIA_FACILITATOR_URL } : {}),
        },
      }
    : {}),
});
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`x207 seller on :${port}`));
