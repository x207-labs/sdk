// SD-098: one mixed epoch on NEAR testnet (x207-v015.testnet, real clock). Two agents that hold no NEAR account of their own owe each other:
//   the EVM agent 0xcdab… (EIP-712 vouchers, from SD-094) and a Solana agent (an ed25519 Solana keypair; its public key is also its NEAR implicit account and its voucher key).
//   1. the Solana agent is funded with 1 NEAR, joins, is admitted by the DAO council and stakes mock USDT;
//   2. in one open epoch the EVM agent signs a voucher of 20000 to the Solana agent and the Solana agent signs one of 50000 to the EVM agent; both are registered;
//   3. the keeper closes, the solver clears the 20000 cycle, the keeper commits; the Solana agent pays its residual of 30000 in the payment window;
//   4. the keeper finalizes; the EVM agent claims 30000 through the relayer (claim_evm).
// Every hash goes to stdout and to the result file; no key is printed. Keys are read from files (mode 600); the Solana keypair is made once.
//
//   X207_TESTNET=1 X207_SECRETS=/path/to/.secrets npx vitest run examples/solana-agent/test/solana-agent.mixed-epoch.testnet.live.test.ts   (from sdk/; the keeper of x207-v015.testnet must run)
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { serve } from "@hono/node-server";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import {
  buildJoinCall, buildSettleTransferCall, buildStakeTransferCall, createCircleViewFn, signVoucher, type ContractAbi, type ContractCall, type UnsignedVoucher,
} from "@x207/core";
import { evmSignerFromPrivateKey } from "@x207/core/evm";
import { defineCircleConfig } from "@x207/scheme";
import { EvmRelay, NearContractCaller, NearRpc, PendingStore, createApp, createFacilitatorService } from "../../../apps/facilitator/src/index.js";
import { createEvmAgent } from "../../evm-agent/src/agent.js";
import { generateSolanaKeypair, solanaAgentKeysFromKeypair } from "../src/agent.js";

const CIRCLE = "x207-v015.testnet";
const CIRCLE_ID = "agents-main";
const USDT = "usdt.x207-deployer.testnet";
const DAO = "x207v8.sputnikv2.testnet";
const TERMS_HASH = "a".repeat(64);
const STAKE = "40000000";
const EVM_TO_SOLANA = 20_000n;
const SOLANA_TO_EVM = 50_000n;
const RPC_URLS = ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"]; // UM-191: rpc.testnet.near.org is deprecated
const secrets = process.env.X207_SECRETS ?? join(process.cwd(), "../../../.secrets");
const demoDir = join(secrets, "testnet-demo");
const out = process.env.RESULT_FILE ?? join(process.cwd(), "../docs/testnet-epochs/sd098-solana-agent-run.json");

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
    if (hashes[name] !== undefined && hashes[name] !== hash) name = `${name} (${Object.keys(hashes).filter((k) => k.startsWith(name)).length + 1})`;
    hashes[name] = hash;
    mkdirSync(dirname(partialFile), { recursive: true });
    writeFileSync(partialFile, JSON.stringify(hashes, null, 2));
    log(name, hash);
  }
};

