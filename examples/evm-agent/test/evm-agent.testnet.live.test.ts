// SD-090: one run of the EVM agent on NEAR testnet against the circle x207-v014.testnet, with the real clock. It mirrors the sandbox test (test/evm-agent.sandbox.test.ts):
//   1. a seller (native member) joins and stakes; 2. the agent, which has only a new 0x key, joins through the relayer (the relayer stakes mock USDT for it);
//   3. the agent pays the seller through x402 with an EIP-712 voucher and the voucher is registered on chain; 4. the seller owes the agent more (a native voucher);
//   5. the epoch closes and commits (the keeper does it), the seller pays what it owes, the keeper finalizes; 6. the agent claims with a signature only.
// Every transaction hash goes to stdout and to the result file. No key is printed: the keys are read from files and the agent key is made once and kept in a file (mode 600).
//
//   X207_TESTNET=1 X207_SECRETS=/path/to/.secrets npx vitest run examples/evm-agent/test/evm-agent.testnet.live.test.ts       (from sdk/; the keeper of x207-v014.testnet must run)
//
// Files read under $X207_SECRETS/testnet-demo/testnet: x207-demo-helper.testnet.json (the EVM relayer: gas, join deposit, mock USDT for the stake), x207-demo-helper-reg.json (a second key of the
// same account for the registration relayer, so the two do not share a nonce), x207-demo-seller.testnet.json (the seller). The agent key is $X207_SECRETS/testnet-demo/evm-agent-v014.key.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { serve } from "@hono/node-server";
import { generatePrivateKey } from "viem/accounts";
import {
  buildJoinCall, buildSettleTransferCall, buildStakeTransferCall, createCircleViewFn, generateVoucherKeypair, signVoucher, voucherPublicKey, type ContractAbi, type ContractCall, type UnsignedVoucher,
} from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import {
  EvmRelay, NearContractCaller, NearRegistrationChain, NearRpc, PendingStore, RegistrationScheduler, createApp, createFacilitatorService,
} from "../../../apps/facilitator/src/index.js";
import { createSeller } from "../../seller/src/seller.js";
import { createEvmAgent } from "../src/agent.js";

const CIRCLE = "x207-v014.testnet";
const CIRCLE_ID = "agents-main";
const USDT = "usdt.x207-deployer.testnet";
const DAO = "x207v8.sputnikv2.testnet"; // owner of the circle; admission is `dao`, so every member needs a council vote before its stake is accepted
// where the agent wants its payout: by default the eth-implicit NEAR account that has the same 0x address as the agent (so the 0x key itself receives it); WALLET_ACCOUNT overrides
const TERMS_HASH = "a".repeat(64); // terms hash of the testnet circles
const STAKE = "50000000"; // 50 mock USDT
const RPC_URLS = ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"];
const secrets = process.env.X207_SECRETS ?? join(process.cwd(), "../../../.secrets");
const demoDir = join(secrets, "testnet-demo");
const out = process.env.RESULT_FILE ?? join(process.cwd(), "../docs/testnet-epochs/sd090-evm-agent-run.json");

