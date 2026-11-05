// SD-094: one run of the EVM agent on NEAR testnet against the circle x207-v015.testnet (contract 0.0.15, opt-in auto-settle), with the real clock.
//   1. a seller (native member) joins and stakes; 2. the agent (a new 0x key) joins through the relayer, the council admits it, the relayer stakes mock USDT for it;
//   3. the agent opts in with `/evm/auto-settle` (action `auto_settle`, signature only), then pays the seller through x402 with an EIP-712 voucher (the voucher is registered on chain);
//   4. the agent does NOT pay its residual; 5. the keeper closes, commits and finalizes: `finalize_epoch` takes the due from the stake of the agent, the agent stays `active`.
// Every hash goes to stdout and to the result file. No key is printed: keys are read from files; the agent key is made once and kept in a file (mode 600).
//
//   X207_TESTNET=1 X207_SECRETS=/path/to/.secrets npx vitest run examples/evm-agent/test/evm-agent.autosettle.testnet.live.test.ts   (from sdk/; the keeper of x207-v015.testnet must run)
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { serve } from "@hono/node-server";
import { generatePrivateKey } from "viem/accounts";
import {
  buildJoinCall, buildStakeTransferCall, createCircleViewFn, generateVoucherKeypair, voucherPublicKey, type ContractAbi, type ContractCall,
} from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import {
  EvmRelay, NearContractCaller, NearRegistrationChain, NearRpc, PendingStore, RegistrationScheduler, createApp, createFacilitatorService,
} from "../../../apps/facilitator/src/index.js";
import { createSeller } from "../../seller/src/seller.js";
import { createEvmAgent } from "../src/agent.js";

const CIRCLE = "x207-v015.testnet";
const CIRCLE_ID = "agents-main";
const USDT = "usdt.x207-deployer.testnet";
const DAO = "x207v8.sputnikv2.testnet"; // owner of the circle; admission is `dao`
const TERMS_HASH = "a".repeat(64);
const STAKE = "40000000"; // 40 mock USDT (the demo accounts hold a little less than 50)
const RPC_URLS = ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"];
const secrets = process.env.X207_SECRETS ?? join(process.cwd(), "../../../.secrets");
const demoDir = join(secrets, "testnet-demo");
const out = process.env.RESULT_FILE ?? join(process.cwd(), "../docs/testnet-epochs/sd094-auto-settle-run.json");

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

