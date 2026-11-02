// Membangkitkan spec/test-vectors/barter/*.json (SD-047). Jalankan setelah `npm run build`: node spec/test-vectors/generate-barter.mjs
// Deterministik: kunci dari keys.json (kA translator, kB summarizer, kC scraper), tanpa waktu atau acak.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bundleSigningHash, intentHash, intentHashBase58, intentSigningHash, serializeBundleTerms, serializeIntent, signBundle,
  signIntent, termsHash, voucherPublicKey,
} from "../../packages/core/dist/index.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const keys = JSON.parse(readFileSync(here("keys.json"), "utf8")).keys;
const seed = (k) => Buffer.from(keys[k].seed, "hex");
const hex = (b) => Buffer.from(b).toString("hex");
const CIRCLE = "x207-circle.near";
const A = "translator.x207-circle.near";
const B = "summarizer.x207-circle.near";
const C = "scraper.x207-circle.near";
const out = here("barter/");
mkdirSync(out, { recursive: true });

const intent = {
  circle: CIRCLE, account: A,
  offer: { service: "translate", calls: 50, value: "1000000" },
  need: { service: "summarize", calls: 50, value: "1000000" },
  expiresAt: 1793600000, nonce: "n1",
};
writeFileSync(`${out}intent.json`, JSON.stringify({
  circle: CIRCLE, intent, message: serializeIntent(intent), intentHash: intentHash(intent), intentHashBase58: intentHashBase58(intent),
  signingHash: hex(intentSigningHash(intent)), pubkey: voucherPublicKey(seed("kA")), signature: signIntent(intent, seed("kA")),
}, null, 2) + "\n");

// A -> B -> C -> A: tiga leg melingkar (10, 8, 6 credit); legs sengaja tidak urut agar kanonikalisasi teruji.
const terms = {
  circle: CIRCLE, epoch: 42,
  legs: [
    { payer: C, payee: A, max_amount: "6000000" },
    { payer: A, payee: B, max_amount: "10000000" },
    { payer: B, payee: C, max_amount: "8000000" },
  ],
};
const participants = { [A]: "kA", [B]: "kB", [C]: "kC" };
writeFileSync(`${out}bundle_abca.json`, JSON.stringify({
  circle: CIRCLE, terms, message: serializeBundleTerms(terms), termsHash: termsHash(terms), signingHash: hex(bundleSigningHash(terms)),
  participants: Object.fromEntries(Object.entries(participants).map(([account, k]) => [account, voucherPublicKey(seed(k))])),
  signatures: Object.entries(participants).map(([account, k]) => signBundle(terms, account, seed(k))),
}, null, 2) + "\n");
console.log("barter vectors ditulis");
