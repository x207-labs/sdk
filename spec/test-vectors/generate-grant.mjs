// Membangkitkan spec/test-vectors/grant/voucher_grant.json (SD-053): voucher yang membayar grant F8. Jalankan setelah `npm run build`:
//   node spec/test-vectors/generate-grant.mjs
// Deterministik (kunci dari keys.json). `payTo` = pemberi grant (bukan akun broker), `extra.grantId` di requirements, `resource` voucher = `x207:grant:<grantId>`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { grantResource, serializeVoucherMessage, signVoucher, voucherPublicKey } from "../../packages/core/dist/index.js";

const file = (path) => fileURLToPath(new URL(path, import.meta.url));
const keys = JSON.parse(readFileSync(file("keys.json"), "utf8")).keys;
const seed = (k) => Buffer.from(keys[k].seed, "hex");
const CIRCLE = "x207-circle.near";
const GRANTEE = "translator.x207-circle.near";
const GRANTOR = "summarizer.x207-circle.near";
const BROKER = "broker.x207-circle.near";
const GRANT_ID = 7;
const requirements = (payTo) => ({
  scheme: "batch-settlement", network: "x207:agents-main", amount: "250000", asset: "USD", payTo, maxTimeoutSeconds: 60,
  extra: { circleContract: CIRCLE, unit: "credit", decimals: 6, epoch: 42, grantId: GRANT_ID },
});
const unsigned = (payee, resource) => ({
  circle: CIRCLE, payer: GRANTEE, payee, epoch: 42, seq: 1, cumulativeAmount: "250000", unit: "credit", resource,
});
const voucherOf = (payee, resource) => signVoucher(unsigned(payee, resource), seed("kA"));
const valid = voucherOf(GRANTOR, grantResource(GRANT_ID));
const out = file("grant/voucher_grant.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({
  name: "voucher_grant",
  description: "Endpoint grant F8 (SD-053): payTo = pemberi grant, extra.grantId, resource voucher = x207:grant:<grantId>. Kasus lain: payee akun broker dan resource URL.",
  input: { publicKey: voucherPublicKey(seed("kA")), requirements: requirements(GRANTOR), voucher: valid },
  expected: { valid: true, resource: grantResource(GRANT_ID), message: serializeVoucherMessage(unsigned(GRANTOR, grantResource(GRANT_ID))) },
  cases: [
    {
      name: "payee_broker", description: "Voucher ber-payee akun broker sementara requirements.payTo = pemberi grant",
      requirements: requirements(GRANTOR), voucher: voucherOf(BROKER, grantResource(GRANT_ID)), facilitatorReason: "payee_mismatch",
    },
    {
      name: "resource_url", description: "Voucher ber-resource URL broker, bukan x207:grant:<grantId>",
      requirements: requirements(GRANTOR), voucher: voucherOf(GRANTOR, "https://broker.example/grants/7/lease"), facilitatorReason: "grant_resource_mismatch",
    },
    {
      name: "resource_other_grant", description: "Voucher untuk grant lain (x207:grant:8)",
      requirements: requirements(GRANTOR), voucher: voucherOf(GRANTOR, grantResource(8)), facilitatorReason: "grant_resource_mismatch",
    },
  ],
}, null, 2)}\n`);
console.log("grant vector ditulis");