describe.skipIf(process.env.X207_TESTNET !== "1")("SD-094 EVM agent opts in to auto-settle on NEAR testnet (x207-v015.testnet)", () => {
  it("TC-SD-094-04 opt-in, unpaid residual, finalize takes the due from the stake, the member stays active; the hashes go to the result file", async () => {
    const agentKeyPath = join(demoDir, "evm-agent-v015.key");
    if (!existsSync(agentKeyPath)) {
      mkdirSync(dirname(agentKeyPath), { recursive: true });
      writeFileSync(agentKeyPath, generatePrivateKey(), { mode: 0o600 });
      chmodSync(agentKeyPath, 0o600);
    }
    const agentKey = readFileSync(agentKeyPath, "utf8").trim();

    const evmRelayerKey = keyFile("x207-demo-helper.testnet.json");
    const registerKey = keyFile("x207-demo-helper-reg.json");
    const sellerKey = keyFile("x207-demo-seller.testnet.json");
    const deployerDir = join(secrets, "testnet-deployer");
    const councilA = { accountId: "x207-dao-v8.testnet", privateKey: (JSON.parse(readFileSync(join(deployerDir, "x207-dao-v8.testnet.json"), "utf8")) as { private_key: string }).private_key };
    const councilB = { accountId: "b.x207-dao-v8.testnet", privateKey: (JSON.parse(readFileSync(join(deployerDir, "dao-v8.json"), "utf8")) as { b: string }).b };

    const rpc = new NearRpc({ urls: RPC_URLS, timeoutMs: 30_000 });
    const view = createCircleViewFn({ circleContract: CIRCLE, rpcUrls: RPC_URLS });
    const chainView = <T>(method: string, args: object = {}) => view(method as never, args as never) as Promise<T>;

    const sellerCaller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: sellerKey });
    const sendFromSeller = async (call: ContractCall) => {
      const { hash } = await sellerCaller.call(call.methodName, call.args as Record<string, unknown>, call.deposit, call.receiverId, call.gas);
      note(`seller ${call.methodName}`, hash);
    };

    const callerA = new NearContractCaller({ rpc, circleContract: DAO, account: councilA });
    const callerB = new NearContractCaller({ rpc, circleContract: DAO, account: councilB });
    const daoView = async <T>(method: string, args: object): Promise<T> => {
      const r = await rpc.call<{ result: number[] }>("query", { request_type: "call_function", finality: "final", account_id: DAO, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
      return JSON.parse(Buffer.from(r.result).toString()) as T;
    };
    const isAdmitted = async (account: string) => (await chainView<ContractAbi.MemberView & { admitted?: boolean }>("member", { account_id: account })).admitted === true;
    /** Admission is `dao`: a council proposal calls `admit_member`, both council members vote approve, the DAO runs it. */
    const admit = async (account: string): Promise<void> => {
      if (await isAdmitted(account)) return;
      const args = Buffer.from(JSON.stringify({ account_id: account })).toString("base64");
      const proposal = await callerA.call(
        "add_proposal",
        { proposal: { description: `Admit ${account} to the x207 circle (SD-094)`, kind: { FunctionCall: { receiver_id: CIRCLE, actions: [{ method_name: "admit_member", args, deposit: "0", gas: "30000000000000" }] } } } },
        100_000_000_000_000_000_000_000n, DAO,
      );
      note(`dao add_proposal admit ${account}`, proposal.hash);
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

    // 1. the seller is a native member of the circle
    const sellerVoucherPath = join(demoDir, "v015-seller-voucher.key");
    let sellerVoucherKey: `ed25519:${string}`;
    if (existsSync(sellerVoucherPath)) sellerVoucherKey = readFileSync(sellerVoucherPath, "utf8").trim() as `ed25519:${string}`;
    else {
      sellerVoucherKey = generateVoucherKeypair().secretKey;
      writeFileSync(sellerVoucherPath, sellerVoucherKey, { mode: 0o600 });
    }
    const sellerMember = await chainView<ContractAbi.MemberView | null>("member", { account_id: sellerKey.accountId });
    if (sellerMember === null) {
      log("seller", `${sellerKey.accountId} joins ${CIRCLE}`);
      await sendFromSeller(buildJoinCall({ circleContract: CIRCLE, circleId: CIRCLE_ID, pubkeyVoucher: voucherPublicKey(sellerVoucherKey), termsHash: TERMS_HASH }));
    }
    if (sellerMember?.status !== "active") {
      await admit(sellerKey.accountId);
      await sendFromSeller(buildStakeTransferCall({ circleContract: CIRCLE, amount: STAKE, memberId: sellerKey.accountId, usdtTokenId: USDT }));
      await sleep(4_000);
    }
    log("seller", `member status ${(await chainView<ContractAbi.MemberView | null>("member", { account_id: sellerKey.accountId }))?.status}`);

    // 2. facilitator with the EVM relayer routes and the seller, on this machine
    const pending = new PendingStore(":memory:");
    const service = createFacilitatorService({ circles: [defineCircleConfig({ network: `x207:${CIRCLE_ID}`, circleContract: CIRCLE })], rpc, pending, signers: [registerKey.accountId] });
    const relayerCaller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: evmRelayerKey, onHash: (h) => note("relayer tx", h) });
    const relay = new EvmRelay({ circleContract: CIRCLE, maxDeadlineMs: 900_000, caller: relayerCaller });
    const listen = (fetchFn: (request: Request) => Response | Promise<Response>) =>
      new Promise<{ url: string; close: () => void }>((resolve) => {
        const server = serve({ fetch: fetchFn, port: 0, hostname: "127.0.0.1" }, ({ port }) => resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() }));
      });
    const facilitator = await listen(createApp(service, { evm: relay, rateLimit: false }).fetch);
    const seller = await listen(createSeller({ facilitatorUrl: facilitator.url, circleId: CIRCLE_ID, payTo: sellerKey.accountId }).fetch);
    const registration = new NearRegistrationChain({ rpc, circleContract: CIRCLE, relayer: registerKey });
    const scheduler = new RegistrationScheduler({ circleContract: CIRCLE, store: pending, log: () => {}, registerThreshold: 1n, chain: registration });

    const epochOf = async (n?: number): Promise<ContractAbi.EpochView> => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await chainView<ContractAbi.EpochView>("get_epoch", n === undefined ? {} : { epoch: n });
        } catch (error) {
          if (attempt >= 8) throw error;
          log("rpc", `get_epoch failed (${attempt}), trying again`);
          await sleep(10_000);
        }
      }
    };
    const agent = createEvmAgent({ privateKey: agentKey, relayerUrl: facilitator.url, circleContract: CIRCLE, rpcUrls: RPC_URLS });
    const resumeEpoch = process.env.RESUME_EPOCH ? Number(process.env.RESUME_EPOCH) : undefined;
    let n = resumeEpoch ?? 0;
    let paid: { status: number; x402: unknown } | undefined;
    if (resumeEpoch === undefined) {
      // 3. wait for an open epoch with time left (the keeper rolls the epochs)
      let epoch = await epochOf();
      for (;;) {
        const left = Number(BigInt(epoch.cutoff_at ?? 0) / 1_000_000n) - Date.now();
        if (epoch.phase === "open" && left > 300_000) break;
        log("wait", `epoch ${epoch.epoch} ${epoch.phase}, ${Math.round(left / 1000)} s to cutoff: waiting for a fresh open epoch`);
        await sleep(20_000);
        epoch = await epochOf();
      }
      n = epoch.epoch;
      log("epoch", `${n} open`);

      // 4. the agent joins, is admitted, is staked, and opts in to auto-settle
      log("agent", `address (member id) ${agent.id}`);
      let member = await chainView<ContractAbi.MemberView | null>("member", { account_id: agent.id });
      if (member?.status !== "active") {
        const joined = await agent.join(TERMS_HASH);
        note("join_evm", joined.txHash);
        await sleep(4_000);
        await admit(agent.id);
        const staked = await relayerCaller.call("ft_transfer_call", { receiver_id: CIRCLE, amount: STAKE, msg: JSON.stringify({ action: "stake", member_id: agent.id }) }, 1n, USDT);
        note("stake (relayer ft_transfer_call)", staked.hash);
        await sleep(4_000);
        member = await chainView<ContractAbi.MemberView | null>("member", { account_id: agent.id });
      }
      log("agent", `member status ${member?.status}, stake ${(member as { stake?: string } | null)?.stake}`);

      if (!(await chainView<boolean>("is_auto_settle", { account_id: agent.id }))) {
        const optIn = await agent.setAutoSettle(true);
        note("set_auto_settle_evm (enabled, relayer)", optIn.txHash);
        await sleep(4_000);
      }
      log("agent", `is_auto_settle ${await chainView<boolean>("is_auto_settle", { account_id: agent.id })}`);

      // 5. the agent pays the seller and does not pay back
      const response = await agent.payFetch()(`${seller.url}/api/summarize`);
      const settled = JSON.parse(Buffer.from(response.headers.get("PAYMENT-RESPONSE")!, "base64").toString("utf8"));
      log("paid call", `HTTP ${response.status}, ${JSON.stringify(settled.extensions?.x207)}`);
      if (!settled.success) throw new Error("the paid call was not settled");
      paid = { status: response.status, x402: settled.extensions?.x207 };
      const tick = await scheduler.tick();
      log("registration", JSON.stringify(tick));
      log("obligation", JSON.stringify(await chainView<ContractAbi.ObligationView | null>("obligation", { epoch: n, debtor: agent.id, creditor: sellerKey.accountId })));
    }

    // 6. the keeper closes, commits and finalizes; nobody pays the residual of the agent
    const waitFor = async (what: string, ok: (e: ContractAbi.EpochView) => boolean) => {
      for (;;) {
        const e = await epochOf(n);
        if (ok(e)) return e;
        log("wait", `${what}: epoch ${n} is ${e.phase}`);
        await sleep(30_000);
      }
    };
    const stakeBefore = BigInt(((await chainView<ContractAbi.MemberView | null>("member", { account_id: agent.id })) as { stake?: string } | null)?.stake ?? "0");
    const paying = await waitFor("commit", (e) => e.payment_deadline != null);
    log("epoch", `${n} ${paying.phase}, payment_deadline ${paying.payment_deadline}`);
    const positionBefore = await chainView<ContractAbi.PositionView | null>("net_position", { epoch: n, account_id: agent.id });
    log("agent position before finalize", JSON.stringify(positionBefore));
    await waitFor("finalize", (e) => e.phase === "finalized");
    log("epoch", `${n} finalized`);

    const memberAfter = (await chainView<ContractAbi.MemberView | null>("member", { account_id: agent.id })) as (ContractAbi.MemberView & { stake?: string }) | null;
    const positionAfter = await chainView<ContractAbi.PositionView | null>("net_position", { epoch: n, account_id: agent.id });
    const stakeAfter = BigInt(memberAfter?.stake ?? "0");
    log("agent after finalize", `status ${memberAfter?.status}, stake ${stakeBefore} -> ${stakeAfter}, position ${JSON.stringify(positionAfter)}`);

    const result = {
      circle: CIRCLE, epoch: n, agentAddress: agent.id, seller: sellerKey.accountId, evmRelayer: evmRelayerKey.accountId,
      paidCall: paid ?? "paid in the interrupted first part of the run (see the partial hashes)",
      positionBeforeFinalize: positionBefore, memberAfterFinalize: memberAfter, positionAfterFinalize: positionAfter,
      stakeBefore: stakeBefore.toString(), stakeAfter: stakeAfter.toString(), hashes,
      note: "Run by examples/evm-agent/test/evm-agent.autosettle.testnet.live.test.ts. Keeper transactions (close_epoch, commit_epoch, finalize_epoch) are in the journal of x207-keeper-v015 and in the explorer under the keeper account.",
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    log("result", out);
    pending.close();
    facilitator.close();
    seller.close();
  }, 3_600_000);
});
