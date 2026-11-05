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
// Local monorepo only: in CI the `sdk` repo has no `contracts` repo, so the comparison is skipped.
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

describe("SD-010 contract client types from abi.json", () => {
  it("the pinned ABI version is written in the sdk", () => {
    expect(ContractAbi.X207_CIRCLE_ABI_VERSION).toBe(pinned.interface_version);
    expect(ContractAbi.X207_CIRCLE_ABI_VERSION).toBe("0.0.16"); // SD-101: pinned to contracts 0.0.16 (max_fee on claim_evm and withdraw_stake_evm, relayer_fee, relayer_fee_paid / relayer_fee_failed); the 8-field Action of 0.0.14 and 0.0.15 is still signed without maxFee
    expect(ContractAbi.X207_CIRCLE_ABI_SHA256).toBe(createHash("sha256").update(pinnedText).digest("hex"));
  });

  it("types.generated.ts equals the generator output for the pinned ABI", () => {
    expect(readFileSync(GENERATED_PATH, "utf8")).toBe(generate(pinnedText));
  });

  it("the method and event lists equal the ABI", () => {
    const names = (kind: string) => pinned.body.functions.filter((f) => f.kind === kind).map((f) => f.name);
    expect([...ContractAbi.CIRCLE_VIEW_METHODS]).toEqual(names("view"));
    expect([...ContractAbi.CIRCLE_CALL_METHODS]).toEqual(names("call"));
    expect(Object.keys(ContractAbi.CIRCLE_EVENTS)).toEqual(pinned.events.map((e) => e.name));
    for (const event of pinned.events) {
      expect([...ContractAbi.CIRCLE_EVENTS[event.name as ContractAbi.CircleEventName]]).toEqual(event.fields);
    }
  });

  it("renaming a method in the ABI changes the generator output (CI red)", () => {
    const renamed = pinnedText.replace('"name": "member"', '"name": "member_x"');
    expect(renamed).not.toBe(pinnedText);
    expect(generate(renamed)).not.toBe(readFileSync(GENERATED_PATH, "utf8"));
  });

  it("an unknown schema construct throws an error", () => {
    const odd = pinnedText.replace('"type": "boolean"', '"type": "number"');
    expect(odd).not.toBe(pinnedText);
    expect(() => generate(odd)).toThrow(/unknown type/);
  });

  it.skipIf(contractsAbi === null)("the pin equals the abi.json committed in the local contracts repo", () => {
    // Same content; key order may differ (contracts writes sorted keys).
    expect(JSON.parse(contractsAbi as string)).toEqual(pinned);
  });

  it("the @x207/core types match the ABI types (checked at typecheck)", () => {
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
    // @ts-expect-error method that is not in the ABI
    type Missing = ContractAbi.CircleViews["membr"];
    expect([voucher, phaseA, phaseB, statusA, statusB, position, settlement, args, call]).toHaveLength(9);
  });
});
