// SD-089 / SD-090: an EVM agent that holds only a 0x key joins the circle through the relayer, pays and is paid with eip712 vouchers, and claims, on near-sandbox with the contract 0.0.14.
// Skipped if the near-sandbox binary or the contract wasm is missing, or the wasm has no `join_evm` (a contract older than 0.0.14).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildClaimCall, buildSettleTransferCall, buildStakeTransferCall, createCircleViewFn, onboardMember, signVoucher,
  type ContractAbi, type ContractCall, type UnsignedVoucher,
} from "@x207/core";
import { evmSigner } from "@x207/core/evm";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { CIRCLE_WASM, sandboxAvailable, type SandboxAccount } from "../../../test-support/sandbox.js";
import { createApp, type FacilitatorService } from "../src/app.js";
import { EvmRelay } from "../src/evm-relay.js";
import { NearContractCaller, NearRegistrationChain } from "../src/relay.js";
import { NearRpc } from "../src/rpc.js";

const hasEvm = (): boolean => {
  try {
    return readFileSync(CIRCLE_WASM).includes(Buffer.from("join_evm"));
  } catch {
    return false;
  }
};
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // public hardhat test key
const agent = evmSigner(privateKeyToAccount(KEY));
const EPOCH_MS = 3_600_000;
const GAS = 200_000_000_000_000n;