const keyFile = (name: string): { accountId: string; privateKey: string } => {
  const f = JSON.parse(readFileSync(join(demoDir, "testnet", name), "utf8")) as { account_id: string; secret_key: string };
  return { accountId: f.account_id, privateKey: f.secret_key };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const partialFile = `${out}.partial`;
// an interrupted run keeps its hashes in the partial file and the next run continues from the chain state (members stay joined, admitted and staked)
const hashes: Record<string, string> = existsSync(partialFile) ? (JSON.parse(readFileSync(partialFile, "utf8")) as Record<string, string>) : {};
const log = (step: string, detail: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${step}: ${detail}`);
const note = (name: string, hash: string | undefined) => {
  if (hash) {
    if (hashes[name] !== undefined && hashes[name] !== hash) name = `${name} (${Object.keys(hashes).filter((k) => k.startsWith(name)).length + 1})`; // two calls of one method keep both hashes
    hashes[name] = hash;
    mkdirSync(dirname(partialFile), { recursive: true });
    writeFileSync(partialFile, JSON.stringify(hashes, null, 2));
    log(name, hash);
  }
};


const keyFileGuard = (): boolean => process.env.X207_TESTNET === "1";

describe.skipIf(!keyFileGuard())("SD-090 EVM agent on NEAR testnet (x207-v014.testnet)", () => {
  it("TC-SD-090-06 join with the relayer, paid call with eip712, registration, finalized epoch, claim; the hashes go to the result file", async () => {
    // the agent key: made once, kept in a file, never printed
    const agentKeyPath = join(demoDir, "evm-agent-v014.key");
    if (!existsSync(agentKeyPath)) {
      mkdirSync(dirname(agentKeyPath), { recursive: true });
      writeFileSync(agentKeyPath, generatePrivateKey(), { mode: 0o600 });
      chmodSync(agentKeyPath, 0o600);
    }
    const agentKey = readFileSync(agentKeyPath, "utf8").trim();

    const evmRelayerKey = keyFile("x207-demo-helper.testnet.json");
    const registerKey = keyFile("x207-demo-helper-reg.json");
    const sellerKey = keyFile("x207-demo-seller.testnet.json");
    // the two council members of the DAO that owns the circle (their keys are in the secrets folder of the deployer)
    const deployerDir = join(secrets, "testnet-deployer");
    const councilA = { accountId: "x207-dao-v8.testnet", privateKey: (JSON.parse(readFileSync(join(deployerDir, "x207-dao-v8.testnet.json"), "utf8")) as { private_key: string }).private_key };
    const councilB = { accountId: "b.x207-dao-v8.testnet", privateKey: (JSON.parse(readFileSync(join(deployerDir, "dao-v8.json"), "utf8")) as { b: string }).b };

    const rpc = new NearRpc({ urls: RPC_URLS, timeoutMs: 30_000 });
    const view = createCircleViewFn({ circleContract: CIRCLE, rpcUrls: RPC_URLS });
    const chainView = <T>(method: string, args: object = {}) => view(method as never, args as never) as Promise<T>;
    const ftBalance = async (id: string): Promise<bigint> => {
      const r = await rpc.call<{ result: number[] }>("query", { request_type: "call_function", finality: "final", account_id: USDT, method_name: "ft_balance_of", args_base64: Buffer.from(JSON.stringify({ account_id: id })).toString("base64") });
      return BigInt(JSON.parse(Buffer.from(r.result).toString()) as string);
    };

    const sellerCaller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: sellerKey });
    const sendFromSeller = async (call: ContractCall) => {
      const { hash } = await sellerCaller.call(call.methodName, call.args as Record<string, unknown>, call.deposit, call.receiverId, call.gas);
      note(`seller ${call.methodName}`, hash);
      return undefined;
    };

    const rpcForDao = new NearRpc({ urls: RPC_URLS, timeoutMs: 30_000 });
    const callerA = new NearContractCaller({ rpc: rpcForDao, circleContract: DAO, account: councilA });
    const callerB = new NearContractCaller({ rpc: rpcForDao, circleContract: DAO, account: councilB });
    const daoView = async <T>(method: string, args: object): Promise<T> => {
      const r = await rpcForDao.call<{ result: number[] }>("query", { request_type: "call_function", finality: "final", account_id: DAO, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
      return JSON.parse(Buffer.from(r.result).toString()) as T;
    };
    /** Admission is `dao`: a council proposal calls `admit_member`, both council members vote approve, and the DAO runs it. */
    const admit = async (account: string): Promise<void> => {
      if ((await chainView<ContractAbi.MemberView & { admitted?: boolean }>("member", { account_id: account })).admitted) return;
      const args = Buffer.from(JSON.stringify({ account_id: account })).toString("base64");
      const proposal = await callerA.call(
        "add_proposal",
        { proposal: { description: `Admit ${account} to the x207 circle (SD-090)`, kind: { FunctionCall: { receiver_id: CIRCLE, actions: [{ method_name: "admit_member", args, deposit: "0", gas: "30000000000000" }] } } } },
        100_000_000_000_000_000_000_000n, DAO,
      );
      note(`dao add_proposal admit ${account}`, proposal.hash);
      const id = (await daoView<number>("get_last_proposal_id", {})) - 1;
      for (const [who, c] of [["a", callerA], ["b", callerB]] as const) {
        const vote = await c.call("act_proposal", { id, action: "VoteApprove" }, 0n, DAO, 200_000_000_000_000n).catch((e: Error) => ({ hash: `skipped: ${e.message.slice(0, 80)}` }));
        note(`dao vote ${who} #${id}`, vote.hash);
        if ((await chainView<ContractAbi.MemberView & { admitted?: boolean }>("member", { account_id: account })).admitted) break;
      }
      for (let i = 0; i < 10; i += 1) {
        if ((await chainView<ContractAbi.MemberView & { admitted?: boolean }>("member", { account_id: account })).admitted) return;
        await sleep(3_000);
      }
      throw new Error(`${account} is not admitted after the votes`);
    };

    // 1. the seller is a native member of the circle (a voucher key of its own, kept in a file)
    const sellerVoucherPath = join(demoDir, "v014-seller-voucher.key");
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

    // 2. facilitator with the EVM relayer routes and the seller, on this machine, with the real clock
    const pending = new PendingStore(":memory:");
    const service = createFacilitatorService({ circles: [defineCircleConfig({ network: `x207:${CIRCLE_ID}`, circleContract: CIRCLE })], rpc, pending, signers: [registerKey.accountId] });
    const relayerCaller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: evmRelayerKey, onHash: (h) => note("relayer tx", h) });
    const relay = new EvmRelay({
      circleContract: CIRCLE, maxDeadlineMs: 900_000, // no `stake` option: with admission `dao` the relayer stakes after the council has admitted the member
      caller: relayerCaller,
    });
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
    // RESUME_EPOCH=<n>: an interrupted run (for example an RPC outage) continues at step 5 for an epoch whose vouchers are already registered
    const resumeEpoch = process.env.RESUME_EPOCH ? Number(process.env.RESUME_EPOCH) : undefined;
    let n = resumeEpoch ?? 0;
    let paid: { status: number; x402: unknown } | undefined;
    if (resumeEpoch === undefined) {
      // 3. wait for an open epoch with time left (the keeper rolls the epochs)
      let epoch = await epochOf();
      for (;;) {
        const left = Number(BigInt(epoch.cutoff_at ?? 0) / 1_000_000n) - Date.now();
        if (epoch.phase === "open" && left > 240_000) break;
        log("wait", `epoch ${epoch.epoch} ${epoch.phase}, ${Math.round(left / 1000)} s to cutoff: waiting for a fresh open epoch`);
        await sleep(20_000);
        epoch = await epochOf();
      }
      n = epoch.epoch;
      log("epoch", `${n} open`);

      // 4. the agent joins, pays, and is paid back by the seller
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
      log("agent", `member status ${member?.status}`);

      const response = await agent.payFetch()(`${seller.url}/api/summarize`);
      const settled = JSON.parse(Buffer.from(response.headers.get("PAYMENT-RESPONSE")!, "base64").toString("utf8"));
      log("paid call", `HTTP ${response.status}, ${JSON.stringify(settled.extensions?.x207)}`);
      if (!settled.success) throw new Error("the paid call was not settled");
      paid = { status: response.status, x402: settled.extensions?.x207 };
      const tick = await scheduler.tick();
      log("registration", JSON.stringify(tick));
      const obligation = await chainView<ContractAbi.ObligationView | null>("obligation", { epoch: n, debtor: agent.id, creditor: sellerKey.accountId });
      log("obligation", JSON.stringify(obligation));

      const back: UnsignedVoucher = { circle: CIRCLE, payer: sellerKey.accountId, payee: agent.id, epoch: n, seq: 1, cumulativeAmount: "100000", unit: "credit", resource: "https://agent.example/api" };
      const backTx = await registration.register(back, signVoucher(back, sellerVoucherKey).signature, "cumulative");
      log("seller voucher registered", JSON.stringify(backTx));

    }

    // 5. the epoch: the keeper closes and commits; the seller pays what it owes; the keeper finalizes
    const waitFor = async (what: string, ok: (e: ContractAbi.EpochView) => boolean) => {
      for (;;) {
        const e = await epochOf(n);
        if (ok(e)) return e;
        log("wait", `${what}: epoch ${n} is ${e.phase}`);
        await sleep(30_000);
      }
    };
    const paying = await waitFor("commit", (e) => e.payment_deadline != null);
    log("epoch", `${n} ${paying.phase}, payment_deadline ${paying.payment_deadline}`);
    const position = await chainView<ContractAbi.PositionView | null>("net_position", { epoch: n, account_id: sellerKey.accountId });
    log("seller position", JSON.stringify(position));
    if (position?.role === "debtor" && position.status === "due") {
      await sendFromSeller(buildSettleTransferCall({ circleContract: CIRCLE, amount: position.amount, epoch: n, usdtTokenId: USDT }));
    }
    await waitFor("finalize", (e) => e.phase === "finalized");
    log("epoch", `${n} finalized`);

    // 6. the agent claims with a signature only; the payout goes to the NEAR wallet
    const WALLET = process.env.WALLET_ACCOUNT ?? agent.id;
    // NEP-145: register the wallet on the mock USDT first (the relayer pays; the mock charges nothing, a real token would take 0.00125 NEAR)
    const registered = await relayerCaller.call("storage_deposit", { account_id: WALLET, registration_only: true }, 1_250_000_000_000_000_000_000n, USDT);
    note("storage_deposit (relayer, for the payout account)", registered.hash);
    const before = await ftBalance(WALLET);
    const claimed = await agent.claim(n, WALLET);
    note("claim_evm", claimed.txHash);
    await sleep(5_000);
    const after = await ftBalance(WALLET);
    log("payout", `${WALLET} received ${after - before} (smallest unit) of mock USDT`);

    const result = {
      circle: CIRCLE, epoch: n, agentAddress: agent.id, seller: sellerKey.accountId, evmRelayer: evmRelayerKey.accountId, wallet: WALLET,
      paidCall: paid ?? "paid in the interrupted first part of the run (see the partial hashes)", payout: (after - before).toString(), hashes,
      note: "Run by examples/evm-agent/scripts/testnet-run.ts. Keeper transactions (close_epoch, commit_epoch, finalize_epoch) are in the journal of x207-keeper-v014 and in the explorer under the keeper account.",
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    log("result", out);
    pending.close();
    facilitator.close();
    seller.close();
  }, 4_000_000);
});
