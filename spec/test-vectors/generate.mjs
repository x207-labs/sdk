// Membangkitkan berkas vector voucher (SD-006) dari implementasi `@x207/core`.
// Jalankan setelah `npm run build`: node spec/test-vectors/generate.mjs
// Hasil deterministik (seed tetap, ed25519 RFC 8032), jadi diff kosong bila format tidak berubah.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  serializeVoucherMessage,
  signVoucher,
  voucherNonce,
  voucherPayload,
  voucherPublicKey,
  voucherSigningHash,
} from "../../packages/core/dist/index.js";

const out = (path) => fileURLToPath(new URL(path, import.meta.url));
const write = (path, value) => {
  mkdirSync(dirname(out(path)), { recursive: true });
  writeFileSync(out(path), `${JSON.stringify(value, null, 2)}\n`);
};
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const seed = (byte) => new Uint8Array(32).fill(byte);

const SEEDS = { kA: 0x01, kB: 0x02, kC: 0x03, kD: 0x04, kOther: 0x05, kZ: 0x0f };
const keys = Object.fromEntries(
  Object.entries(SEEDS).map(([name, byte]) => [
    name,
    { seed: hex(seed(byte)), publicKey: voucherPublicKey(seed(byte)) },
  ]),
);
write("keys.json", {
  name: "keys",
  description: "Seed ed25519 32 byte: 0x01 kA (translator), 0x02 kB, 0x03 kC, 0x04 kD, 0x05 kunci S/P/X/L, 0x0f kZ (penyerang, tidak terdaftar).",
  keys,
});

const UNSIGNED = {
  circle: "x207-circle.near",
  payer: "translator.x207-circle.near",
  payee: "summarizer.x207-circle.near",
  epoch: 42,
  seq: 137,
  cumulativeAmount: "2740000",
  unit: "credit",
  resource: "https://summarizer.example/api/summarize",
};
const signed = signVoucher(UNSIGNED, seed(0x01));
const publicKey = keys.kA.publicKey;

const bytes = (voucher) => {
  const { signature: _signature, ...unsigned } = voucher;
  return {
    message: serializeVoucherMessage(unsigned),
    nonce: hex(voucherNonce(unsigned)),
    payload: hex(voucherPayload(unsigned)),
    signingHash: hex(voucherSigningHash(unsigned)),
  };
};

write("voucher/valid.json", {
  name: "valid",
  input: { voucher: signed, publicKey },
  expected: { valid: true, ...bytes(signed) },
});

const TAMPERED = {
  circle: "evil-circle.near",
  payer: "scraper.x207-circle.near",
  payee: "scraper.x207-circle.near",
  epoch: 43,
  seq: 138,
  cumulativeAmount: "2740001",
  unit: "usd",
  resource: "https://summarizer.example/api/other",
};
for (const [field, value] of Object.entries(TAMPERED)) {
  write(`voucher/tampered_${field}.json`, {
    name: `tampered_${field}`,
    input: { voucher: { ...signed, [field]: value }, publicKey },
    expected: { valid: false, contractError: "ERR_BAD_SIGNATURE", facilitatorReason: "invalid_signature" },
  });
}

const sigChars = signed.signature.slice(8);
const flipped = `${sigChars.slice(0, 10)}${sigChars[10] === "2" ? "3" : "2"}${sigChars.slice(11)}`;
write("voucher/bad_signature.json", {
  name: "bad_signature",
  input: { voucher: { ...signed, signature: `ed25519:${flipped}` }, publicKey },
  expected: { valid: false, contractError: "ERR_BAD_SIGNATURE", facilitatorReason: "invalid_signature" },
});

const CUTOFF_AT_MS = 1_793_500_000_000;
const seqCase = (name, seq, lastSeq) => {
  const voucher = signVoucher({ ...UNSIGNED, seq }, seed(0x01));
  write(`voucher/${name}.json`, {
    name,
    input: { voucher, publicKey, context: { lastSeq } },
    expected: {
      valid: true,
      accepted: false,
      contractError: "ERR_SEQ_NOT_INCREASING",
      facilitatorReason: "seq_not_increasing",
    },
  });
};
seqCase("seq_stale", 137, 137);
seqCase("seq_backwards", 136, 137);

write("voucher/past_cutoff.json", {
  name: "past_cutoff",
  description: "epoch belum di-close_epoch: get_epoch tanpa argumen masih epoch 42 fase cutoff (K-28).",
  input: {
    voucher: signed,
    publicKey,
    context: { cutoffAtMs: CUTOFF_AT_MS, nowMs: CUTOFF_AT_MS + 1000, epochClosed: false, flushLeadSeconds: 120 },
  },
  expected: {
    valid: true,
    accepted: false,
    contractError: "ERR_PAST_CUTOFF",
    facilitatorReason: "epoch_closing",
  },
});

const REQ = {
  scheme: "batch-settlement",
  network: "x207:agents-main",
  amount: "20000",
  asset: "USD",
  payTo: "summarizer.x207-circle.near",
  maxTimeoutSeconds: 60,
  extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42 },
};
const payload = {
  x402Version: 2,
  resource: { url: UNSIGNED.resource },
  accepted: REQ,
  payload: { voucher: UNSIGNED, signature: signed.signature },
};
write("payload/payment_signature_agents_main.json", {
  name: "payment_signature_agents_main",
  input: { paymentPayload: payload },
  expected: { header: Buffer.from(JSON.stringify(payload), "utf8").toString("base64") },
});

write("schema.json", {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "x207 test vector",
  type: "object",
  required: ["name", "input", "expected"],
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    input: { type: "object" },
    expected: { type: "object" },
  },
});
