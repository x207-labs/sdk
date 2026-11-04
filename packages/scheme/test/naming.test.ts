import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { X207_NETWORK_FAMILY, X207_SCHEME } from "@x207/scheme";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "test") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|md)$/.test(name)) yield path;
  }
}

describe("SD-041 public naming", () => {
  it("scheme and network use the brand name, not the internal name", () => {
    expect(X207_SCHEME).toBe("batch-settlement");
    expect(X207_NETWORK_FAMILY).toBe("x207:*");
  });

  it("mutual-credit is not used as a scheme or network name in the README, spec, docs and public API", () => {
    const files = [join(root, "README.md"), ...sources(join(root, "spec")), ...sources(join(root, "docs")), ...sources(join(root, "packages/scheme"))];
    const offenders: string[] = [];
    for (const file of files) {
      for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
        if (!/mutual-credit/i.test(line)) continue;
        // The only legitimate mention is the rule that forbids it (spec section on internal names).
        if (!/MUST NOT|nama internal/i.test(line)) offenders.push(`${file.slice(root.length)}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
