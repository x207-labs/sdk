// SD-099: an EVM agent that uses NO x207 relayer. Its 0x key signs Ethereum transactions (chain id 398) for `rlp_execute` (NEP-518) on its own eth-implicit NEAR account; a plain NEAR account sends them and pays the gas.
// All of these are made that way on x207-v015.testnet (real clock): `join` (0.35 NEAR attached out of the agent's own balance), the stake (`ft_transfer_call` of mock USDT held by the 0x account),
// and, after an epoch in which the Solana agent of SD-098 owes the agent 40000, `claim`. The Solana agent pays its residual, the keeper finalizes, the 0x key claims.
// Keys come from files (mode 600); the 0x key and the voucher key of this agent are new for this run. No key is printed.
//
//   X207_TESTNET=1 X207_SECRETS=/path/to/.secrets npx vitest run examples/evm-agent/test/evm-agent.rlp-only.testnet.live.test.ts   (from sdk/; the keeper of x207-v015.testnet must run)
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import {
  JOIN_STORAGE_DEPOSIT, buildClaimArgs, buildJoinCall, buildSettleTransferCall, buildStakeTransferCall, createCircleViewFn, generateVoucherKeypair, signVoucher, voucherPublicKey,
  type ContractAbi, type UnsignedVoucher,
} from "@x207/core";
import { nep518Attach, signNep518Transaction, type Nep518Call } from "@x207/core/evm";
import { NearContractCaller, NearRpc } from "../../../apps/facilitator/src/index.js";
import { solanaAgentKeysFromKeypair } from "../../solana-agent/src/agent.js";

const CIRCLE = "x207-v015.testnet";
const CIRCLE_ID = "agents-main";
const USDT = "usdt.x207-deployer.testnet";
const DAO = "x207v8.sputnikv2.testnet";
const TERMS_HASH = "a".repeat(64);
const STAKE = "40000000";
const OWED = 40_000n;
const RPC_URLS = ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"]; // UM-191: rpc.testnet.near.org is deprecated
const secrets = process.env.X207_SECRETS ?? join(process.cwd(), "../../../.secrets");
const demoDir = join(secrets, "testnet-demo");
const out = process.env.RESULT_FILE ?? join(process.cwd(), "../docs/testnet-epochs/sd099-rlp-only-run.json");

