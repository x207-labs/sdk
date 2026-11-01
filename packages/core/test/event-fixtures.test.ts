import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isKnownX207Event, parseEventLog } from "@x207/core";

const dir = fileURLToPath(new URL("../../../spec/test-vectors/events/sandbox/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".log"));

describe("SD-011 fixture log nyata dari near-sandbox", () => {
  it("TC-SD-011-17 log kontrak asli untuk event siklus hidup ter-parse tanpa error", () => {
    for (const expected of [
      "member_joined", "stake_added", "voucher_registered", "epoch_cutoff", "clearing_submitted", "clearing_applied",
      "epoch_committed", "limits_updated", "residual_paid", "epoch_finalized", "residual_claimed",
    ]) {
      expect(files, expected).toContain(`${expected}.log`);
    }
    for (const file of files) {
      const events = parseEventLog(readFileSync(`${dir}${file}`, "utf8").trim());
      expect(events, file).not.toBeNull();
      expect(events!.length, file).toBeGreaterThan(0);
      for (const event of events!) {
        expect(isKnownX207Event(event), `${file}: ${event.event}`).toBe(true);
        expect(event.event).toBe(file.replace(/\.log$/, ""));
      }
    }
  });

  it("clearing_applied hanya memuat edge dengan cleared > 0 (ADR-31b)", () => {
    const [applied] = parseEventLog(readFileSync(`${dir}clearing_applied.log`, "utf8").trim())!;
    const edges = (applied as unknown as { edges: Array<{ cleared: string }> }).edges;
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => BigInt(e.cleared) > 0n)).toBe(true);
  });
});
