// SD-088: facilitator verify and the scheme client with an EVM agent (member id = `0x` address, `eip712:` signature).
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { signVoucher, type ContractAbi, type UnsignedVoucher } from "@x207/core";
import { evmSigner } from "@x207/core/evm";
import { X207SchemeClient, X207SchemeFacilitator, type VerifyChain } from "@x207/scheme";

const CIRCLE = "x207-v014.testnet";
const NETWORK = "x207:agents-main";
const NOW = 1_793_836_800_000;
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const EVM = account.address.toLowerCase();
const OTHER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const PAYEE = "gpu.testnet";
const PLACEHOLDER_KEY = "ed25519:11111111111111111111111111111111";

const member = (id: string, pubkey = PLACEHOLDER_KEY): ContractAbi.MemberView => ({
  account_id: id, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 1, limit: "100000", pubkey_voucher: pubkey,
  settled_history: "0", stake: "100000", status: "active", terms_hash: "0".repeat(64),
}) as ContractAbi.MemberView;

const chain: VerifyChain = {
  member: async (id) => (id === EVM || id === PAYEE ? member(id) : null),
  getEpoch: async () => ({ epoch: 3, cutoff_at: String(BigInt(NOW + 3_600_000) * 1_000_000n), opened_at: "0", phase: "open", edge_count: 0, participant_count: 0, pool: "0", params: {} }) as unknown as ContractAbi.EpochView,
  headroom: async () => "1000000",
  obligation: async () => null,
  pendingByPayer: async () => [],
};
const facilitator = new X207SchemeFacilitator({ network: NETWORK, circleContract: CIRCLE, verify: { chain, now: () => NOW } });

const requirements = { scheme: "batch-settlement", network: NETWORK, amount: "20000", asset: "USD", payTo: PAYEE, maxTimeoutSeconds: 60, extra: { circleContract: CIRCLE, unit: "credit", decimals: 6, epoch: 3 } };
const unsigned: UnsignedVoucher = { circle: CIRCLE, payer: EVM, payee: PAYEE, epoch: 3, seq: 1, cumulativeAmount: "20000", unit: "credit", resource: "https://api.example/translate" };
const payloadOf = (voucher: UnsignedVoucher, signature: string) => ({ x402Version: 2, resource: { url: voucher.resource }, accepted: requirements, payload: { voucher, signature } }) as any;

describe("SD-088 EVM agent through verify and the client", () => {
  it("TC-SD-088-11 verify accepts an eip712 voucher of an EVM member", async () => {
    const { signature } = await evmSigner(account).signVoucher(unsigned);
    expect(await facilitator.verify(payloadOf(unsigned, signature), requirements as any)).toEqual({ isValid: true, payer: EVM });
  });

  it("TC-SD-088-12 verify refuses a voucher signed by another key, or changed after signing", async () => {
    const other = await evmSigner(OTHER).signVoucher({ ...unsigned, payer: OTHER.address.toLowerCase() });
    expect(await facilitator.verify(payloadOf(unsigned, other.signature), requirements as any)).toMatchObject({ isValid: false, invalidReason: "invalid_signature" });
    const { signature } = await evmSigner(account).signVoucher(unsigned);
    const changed = { ...unsigned, cumulativeAmount: "30000" };
    const reqs30 = { ...requirements, amount: "30000" };
    const payload = { ...payloadOf(changed, signature), accepted: reqs30 };
    expect(await facilitator.verify(payload, reqs30 as any)).toMatchObject({ invalidReason: "invalid_signature" });
  });

  it("TC-SD-088-13 an ed25519 signature for an EVM member does not pass (placeholder key)", async () => {
    const forged = signVoucher(unsigned, new Uint8Array(32).fill(1));
    expect(await facilitator.verify(payloadOf(unsigned, forged.signature), requirements as any)).toMatchObject({ invalidReason: "invalid_signature" });
  });

  it("TC-SD-088-14 the scheme client signs with an EVM signer and verify accepts the payload", async () => {
    const client = new X207SchemeClient({ payer: EVM, signer: evmSigner(account) });
    client.schemeHooks.onBeforePaymentCreation?.({ selectedRequirements: requirements, paymentRequired: { resource: { url: unsigned.resource } } } as never);
    const result = await client.createPaymentPayload(2, requirements as never);
    const payload = { x402Version: 2, resource: { url: unsigned.resource }, accepted: requirements, payload: result.payload } as any;
    expect((result.payload as { signature: string }).signature).toMatch(/^eip712:0x[0-9a-f]{130}$/);
    expect(await facilitator.verify(payload, requirements as any)).toEqual({ isValid: true, payer: EVM });
  });

  it("TC-SD-088-15 the client needs exactly one of secretKey and signer, and the payer must be the address", () => {
    expect(() => new X207SchemeClient({ payer: EVM } as never)).toThrow(/exactly one/);
    expect(() => new X207SchemeClient({ payer: EVM, secretKey: new Uint8Array(32), signer: evmSigner(account) })).toThrow(/exactly one/);
    expect(() => new X207SchemeClient({ payer: "a.testnet", signer: evmSigner(account) })).toThrow(/payer must be/);
  });
});
