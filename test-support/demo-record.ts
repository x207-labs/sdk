// Catatan hash gladi testnet (UM-032, SD-034, SD-031): satu berkas JSON yang ditulis ulang setelah tiap langkah, jadi hash tersimpan
// sejak awal run walau run berhenti di tengah. Tidak pernah memuat kunci atau rahasia: hanya akun, metode, hash, dan teks pendek.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type DemoStep = {
  /** Bagian run: `sd-034-exact`, `sd-031-gaskey`, `network-demo`. */
  section: string;
  step: string;
  account?: string;
  method?: string;
  hash?: string;
  note?: string;
  at: string;
};
export type DemoRecord = { network: "testnet" | "mainnet"; accounts: Array<{ id: string; role: string }>; steps: DemoStep[] };

const SECRET_LIKE = /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}|"private_key"|"secret_key"/;

export function readDemoRecord(path: string): DemoRecord {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as DemoRecord) : { network: process.env.DEMO_NETWORK === "mainnet" ? "mainnet" : "testnet", accounts: [], steps: [] };
}

function write(path: string, record: DemoRecord): void {
  const text = JSON.stringify(record, null, 2);
  if (SECRET_LIKE.test(text)) throw new Error("catatan gladi memuat sesuatu yang mirip kunci; tidak ditulis");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${text}\n`);
  renameSync(`${path}.tmp`, path);
}

export function recordAccounts(path: string, accounts: Array<{ id: string; role: string }>): void {
  const record = readDemoRecord(path);
  for (const account of accounts) if (!record.accounts.some((a) => a.id === account.id)) record.accounts.push(account);
  write(path, record);
}

export function recordStep(path: string, step: Omit<DemoStep, "at">): void {
  const record = readDemoRecord(path);
  record.steps.push({ ...step, at: new Date().toISOString() });
  write(path, record);
}
