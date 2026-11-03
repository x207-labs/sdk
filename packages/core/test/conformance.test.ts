// SD-058: la suite conformance lulus untuk implementasi referensi dan gagal keras untuk implementasi yang salah atau diam.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCases } from "../../../conformance/cases.mjs";

const runner = fileURLToPath(new URL("../../../conformance/run.mjs", import.meta.url));
const run = (cmd?: string) => spawnSync("node", [runner, ...(cmd ? ["--cmd", cmd] : [])], { encoding: "utf8", timeout: 60_000 });

describe("SD-058 conformance suite", () => {
  it("TC-SD-058-01 the reference implementation passes every case with one command", () => {
    const result = run();
    const total = loadCases().length;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`conformance: ${total}/${total} passed`);
    expect(total).toBeGreaterThanOrEqual(45);
  });

  it("TC-SD-058-02 the cases cover voucher, intent, bundle, listing, offer, and quick barter", () => {
    const ops = new Set(loadCases().map((c) => c.op.split(".")[0]));
    expect(ops).toEqual(new Set(["voucher", "intent", "bundle", "listing", "offer", "referral", "quick"]));
  });

  it("TC-SD-058-03 an adapter that always answers wrong fails and names the case", () => {
    const wrong = `node -e "require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);console.log(JSON.stringify({id:r.id,output:'x'}))})"`;
    const result = run(wrong);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/FAIL voucher\/valid\/message \(voucher\.message\)/);
    expect(result.stdout).toMatch(/conformance: \d+\/\d+ passed/);
  });

  it("TC-SD-058-04 an adapter that stays silent or returns an error fails", () => {
    const silent = run(`node -e "process.stdin.resume()"`);
    expect(silent.status).toBe(1);
    expect(silent.stdout).toContain("no answer");
    const failing = run(`node -e "require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);console.log(JSON.stringify({id:r.id,error:'not implemented'}))})"`);
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("error: not implemented");
  });

  it("TC-SD-058-05 an adapter that is only partly right fails: one wrong case is enough", () => {
    // Jawaban adapter referensi, kecuali satu kasus yang diubah
    const dir = mkdtempSync(join(tmpdir(), "x207-conformance-"));
    const file = join(dir, "partial.mjs");
    const reference = fileURLToPath(new URL("../../../conformance/reference.mjs", import.meta.url));
    writeFileSync(
      file,
      `import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const ref = spawn("node", [${JSON.stringify(reference)}]);
process.stdin.pipe(ref.stdin);
createInterface({ input: ref.stdout }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.id === "quick/pay") r.output.counterpartyPays = "1";
  console.log(JSON.stringify(r));
});
`,
    );
    try {
      const result = run(`node ${JSON.stringify(file)}`);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("FAIL quick/pay");
      expect(result.stdout).not.toContain("FAIL voucher");
      expect(result.stdout).toMatch(/conformance: \d+\/\d+ passed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