const keyFile = (name: string): { accountId: string; privateKey: string } => {
  const f = JSON.parse(readFileSync(join(demoDir, "testnet", name), "utf8")) as { account_id: string; secret_key: string };
  return { accountId: f.account_id, privateKey: f.secret_key };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const partialFile = `${out}.partial`;
const hashes: Record<string, string> = existsSync(partialFile) ? (JSON.parse(readFileSync(partialFile, "utf8")) as Record<string, string>) : {};
const log = (step: string, detail: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${step}: ${detail}`);
const note = (name: string, hash: string | undefined) => {
  if (hash) {
    hashes[name] = hash;
    mkdirSync(dirname(partialFile), { recursive: true });
    writeFileSync(partialFile, JSON.stringify(hashes, null, 2));
    log(name, hash);
  }
};
const ownKeyFile = (name: string, make: () => string): string => {
  const path = join(demoDir, name);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, make(), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return readFileSync(path, "utf8").trim();
};

describe.skipIf(process.env.X207_TESTNET !== "1")("SD-099 an EVM agent joins, stakes and claims only through rlp_execute (NEP-518) on x207-v015.testnet", () => {
  it("TC-SD-099-02 join, stake and claim are signed by the 0x key alone and sent by a plain NEAR account; the hashes go to the result file", async () => {
    const agentKey = ownKeyFile("evm-rlp-v015.key", () => generatePrivateKey()) as `0x${string}`;
    const voucherKey = ownKeyFile("evm-rlp-v015-voucher.key", () => generateVoucherKeypair().secretKey) as `ed25519:${string}`;
    const agentId = privateKeyToAccount(agentKey).address.toLowerCase();
    const solana = solanaAgentKeysFromKeypair(Uint8Array.from(JSON.parse(readFileSync(join(demoDir, "solana-agent-v015.json"), "utf8")) as number[]));
    log("agent", `0x account ${agentId}; counterparty (SD-098 Solana agent) ${solana.accountId}`);

    const helper = keyFile("x207-demo-helper.testnet.json");
    const registerKey = keyFile("x207-demo-helper-reg.json");
    const deployerDir = join(secrets, "testnet-deployer");
    const councilA = { accountId: "x207-dao-v8.testnet", privateKey: (JSON.parse(readFileSync(join(deployerDir, "x207-dao-v8.testnet.json"), "utf8")) as { private_key: string }).private_key };
    const councilB = { accountId: "b.x207-dao-v8.testnet", privateKey: (JSON.parse(readFileSync(join(deployerDir, "dao-v8.json"), "utf8")) as { b: string }).b };

    const rpc = new NearRpc({ urls: RPC_URLS, timeoutMs: 30_000 });
    const view = createCircleViewFn({ circleContract: CIRCLE, rpcUrls: RPC_URLS });
    const chainView = <T>(method: string, args: object = {}) => view(method as never, args as never) as Promise<T>;
    const provider = new JsonRpcProvider({ url: RPC_URLS[0]! });
    const payer = new Account(helper.accountId, provider, KeyPairSigner.fromSecretKey(helper.privateKey as `ed25519:${string}`));
    const helperCaller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: helper });
    const registerCaller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: registerKey });
    const solanaCaller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: { accountId: solana.accountId, privateKey: solana.secretKey } });

    const ftBalance = async (account: string) => BigInt(String(await provider.callFunction({ contractId: USDT, method: "ft_balance_of", args: { account_id: account }, blockQuery: { finality: "final" } })));
    const nonceOf = async (): Promise<number> => Number(String(await provider.callFunction({ contractId: agentId, method: "get_nonce", args: {}, blockQuery: { finality: "final" } })));

    /** One wallet call: the 0x key signs, the helper account sends `rlp_execute` and pays the NEAR gas; the NEAR attached comes out of the balance of the 0x account. */
    const rlp = async (name: string, target: string, call: Omit<Nep518Call, "yoctoNear">, attachYocto: bigint, { mayFail = false } = {}): Promise<{ hash: string; failure?: string }> => {
      const { valueWei, yoctoNear } = nep518Attach(attachYocto);
      const args = await signNep518Transaction({ privateKey: agentKey, target, nonce: await nonceOf(), call: { ...call, yoctoNear }, valueWei });
      const res = await payer.callFunctionRaw({ contractId: agentId, methodName: "rlp_execute", args, deposit: 0n, gas: 300_000_000_000_000n, waitUntil: "FINAL" });
      const failures = (res.receipts_outcome ?? []).map((o) => o.outcome.status).filter((s) => typeof s === "object" && s !== null && "Failure" in s);
      const failure = failures.length > 0 ? JSON.stringify(failures[0]).slice(0, 300) : undefined;
      note(name, res.transaction.hash);
      if (failure && !mayFail) throw new Error(`${name} failed: ${failure}`);
      await sleep(4_000);
      return { hash: res.transaction.hash, ...(failure ? { failure } : {}) };
    };

    // 0. the eth-implicit account exists and holds NEAR for the join deposit and the 1 yocto deposits
    const balance = async () => { try { return BigInt((await provider.viewAccount(agentId)).amount); } catch { return 0n; } };
    if ((await balance()) < 600_000_000_000_000_000_000_000n) {
      const sent = await payer.transfer({ receiverId: agentId, amount: 1_500_000_000_000_000_000_000_000n });
      note("fund 1.5 NEAR to the eth-implicit account (plain transfer from x207-demo-helper.testnet)", sent.transaction.hash);
      await sleep(4_000);
    }
    if ((await ftBalance(agentId)) < BigInt(STAKE)) {
      const minted = await helperCaller.call("mint", { account_id: agentId, amount: "100000000" }, 0n, USDT, 30_000_000_000_000n);
      note("mint 100 mock USDT to the 0x account", minted.hash);
      await sleep(3_000);
    }

    // 1. join through rlp_execute: 0.35 NEAR out of the agent's own balance; the voucher key is a separate ed25519 key (a 0x key cannot make the ed25519 signature `join` checks against)
    let member = await chainView<ContractAbi.MemberView | null>("member", { account_id: agentId });
    if (member === null) {
      const join = buildJoinCall({ circleContract: CIRCLE, circleId: CIRCLE_ID, pubkeyVoucher: voucherPublicKey(voucherKey), termsHash: TERMS_HASH });
      const joined = await rlp("rlp_execute join (0.35 NEAR from the 0x account)", CIRCLE, { receiverId: CIRCLE, methodName: "join", args: join.args, gas: 60_000_000_000_000n }, join.deposit ?? JOIN_STORAGE_DEPOSIT, { mayFail: true });
      if (joined.failure) {
        hashes["join failure"] = joined.failure;
        writeFileSync(partialFile, JSON.stringify(hashes, null, 2));
        throw new Error(`join through rlp_execute failed: ${joined.failure}`);
      }
      member = await chainView<ContractAbi.MemberView | null>("member", { account_id: agentId });
    }
    log("agent", `member ${JSON.stringify(member)?.slice(0, 200)}`);
    expect(member).not.toBeNull();

    // 2. admission by the DAO council, then the stake from the agent's own USDT through rlp_execute
    const callerA = new NearContractCaller({ rpc, circleContract: DAO, account: councilA });
    const callerB = new NearContractCaller({ rpc, circleContract: DAO, account: councilB });
    const isAdmitted = async () => (await chainView<ContractAbi.MemberView & { admitted?: boolean }>("member", { account_id: agentId })).admitted === true;
    if (!(await isAdmitted())) {
      const args = Buffer.from(JSON.stringify({ account_id: agentId })).toString("base64");
      const proposal = await callerA.call("add_proposal", { proposal: { description: `Admit ${agentId} to the x207 circle (SD-099)`, kind: { FunctionCall: { receiver_id: CIRCLE, actions: [{ method_name: "admit_member", args, deposit: "0", gas: "30000000000000" }] } } } }, 100_000_000_000_000_000_000_000n, DAO);
      note("dao add_proposal admit the 0x agent", proposal.hash);
      const last = await rpc.call<{ result: number[] }>("query", { request_type: "call_function", finality: "final", account_id: DAO, method_name: "get_last_proposal_id", args_base64: Buffer.from("{}").toString("base64") });
      const id = (JSON.parse(Buffer.from(last.result).toString()) as number) - 1;
      for (const [who, c] of [["a", callerA], ["b", callerB]] as const) {
        const vote = await c.call("act_proposal", { id, action: "VoteApprove" }, 0n, DAO, 200_000_000_000_000n).catch((e: Error) => ({ hash: `skipped: ${e.message.slice(0, 80)}` }));
        note(`dao vote ${who} #${id}`, vote.hash);
        if (await isAdmitted()) break;
      }
      for (let i = 0; i < 10 && !(await isAdmitted()); i += 1) await sleep(3_000);
      expect(await isAdmitted()).toBe(true);
    }
    if (member?.status !== "active") {
      const stake = buildStakeTransferCall({ circleContract: CIRCLE, amount: STAKE, usdtTokenId: USDT });
      await rlp("rlp_execute stake (ft_transfer_call of 40 mock USDT, 1 yocto)", USDT, { receiverId: USDT, methodName: "ft_transfer_call", args: stake.args, gas: 120_000_000_000_000n }, 1n);
    }
    member = await chainView<ContractAbi.MemberView | null>("member", { account_id: agentId });
    log("agent", `status ${member?.status}, stake ${(member as { stake?: string } | null)?.stake}`);
    expect(member?.status).toBe("active");

    // 3. an epoch in which the Solana agent owes the 0x agent
    const epochOf = async (n?: number): Promise<ContractAbi.EpochView> => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await chainView<ContractAbi.EpochView>("get_epoch", n === undefined ? {} : { epoch: n });
        } catch (error) {
          if (attempt >= 8) throw error;
          await sleep(10_000);
        }
      }
    };
    let epoch = await epochOf();
    for (;;) {
      const left = Number(BigInt(epoch.cutoff_at ?? 0) / 1_000_000n) - Date.now();
      if (epoch.phase === "open" && left > 240_000) break;
      log("wait", `epoch ${epoch.epoch} ${epoch.phase}, ${Math.round(left / 1000)} s to cutoff`);
      await sleep(20_000);
      epoch = await epochOf();
    }
    const n = epoch.epoch;
    log("epoch", `${n} open`);
    const seq = Number((await chainView<number | string | null>("last_seq", { epoch: n, payer: solana.accountId, payee: agentId })) ?? 0) + 1;
    const voucher: UnsignedVoucher = { circle: CIRCLE, payer: solana.accountId, payee: agentId, epoch: n, seq, cumulativeAmount: OWED.toString(), unit: "credit", resource: "x207:sd099:solana-to-rlp-agent" };
    const registered = await registerCaller.call("register_cumulative", { voucher, signature: signVoucher(voucher, solana.secretKey).signature }, 0n);
    note(`register_cumulative solana agent -> 0x agent ${OWED} (ed25519 voucher, epoch ${n})`, registered.hash);

    const waitFor = async (what: string, ok: (e: ContractAbi.EpochView) => boolean) => {
      for (;;) {
        const e = await epochOf(n);
        if (ok(e)) return e;
        log("wait", `${what}: epoch ${n} is ${e.phase}`);
        await sleep(30_000);
      }
    };
    await waitFor("commit", (e) => e.payment_deadline != null);
    const solanaPosition = await chainView<ContractAbi.PositionView | null>("net_position", { epoch: n, account_id: solana.accountId });
    if (solanaPosition?.role !== "debtor") throw new Error(`the solana agent should owe, got ${JSON.stringify(solanaPosition)}`);
    const settle = await solanaCaller.call(...(() => { const c = buildSettleTransferCall({ circleContract: CIRCLE, amount: BigInt(solanaPosition.amount).toString(), epoch: n, usdtTokenId: USDT }); return [c.methodName, c.args as Record<string, unknown>, c.deposit, c.receiverId, c.gas] as const; })());
    note(`solana agent settle ft_transfer_call (${solanaPosition.amount}, epoch ${n})`, settle.hash);
    await waitFor("finalize", (e) => e.phase === "finalized");
    log("epoch", `${n} finalized`);

    // 4. claim through rlp_execute: the payout goes to the 0x account itself (destination near)
    const before = await ftBalance(agentId);
    const claimArgs = buildClaimArgs(n, "near");
    await rlp(`rlp_execute claim (epoch ${n}, destination near, 1 yocto)`, CIRCLE, { receiverId: CIRCLE, methodName: "claim", args: claimArgs, gas: 100_000_000_000_000n }, 1n);
    await sleep(6_000);
    const after = await ftBalance(agentId);
    const position = await chainView<ContractAbi.PositionView | null>("net_position", { epoch: n, account_id: agentId });
    log("claim", `position ${JSON.stringify(position)}; mock USDT of the 0x account ${before} -> ${after}`);
    expect(position?.status).toBe("claimed");
    expect(after - before).toBe(BigInt(solanaPosition.amount));

    const result = {
      circle: CIRCLE, epoch: n, agentAddress: agentId, counterparty: solana.accountId, payer: helper.accountId,
      owed: OWED.toString(), usdtBeforeClaim: before.toString(), usdtAfterClaim: after.toString(), position, memberAfterStake: member, hashes,
      note: "Run by sdk/examples/evm-agent/test/evm-agent.rlp-only.testnet.live.test.ts. join, stake and claim were signed by the 0x key alone (NEP-518 rlp_execute, chain id 398) and sent by x207-demo-helper.testnet, which paid the NEAR gas. The admission (DAO), the voucher registration, the other side's settle and the keeper's close, commit and finalize are not the agent's.",
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    log("result", out);
  }, 5_400_000);
});