describe.skipIf(!sandboxAvailable || !hasEvm())("SD-089 SD-090 EVM agent on near-sandbox", () => {
  let fx: CircleFixture;
  let relayer: SandboxAccount;
  let wallet: SandboxAccount;
  let seller: SandboxAccount;
  let sellerKey: `ed25519:${string}`;
  let blockNow = Date.now();
  let post: (path: string, body: unknown) => Promise<{ status: number; body: any }>;
  let rpc: NearRpc;

  const view = <T>(method: string, args: object = {}) => fx.sandbox.view<T>(fx.circle.accountId, method, args);
  const usdt = async (id: string) => BigInt(await fx.sandbox.view<string>(fx.usdt.accountId, "ft_balance_of", { account_id: id }));
  const send = (who: SandboxAccount, call: Pick<ContractCall, "receiverId" | "methodName" | "args" | "deposit" | "gas">) => fx.sandbox.accountFrom(who.accountId, who.secretKey).call(call, "EXECUTED_OPTIMISTIC");
  const refreshClock = async () => { blockNow = await fx.sandbox.blockTimestampMs(); };
  const at = async (ns: string | null | undefined) => {
    await fx.sandbox.advanceTo(Number(BigInt(ns!) / 1_000_000n) + 1_000);
    await new Promise((r) => setTimeout(r, 3_000));
    await refreshClock();
  };

  beforeAll(async () => {
    fx = await deployCircle();
    relayer = await fx.member("evmrelayer");
    wallet = await fx.sandbox.createAccount("agentwallet", "5");
    seller = await fx.member("seller");
    const sendCall = async (call: ContractCall) => {
      const result = await seller.call(call);
      if (result.failures.length > 0) throw new Error(result.failures.join("; "));
      return result.value;
    };
    const joined = await onboardMember(
      { sendCall, view: createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] }), pollIntervalMs: 200, timeoutMs: 30_000 },
      { circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: seller.accountId, termsHash: TERMS_HASH, stakeAmount: "50000000", usdtTokenId: fx.usdt.accountId },
    );
    sellerKey = joined.secretKey;
    rpc = new NearRpc({ urls: [fx.sandbox.rpcUrl], timeoutMs: 30_000 });
    const relay = new EvmRelay({
      circleContract: fx.circle.accountId,
      caller: new NearContractCaller({ rpc, circleContract: fx.circle.accountId, account: { accountId: relayer.accountId, privateKey: relayer.secretKey } }),
      now: () => blockNow,
    });
    const service = { verify: async () => ({}), settle: async () => ({}), supported: async () => ({}) } as unknown as FacilitatorService;
    const app = createApp(service, { evm: relay, rateLimit: false });
    post = async (path, body) => {
      const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    await refreshClock();
  }, 400_000);
  afterAll(async () => {
    await fx?.stop();
  });

  const action = (name: "join" | "claim" | "request_exit" | "withdraw_stake", fields: { epoch?: number; receiver?: string; termsHash?: string; nonce: number }, deadline: number) =>
    agent.signAction({ circle: fx.circle.accountId, action: name, epoch: fields.epoch ?? 0, receiver: fields.receiver ?? "", termsHash: fields.termsHash ?? "", nonce: fields.nonce, deadline });

  it("TC-SD-090-01 join through the relayer, stake by the relayer, member active with no NEAR key of the agent", async () => {
    const deadline = blockNow + 24 * EPOCH_MS;
    const signature = await action("join", { termsHash: TERMS_HASH, nonce: 0 }, deadline);
    const joined = await post("/evm/join", { address: agent.id, termsHash: TERMS_HASH, deadline, signature });
    expect(joined).toMatchObject({ status: 200, body: { ok: true, method: "join_evm" } });
    expect(await view<ContractAbi.MemberView>("member", { account_id: agent.id })).toMatchObject({ status: "pending", stake: "0" });
    expect(await view<{ address: string; sponsor: string; nonce: string | number }>("evm_signer", { account_id: agent.id })).toMatchObject({ address: agent.id, sponsor: relayer.accountId });

    // the same signature again: refused by the contract (already a member), not sent twice by the relayer
    const again = await post("/evm/join", { address: agent.id, termsHash: TERMS_HASH, deadline, signature });
    expect([again.status, again.body.error]).toEqual([409, "already_member"]);

    // the relayer funds the stake for the agent (ft_transfer_call with member_id), as on testnet
    const staked = await send(relayer, buildStakeTransferCall({ circleContract: fx.circle.accountId, amount: "50000000", memberId: agent.id, usdtTokenId: fx.usdt.accountId }));
    expect(staked.failures).toEqual([]);
    await new Promise((r) => setTimeout(r, 3_000));
    const member = await view<ContractAbi.MemberView>("member", { account_id: agent.id });
    expect(member.status).toBe("active");
    expect(BigInt(member.limit)).toBeGreaterThan(0n);
  }, 300_000);

  it("TC-SD-090-02 a wrong signature, another receiver or a wrong nonce never reaches the chain or is refused by it", async () => {
    const deadline = blockNow + 24 * EPOCH_MS;
    const good = await action("claim", { epoch: 1, receiver: wallet.accountId, nonce: 0 }, deadline);
    const body = { member: agent.id, epoch: 1, receiver: wallet.accountId, nonce: 0, deadline, signature: good };
    expect((await post("/evm/claim", { ...body, receiver: seller.accountId })).body.error).toBe("bad_signature");
    const wrongNonce = await action("claim", { epoch: 1, receiver: wallet.accountId, nonce: 5 }, deadline);
    const refused = await post("/evm/claim", { ...body, nonce: 5, signature: wrongNonce });
    expect([refused.status, refused.body.error]).toEqual([409, "bad_nonce"]);
  }, 300_000);

  it("TC-SD-090-03 eip712 voucher agent to seller and ed25519 voucher seller to agent: one epoch to finalized, agent claims to a NEAR wallet", async () => {
    const first = await view<ContractAbi.EpochView>("get_epoch", {});
    const epoch = first.epoch;
    const chain = new NearRegistrationChain({ rpc, circleContract: fx.circle.accountId, relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey } });
    // the agent pays 4 credits (eip712); the seller pays the agent 10 credits (ed25519): net, the seller owes 6
    const toSeller: UnsignedVoucher = { circle: fx.circle.accountId, payer: agent.id, payee: seller.accountId, epoch, seq: 1, cumulativeAmount: "4000000", unit: "credit", resource: "https://seller.example/api" };
    const signed = await agent.signVoucher(toSeller);
    await chain.register(toSeller, signed.signature, "cumulative");
    const toAgent: UnsignedVoucher = { circle: fx.circle.accountId, payer: seller.accountId, payee: agent.id, epoch, seq: 1, cumulativeAmount: "10000000", unit: "credit", resource: "https://agent.example/api" };
    await chain.register(toAgent, signVoucher(toAgent, sellerKey).signature, "cumulative");
    expect(await view<ContractAbi.ObligationView>("obligation", { epoch, debtor: agent.id, creditor: seller.accountId })).toMatchObject({ cumulative: "4000000", last_seq: 1 });

    // a voucher of the agent that was signed for another payer address is refused by the contract
    const forged = { ...toSeller, seq: 2, cumulativeAmount: "5000000" };
    await expect(chain.register(forged, (await agent.signVoucher({ ...forged, resource: "https://other.example" })).signature, "cumulative")).rejects.toThrow(/ERR_BAD_SIGNATURE|signature|ERR_/);

    await at(first.cutoff_at);
    expect((await send(seller, { receiverId: fx.circle.accountId, methodName: "close_epoch", args: { epoch }, deposit: 0n })).failures).toEqual([]);
    const closing = await view<ContractAbi.EpochView>("get_epoch", { epoch });
    await at(closing.proposal_deadline);
    expect((await send(seller, { receiverId: fx.circle.accountId, methodName: "commit_epoch", args: { epoch }, deposit: 0n, gas: GAS })).failures).toEqual([]);
    const paying = await view<ContractAbi.EpochView>("get_epoch", { epoch });

    const positions = await view<Array<{ account_id: string; role: string; status: string | null; amount: string }>>("list_positions", { epoch, from_index: 0, limit: 100 });
    expect(positions.find((p) => p.account_id === agent.id)).toMatchObject({ role: "creditor", amount: "6000000", status: "claimable" });
    expect(positions.find((p) => p.account_id === seller.accountId)).toMatchObject({ role: "debtor", amount: "6000000" });

    expect((await send(seller, buildSettleTransferCall({ circleContract: fx.circle.accountId, amount: "6000000", epoch, usdtTokenId: fx.usdt.accountId }))).failures).toEqual([]);
    await at(paying.payment_deadline);
    expect((await send(seller, { receiverId: fx.circle.accountId, methodName: "finalize_epoch", args: { epoch }, deposit: 0n, gas: GAS })).failures).toEqual([]);
    expect((await view<ContractAbi.EpochView>("get_epoch", { epoch })).phase).toBe("finalized");

    // the agent signs the claim with the 0x key only; the relayer sends it; the payout goes to the NEAR wallet named in the signature
    const before = await usdt(wallet.accountId);
    const deadline = blockNow + 24 * EPOCH_MS;
    const signature = await action("claim", { epoch, receiver: wallet.accountId, nonce: 0 }, deadline);
    const claimed = await post("/evm/claim", { member: agent.id, epoch, receiver: wallet.accountId, nonce: 0, deadline, signature });
    expect(claimed).toMatchObject({ status: 200, body: { ok: true, method: "claim_evm" } });
    await new Promise((r) => setTimeout(r, 3_000));
    expect((await usdt(wallet.accountId)) - before).toBe(6_000_000n);
    expect((await view<Array<{ account_id: string; status: string | null }>>("list_positions", { epoch, from_index: 0, limit: 100 })).find((p) => p.account_id === agent.id)?.status).toBe("claimed");

    // the nonce is spent: the same claim again fails
    const replay = await post("/evm/claim", { member: agent.id, epoch, receiver: wallet.accountId, nonce: 0, deadline, signature });
    expect([replay.status, replay.body.error]).toEqual([409, "bad_nonce"]);
    console.log(JSON.stringify({ evmAgent: agent.id, claimTx: claimed.body.txHash }));
  }, 900_000);

  it("TC-SD-090-04 exit: nonce 1 (after the claim used nonce 0) requests the exit through the relayer", async () => {
    const deadline = blockNow + 24 * EPOCH_MS;
    const exitSig = await action("request_exit", { nonce: 1 }, deadline);
    const exit = await post("/evm/exit", { member: agent.id, nonce: 1, deadline, signature: exitSig });
    expect(exit).toMatchObject({ status: 200, body: { method: "request_exit_evm" } });
    expect((await view<ContractAbi.MemberView>("member", { account_id: agent.id })).exit_requested_epoch).not.toBeNull();
  }, 300_000);
});
