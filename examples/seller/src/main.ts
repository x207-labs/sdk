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
});
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`x207 seller on :${port}`));
