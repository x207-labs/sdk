import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREDIT_DECIMALS,
  CREDIT_UNIT,
  INTENTS_ID,
  NEAR_AI_CLOUD_URL,
  ONE_CLICK_API_URL,
  RPC_URLS,
  SPUTNIK_DAO_FACTORY,
  USDT_TOKEN_ID,
} from "@x207/core";

const SDK_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONSTANTS_MODULE = join("packages", "core", "src", "constants.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", "dist", "test"].includes(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe("SD-003 konstanta @x207/core", () => {
  it("TC-SD-003-01 desimal credit", () => {
    expect(CREDIT_DECIMALS).toBe(6);
    expect(10 ** CREDIT_DECIMALS).toBe(1_000_000);
  });

  it("TC-SD-003-02 unit credit", () => {
    expect(CREDIT_UNIT).toBe("credit");
  });

  it("TC-SD-003-03 akun kontrak eksternal", () => {
    expect(USDT_TOKEN_ID).toBe("usdt.tether-token.near");
    expect(INTENTS_ID).toBe("intents.near");
    expect(SPUTNIK_DAO_FACTORY).toBe("sputnik-dao.near");
  });

  it("TC-SD-003-04 RPC utama lalu cadangan", () => {
    expect([...RPC_URLS]).toEqual([
      "https://rpc.mainnet.fastnear.com",
      "https://rpc.mainnet.near.org",
    ]);
  });

  it("TC-SD-003-05 endpoint layanan", () => {
    expect(ONE_CLICK_API_URL).toBe("https://1click.chaindefuser.com");
    expect(NEAR_AI_CLOUD_URL).toBe("https://cloud-api.near.ai/v1");
  });

  it("TC-SD-003-06 satu sumber definisi", () => {
    const literals = ["usdt.tether-token.near", "intents.near", "rpc.mainnet.fastnear.com"];
    const roots = ["packages", "apps"].map((dir) => join(SDK_ROOT, dir));
    const hits = roots
      .flatMap(sourceFiles)
      .map((file) => relative(SDK_ROOT, file))
      .filter((file) => {
        const text = readFileSync(join(SDK_ROOT, file), "utf8");
        return literals.some((literal) => text.includes(literal));
      });
    expect(hits.map((file) => file.split(sep).join("/"))).toEqual([
      CONSTANTS_MODULE.split(sep).join("/"),
    ]);
  });

  it("TC-SD-003-07 konstanta di test vector", () => {
    const vector = JSON.parse(
      readFileSync(join(SDK_ROOT, "spec", "test-vectors", "constants.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(vector).toEqual({
      CREDIT_DECIMALS,
      CREDIT_UNIT,
      USDT_TOKEN_ID,
      INTENTS_ID,
      SPUTNIK_DAO_FACTORY,
      RPC_URLS: [...RPC_URLS],
      ONE_CLICK_API_URL,
      NEAR_AI_CLOUD_URL,
    });
    expect(vector.CREDIT_DECIMALS).toBe(6);
  });
});
