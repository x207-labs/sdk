// Testnet rehearsal hash record (UM-032, SD-034, SD-031): one JSON file rewritten after each step, so hashes are saved
// from the start of the run even if the run stops midway. Never holds keys or secrets: only accounts, methods, hashes, and short text.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type DemoStep = {
  /** Part of the run: `sd-034-exact`, `sd-031-gaskey`, `network-demo`. */
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
  if (SECRET_LIKE.test(text)) throw new Error("the rehearsal note contains something that looks like a key; not written");
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