describe.skipIf(process.env.X207_TESTNET !== "1")("SD-098 mixed epoch: an EVM agent and a Solana agent net against each other on NEAR testnet", () => {
  it("TC-SD-098-05 vouchers both ways, clearing, residual paid by the Solana agent, claim_evm by the EVM agent; the hashes go to the result file", async () => {
    // keys: the Solana keypair is made once (Solana id.json format, 64 numbers) and kept in a file; the EVM agent key is that of SD-094
    const solanaPath = join(demoDir, "solana-agent-v015.json");
    if (!existsSync(solanaPath)) {
      mkdirSync(dirname(solanaPath), { recursive: true });
      writeFileSync(solanaPath, JSON.stringify(Array.from(generateSolanaKeypair())), { mode: 0o600 });
      chmodSync(solanaPath, 0o600);
    }
    const solana = solanaAgentKeysFromKeypair(Uint8Array.from(JSON.parse(readFileSync(solanaPath, "utf8")) as number[]));
    const evmKey = readFileSync(join(demoDir, "evm-agent-v015.key"), "utf8").trim();
    const evmSigner = evmSignerFromPrivateKey(evmKey);
    log("agents", `solana address ${solana.solanaAddress}, near implicit account ${solana.accountId}, evm ${evmSigner.id}`);

    const helper = keyFile("x207-demo-helper.testnet.json");
    const registerKey = keyFile("x207-demo-helper-reg.json");
    const deployerDir = join(secrets, "testnet-deployer");
    const councilA = { accountId: "x207-dao-v8.testnet", privateKey: (JSON.parse(readFileSync(join(deployerDir, "x207-dao-v8.testnet.json"), "utf8")) as { private_key: string }).private_key };
    const councilB = { accountId: "b.x207-dao-v8.testnet", privateKey: (JSON.parse(readFileSync(join(deployerDir, "dao-v8.json"), "utf8")) as { b: string }).b };

    const rpc = new NearRpc({ urls: RPC_URLS, timeoutMs: 30_000 });
    const view = createCircleViewFn({ circleContract: CIRCLE, rpcUrls: RPC_URLS });
    const chainView = <T>(method: string, args: object = {}) => view(method as never, args as never) as Promise<T>;
    const solanaCaller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: { accountId: solana.accountId, privateKey: solana.secretKey } });
    const helperCaller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: helper });
    const registerCaller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: registerKey });
    const send = async (caller: NearContractCaller, call: ContractCall, name: string) => {
      const { hash } = await caller.call(call.methodName, call.args as Record<string, unknown>, call.deposit, call.receiverId, call.gas);
      note(name, hash);
    };

    const callerA = new NearContractCaller({ rpc, circleContract: DAO, account: councilA });
    const callerB = new NearContractCaller({ rpc, circleContract: DAO, account: councilB });
    const daoView = async <T>(method: string, args: object): Promise<T> => {
      const r = await rpc.call<{ result: number[] }>("query", { request_type: "call_function", finality: "final", account_id: DAO, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
      return JSON.parse(Buffer.from(r.result).toString()) as T;
    };
    const isAdmitted = async (account: string) => (await chainView<ContractAbi.MemberView & { admitted?: boolean }>("member", { account_id: account })).admitted === true;
    const admit = async (account: string): Promise<void> => {
      if (await isAdmitted(account)) return;
      const args = Buffer.from(JSON.stringify({ account_id: account })).toString("base64");
      const proposal = await callerA.call(
        "add_proposal",
        { proposal: { description: `Admit ${account} to the x207 circle (SD-098)`, kind: { FunctionCall: { receiver_id: CIRCLE, actions: [{ method_name: "admit_member", args, deposit: "0", gas: "30000000000000" }] } } } },
        100_000_000_000_000_000_000_000n, DAO,
      );
      note("dao add_proposal admit solana agent", proposal.hash);
      const id = (await daoView<number>("get_last_proposal_id", {})) - 1;
      for (const [who, c] of [["a", callerA], ["b", callerB]] as const) {
        const vote = await c.call("act_proposal", { id, action: "VoteApprove" }, 0n, DAO, 200_000_000_000_000n).catch((e: Error) => ({ hash: `skipped: ${e.message.slice(0, 80)}` }));
        note(`dao vote ${who} #${id}`, vote.hash);
        if (await isAdmitted(account)) break;
      }
      for (let i = 0; i < 10; i += 1) {
        if (await isAdmitted(account)) return;
        await sleep(3_000);
      }
      throw new Error(`${account} is not admitted after the votes`);
    };

    // 1. fund the implicit account, join, admission, stake
    const provider = new JsonRpcProvider({ url: RPC_URLS[0]! });
    const exists = await provider.viewAccount({ accountId: solana.accountId }).then(() => true, () => false);
    if (!exists) {
      const helperAccount = new Account(helper.accountId, provider, KeyPairSigner.fromSecretKey(helper.privateKey as never));
      const funded = await helperAccount.transfer({ receiverId: solana.accountId, amount: 1_000_000_000_000_000_000_000_000n });
      note("fund 1 NEAR to the implicit account (plain transfer from x207-demo-helper.testnet)", (funded as { transaction?: { hash?: string } }).transaction?.hash);
    }
    let member = await chainView<ContractAbi.MemberView | null>("member", { account_id: solana.accountId });
    if (member === null) {
      await send(solanaCaller, buildJoinCall({ circleContract: CIRCLE, circleId: CIRCLE_ID, pubkeyVoucher: solana.voucherPublicKey, termsHash: TERMS_HASH }), "solana agent join");
      await sleep(4_000);
    }
    if (member?.status !== "active") {
      await admit(solana.accountId);
      await send(helperCaller, { receiverId: USDT, methodName: "mint", args: { account_id: solana.accountId, amount: "100000000" }, deposit: 0n, gas: 30_000_000_000_000n }, "mint 100 mock USDT to the solana agent");
      await send(solanaCaller, buildStakeTransferCall({ circleContract: CIRCLE, amount: STAKE, usdtTokenId: USDT }), "solana agent stake (ft_transfer_call)");
      await sleep(4_000);
    }
    member = await chainView<ContractAbi.MemberView | null>("member", { account_id: solana.accountId });
    log("solana agent", `member status ${member?.status}, stake ${(member as { stake?: string } | null)?.stake}`);
    if (member?.status !== "active") throw new Error("the solana agent is not active");

    // 2. a fresh open epoch with time left; register the two vouchers
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
    const lastSeq = async (payer: string, payee: string) => Number((await chainView<number | string | null>("last_seq", { epoch: n, payer, payee })) ?? 0);
    const evmVoucher: UnsignedVoucher = { circle: CIRCLE, payer: evmSigner.id, payee: solana.accountId, epoch: n, seq: (await lastSeq(evmSigner.id, solana.accountId)) + 1, cumulativeAmount: EVM_TO_SOLANA.toString(), unit: "credit", resource: "x207:sd098:evm-to-solana" };
    const solanaVoucher: UnsignedVoucher = { circle: CIRCLE, payer: solana.accountId, payee: evmSigner.id, epoch: n, seq: (await lastSeq(solana.accountId, evmSigner.id)) + 1, cumulativeAmount: SOLANA_TO_EVM.toString(), unit: "credit", resource: "x207:sd098:solana-to-evm" };
    const signedEvm = await evmSigner.signVoucher(evmVoucher);
    const signedSolana = signVoucher(solanaVoucher, solana.secretKey);
    const r1 = await registerCaller.call("register_cumulative", { voucher: evmVoucher, signature: signedEvm.signature }, 0n);
    note(`register_cumulative evm agent -> solana agent ${EVM_TO_SOLANA} (eip712 voucher, epoch ${n})`, r1.hash);
    const r2 = await registerCaller.call("register_cumulative", { voucher: solanaVoucher, signature: signedSolana.signature }, 0n);
    note(`register_cumulative solana agent -> evm agent ${SOLANA_TO_EVM} (ed25519 voucher, epoch ${n})`, r2.hash);

    // 3. the keeper closes and commits; the solana agent pays its residual
    const waitFor = async (what: string, ok: (e: ContractAbi.EpochView) => boolean) => {
      for (;;) {
        const e = await epochOf(n);
        if (ok(e)) return e;
        log("wait", `${what}: epoch ${n} is ${e.phase}`);
        await sleep(30_000);
      }
    };
    const paying = await waitFor("commit", (e) => e.payment_deadline != null);
    log("epoch", `${n} ${paying.phase}, payment_deadline ${paying.payment_deadline}, cleared ${paying.total_cleared} of ${paying.total_obligation}`);
    const solanaPosition = await chainView<ContractAbi.PositionView | null>("net_position", { epoch: n, account_id: solana.accountId });
    const evmPosition = await chainView<ContractAbi.PositionView | null>("net_position", { epoch: n, account_id: evmSigner.id });
    log("positions", `solana ${JSON.stringify(solanaPosition)} | evm ${JSON.stringify(evmPosition)}`);
    const residual = BigInt(solanaPosition?.amount ?? "0");
    if (solanaPosition?.role !== "debtor" || residual <= 0n) throw new Error(`the solana agent should owe a residual, got ${JSON.stringify(solanaPosition)}`);
    await send(solanaCaller, buildSettleTransferCall({ circleContract: CIRCLE, amount: residual.toString(), epoch: n, usdtTokenId: USDT }), `solana agent settle ft_transfer_call (${residual}, epoch ${n})`);

    // 4. finalize by the keeper, then the EVM agent claims through the relayer
    await waitFor("finalize", (e) => e.phase === "finalized");
    log("epoch", `${n} finalized`);
    const pending = new PendingStore(":memory:");
    const service = createFacilitatorService({ circles: [defineCircleConfig({ network: `x207:${CIRCLE_ID}`, circleContract: CIRCLE })], rpc, pending, signers: [registerKey.accountId] });
    const relayerCaller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: helper, onHash: (h) => note("relayer tx", h) });
    const relay = new EvmRelay({ circleContract: CIRCLE, maxDeadlineMs: 900_000, caller: relayerCaller });
    const facilitator = await new Promise<{ url: string; close: () => void }>((resolve) => {
      const server = serve({ fetch: createApp(service, { evm: relay, rateLimit: false }).fetch, port: 0, hostname: "127.0.0.1" }, ({ port }) => resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() }));
    });
    const evmAgent = createEvmAgent({ privateKey: evmKey, relayerUrl: facilitator.url, circleContract: CIRCLE, rpcUrls: RPC_URLS });
    const claimed = await evmAgent.claim(n, helper.accountId);
    note("claim_evm (the evm agent, sent by the relayer)", claimed.txHash);
    await sleep(4_000);
    const evmAfter = await chainView<ContractAbi.PositionView | null>("net_position", { epoch: n, account_id: evmSigner.id });
    const solanaAfter = await chainView<ContractAbi.PositionView | null>("net_position", { epoch: n, account_id: solana.accountId });
    log("after", `solana ${JSON.stringify(solanaAfter)} | evm ${JSON.stringify(evmAfter)}`);

    const result = {
      circle: CIRCLE, epoch: n, solanaAddress: solana.solanaAddress, solanaAgentNearAccount: solana.accountId, evmAgentAddress: evmSigner.id, payoutReceiver: helper.accountId,
      vouchers: { evmToSolana: EVM_TO_SOLANA.toString(), solanaToEvm: SOLANA_TO_EVM.toString() },
      epochAfterCommit: { total_obligation: paying.total_obligation, total_cleared: paying.total_cleared },
      positionsAfterCommit: { solana: solanaPosition, evm: evmPosition }, positionsAfterClaim: { solana: solanaAfter, evm: evmAfter },
      hashes,
      note: "Run by sdk/examples/solana-agent/test/solana-agent.mixed-epoch.testnet.live.test.ts. Keeper transactions (close_epoch, commit_epoch, finalize_epoch) are in the journal of x207-keeper-v015 and in the explorer under the keeper account.",
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    log("result", out);
    pending.close();
    facilitator.close();
  }, 5_400_000);
});
