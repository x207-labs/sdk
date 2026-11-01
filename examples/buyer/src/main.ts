// Menjalankan satu panggilan berbayar: `ACCOUNT_ID=… VOUCHER_SECRET_KEY=… SELLER_URL=… npm run start -w @x207/example-buyer`.
import { createBuyerFetch } from "./buyer.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`variabel ${name} wajib diisi`);
  return value;
};

const secretKey = required("VOUCHER_SECRET_KEY");
if (!secretKey.startsWith("ed25519:")) throw new Error("VOUCHER_SECRET_KEY harus ed25519:<base58>");
const rpcUrls = process.env.NEAR_RPC_URLS?.split(",").map((u) => u.trim()).filter(Boolean);

const paidFetch = createBuyerFetch({
  accountId: required("ACCOUNT_ID"),
  secretKey: secretKey as `ed25519:${string}`,
  ...(rpcUrls?.length ? { rpcUrls } : {}),
});

const response = await paidFetch(required("SELLER_URL"));
console.log(response.status, await response.text());
const settled = response.headers.get("PAYMENT-RESPONSE");
if (settled) console.log("PAYMENT-RESPONSE", Buffer.from(settled, "base64").toString("utf8"));
