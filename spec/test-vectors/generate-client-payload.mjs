// Membangkitkan vector payload klien (SD-018): dua voucher berurutan dari kunci kA ke satu penjual.
// Independen dari klien `@x207/scheme`: payload dirakit langsung dari `signVoucher` core.
// Jalankan setelah `npm run build`: node spec/test-vectors/generate-client-payload.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signVoucher } from "../../packages/core/dist/index.js";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const keys = JSON.parse(readFileSync(here("keys.json"), "utf8")).keys;
const seed = Buffer.from(keys.kA.seed, "hex");

const RESOURCE = "https://summarizer.example/api/summarize";
const accepted = {
  scheme: "batch-settlement",
  network: "x207:agents-main",
  amount: "20000",
  asset: "USD",
  payTo: "summarizer.x207-circle.near",
  maxTimeoutSeconds: 60,
  extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42 },
};
const unsigned = (seq, cumulativeAmount) => ({
  circle: "x207-circle.near",
  payer: "translator.x207-circle.near",
  payee: "summarizer.x207-circle.near",
  epoch: 42,
  seq,
  cumulativeAmount,
  unit: "credit",
  resource: RESOURCE,
});
const step = (seq, cumulativeAmount) => {
  const { signature, ...voucher } = signVoucher(unsigned(seq, cumulativeAmount), seed);
  // Urutan key = urutan yang dibangun `x402Client.createPaymentPayload`, supaya byte header sama.
  const paymentPayload = {
    x402Version: 2,
    payload: { voucher, signature },
    resource: { url: RESOURCE },
    accepted,
  };
  return { paymentPayload, header: Buffer.from(JSON.stringify(paymentPayload), "utf8").toString("base64") };
};

writeFileSync(
  here("payload/client_seq1_seq2.json"),
  `${JSON.stringify(
    {
      name: "client_seq1_seq2",
      description: "Client kA pays the same seller twice in epoch 42; empty state, then one commit. Price 20000 per call.",
      input: { key: "kA", requirements: accepted, resource: RESOURCE },
      expected: { seq1: step(1, "20000"), seq2: step(2, "40000") },
    },
    null,
    2,
  )}\n`,
);
