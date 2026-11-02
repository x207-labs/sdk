#!/usr/bin/env node
// Runner conformance x207 (SD-058). Satu perintah dari akar sdk:
//   npm run conformance                         (adapter referensi @x207/core)
//   npm run conformance -- --cmd "python3 impl.py"   (implementasi lain; protokol NDJSON di conformance/README.md)
// Keluar 0 bila semua kasus lulus, 1 bila ada yang gagal atau adapter tidak menjawab.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadCases } from "./cases.mjs";

const reference = fileURLToPath(new URL("./reference.mjs", import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf("--cmd");
const command = at >= 0 ? args[at + 1] : `node ${JSON.stringify(reference)}`;
if (!command) {
  console.error("--cmd butuh perintah");
  process.exit(2);
}
const TIMEOUT_MS = 30_000;

const cases = loadCases();
const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
const answers = new Map();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const answer = JSON.parse(line);
    answers.set(answer.id, answer);
  } catch {
    // baris yang bukan JSON diabaikan
  }
});
const closed = new Promise((resolve) => child.on("close", resolve));
for (const c of cases) child.stdin.write(`${JSON.stringify({ id: c.id, op: c.op, input: c.input })}\n`);
child.stdin.end();
const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
await closed;
clearTimeout(timer);

const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}

let failed = 0;
for (const c of cases) {
  const answer = answers.get(c.id);
  const ok = answer && !("error" in answer) && same(answer.output, c.expected);
  if (!ok) {
    failed += 1;
    const got = !answer ? "no answer" : "error" in answer ? `error: ${answer.error}` : JSON.stringify(answer.output);
    console.log(`FAIL ${c.id} (${c.op}): expected ${JSON.stringify(c.expected)}, got ${got}`);
  }
}
console.log(`conformance: ${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
