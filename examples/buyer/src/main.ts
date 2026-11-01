// Menjalankan satu panggilan berbayar: `ACCOUNT_ID=… VOUCHER_SECRET_KEY=… SELLER_URL=… npm run start -w @x207/example-buyer`.
import { createBuyerFetch } from "./buyer.js";
import { readBuyerEnv } from "./env.js";

const env = readBuyerEnv(process.env);
const paidFetch = createBuyerFetch({
  accountId: env.accountId,
  secretKey: env.secretKey,
  ...(env.rpcUrls ? { rpcUrls: env.rpcUrls } : {}),
});

const response = await paidFetch(env.sellerUrl);
console.log(response.status, await response.text());
const settled = response.headers.get("PAYMENT-RESPONSE");
if (settled) console.log("PAYMENT-RESPONSE", Buffer.from(settled, "base64").toString("utf8"));
