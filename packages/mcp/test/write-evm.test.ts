// SD-088: X207_EVM_PRIVATE_KEY in the write configuration of the MCP server.
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { generateVoucherKeypair } from "@x207/core";
import { scrub, writeConfigFromEnv } from "../src/write-config.js";
import { availableWriteTools, type WriteRuntime } from "../src/write-tools.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // public hardhat test key
const ADDRESS = privateKeyToAccount(KEY).address.toLowerCase();
const base = { X207_MCP_WRITE: "1" };

describe("SD-088 X207_EVM_PRIVATE_KEY", () => {
  it("TC-SD-088-16 the member id is the lower-case address, and X207_AGENT_ACCOUNT may be left out", () => {
    const cfg = writeConfigFromEnv({ ...base, X207_EVM_PRIVATE_KEY: KEY });
    expect(cfg).toMatchObject({ account: ADDRESS, evmKey: KEY, voucherKey: null });
    expect(writeConfigFromEnv({ ...base, X207_EVM_PRIVATE_KEY: KEY, X207_AGENT_ACCOUNT: ADDRESS })?.account).toBe(ADDRESS);
  });

  it("TC-SD-088-17 a wrong account, a bad key or both key kinds stop the server, and the message holds no key", () => {
    expect(() => writeConfigFromEnv({ ...base, X207_EVM_PRIVATE_KEY: KEY, X207_AGENT_ACCOUNT: "agent.testnet" })).toThrow(/must be 0x/);
    expect(() => writeConfigFromEnv({ ...base, X207_EVM_PRIVATE_KEY: "0x1234" })).toThrow(/64 hex/);
    const both = () => writeConfigFromEnv({ ...base, X207_EVM_PRIVATE_KEY: KEY, X207_AGENT_VOUCHER_KEY: generateVoucherKeypair().secretKey });
    expect(both).toThrow(/not both/);
    for (const run of [() => writeConfigFromEnv({ ...base, X207_EVM_PRIVATE_KEY: "0x12zz" }), both]) {
      try { run(); } catch (error) { expect(String((error as Error).message)).not.toContain(KEY.slice(2, 20)); }
    }
  });

  it("TC-SD-088-18 only x207_pay_request is offered to an EVM agent, and scrub removes the key", () => {
    const cfg = writeConfigFromEnv({ ...base, X207_EVM_PRIVATE_KEY: KEY, X207_ALLOW_OUTFLOWS: "1" })!;
    const names = availableWriteTools({ cfg } as unknown as WriteRuntime, true).map((t) => t.name);
    expect(names).toEqual(["x207_pay_request"]);
    expect(scrub(`failed with ${KEY} here`, cfg)).toBe("failed with [key] here");
  });

  it("TC-SD-088-19 without the variable nothing changes", () => {
    const cfg = writeConfigFromEnv({ ...base, X207_AGENT_ACCOUNT: "agent.testnet" })!;
    expect(cfg.evmKey ?? null).toBeNull();
    expect(cfg.account).toBe("agent.testnet");
  });
});
