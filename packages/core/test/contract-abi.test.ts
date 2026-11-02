import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ContractAbi,
  type EpochPhase,
  type MemberStatus,
  type SettlementStatus,
  type UnsignedVoucher,
} from "@x207/core";
import { GENERATED_PATH, PINNED_ABI_PATH, generate } from "../scripts/generate-contract-types.mjs";

const pinnedText = readFileSync(PINNED_ABI_PATH, "utf8");
const pinned = JSON.parse(pinnedText) as {
  interface_version: string;
  body: { functions: { name: string; kind: string }[] };
  events: { name: string; fields: string[] }[];
};
const CONTRACTS_REPO = fileURLToPath(new URL("../../../../contracts/", import.meta.url));
// Monorepo lokal saja: di CI `sdk` repo `contracts` tidak ada, jadi pembandingan dilewati.
const committedContractsAbi = (): string | null => {
  try {
    return execFileSync("git", ["-C", CONTRACTS_REPO, "show", "HEAD:abi.json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};
const contractsAbi = existsSync(CONTRACTS_REPO) ? committedContractsAbi() : null;

describe("SD-010 tipe client kontrak dari abi.json", () => {
  it("versi ABI yang dipin tertulis di sdk", () => {
    expect(ContractAbi.X207_CIRCLE_ABI_VERSION).toBe(pinned.interface_version);
    expect(ContractAbi.X207_CIRCLE_ABI_VERSION).toBe("0.0.4");
    expect(ContractAbi.X207_CIRCLE_ABI_SHA256).toBe(createHash("sha256").update(pinnedText).digest("hex"));
  });

  it("types.generated.ts sama dengan hasil generator dari ABI yang dipin", () => {
    expect(readFileSync(GENERATED_PATH, "utf8")).toBe(generate(pinnedText));
  });

  it("daftar method dan event sama dengan ABI", () => {
    const names = (kind: string) => pinned.body.functions.filter((f) => f.kind === kind).map((f) => f.name);
    expect([...ContractAbi.CIRCLE_VIEW_METHODS]).toEqual(names("view"));
    expect([...ContractAbi.CIRCLE_CALL_METHODS]).toEqual(names("call"));
    expect(Object.keys(ContractAbi.CIRCLE_EVENTS)).toEqual(pinned.events.map((e) => e.name));
    for (const event of pinned.events) {
      expect([...ContractAbi.CIRCLE_EVENTS[event.name as ContractAbi.CircleEventName]]).toEqual(event.fields);
    }
  });

  it("mengganti nama method di ABI mengubah hasil generator (CI merah)", () => {
    const renamed = pinnedText.replace('"name": "member"', '"name": "member_x"');
    expect(renamed).not.toBe(pinnedText);
    expect(generate(renamed)).not.toBe(readFileSync(GENERATED_PATH, "utf8"));
  });

  it("konstruk schema tak dikenal melempar error", () => {
    const odd = pinnedText.replace('"type": "boolean"', '"type": "number"');
    expect(odd).not.toBe(pinnedText);
    expect(() => generate(odd)).toThrow(/type tidak dikenal/);
  });

  it.skipIf(contractsAbi === null)("pin sama dengan abi.json yang ter-commit di repo contracts lokal", () => {
    // Isi sama; urutan key boleh beda (contracts menulis key terurut).
    expect(JSON.parse(contractsAbi as string)).toEqual(pinned);
  });

  it("tipe @x207/core cocok dengan tipe ABI (diperiksa saat typecheck)", () => {
    const voucher: ContractAbi.Voucher = {} as UnsignedVoucher;
    const phaseA: ContractAbi.EpochPhaseView = "" as EpochPhase;
    const phaseB: EpochPhase = "" as ContractAbi.EpochPhaseView;
    const statusA: ContractAbi.MemberStatus = "" as MemberStatus;
    const statusB: MemberStatus = "" as ContractAbi.MemberStatus;
    const position: ContractAbi.PositionStatus = "" as SettlementStatus;
    const settlement: SettlementStatus = "" as ContractAbi.PositionStatus;
    const args: ContractAbi.CircleViews["member"]["args"] = { account_id: "a.near" };
    const call: ContractAbi.CircleCalls["join"]["args"] = {
      circle_id: "agents-main",
      pubkey_voucher: "ed25519:x",
      terms_hash: "0".repeat(64),
    };
    // @ts-expect-error method yang tidak ada di ABI
    type Missing = ContractAbi.CircleViews["membr"];
    expect([voucher, phaseA, phaseB, statusA, statusB, position, settlement, args, call]).toHaveLength(9);
  });
});
