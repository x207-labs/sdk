// SD-031 on near-sandbox (neard 2.13.4, protocol 86): a relayer with a gas key sends several register_cumulative in parallel on different nonce lanes.
// The gas key is attached to the relayer account and funded; four pairs are registered at the same time by the scheduler (concurrency 4), all succeed,
// and the nonce of each lane used goes up. Skipped if the near-sandbox binary or the contract wasm is missing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import { createCircleViewFn, onboardMember, signVoucher, type ContractAbi, type ContractCall } from "@x207/core";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { sandboxAvailable } from "../../../test-support/sandbox.js";
import { PendingStore } from "../src/pending-store.js";
import { NearRegistrationChain } from "../src/relay.js";
import { NearRpc } from "../src/rpc.js";
import { RegistrationScheduler } from "../src/scheduler.js";

const LANES = 4;

describe.skipIf(!sandboxAvailable)("SD-031 gas key relayer on near-sandbox", () => {
  let fx: CircleFixture;
  beforeAll(async () => {
    fx = await deployCircle();
  }, 300_000);
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-031-08 four parallel registrations on four lanes without a nonce conflict", async () => {
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
    const onboard = async (name: string) => {
      const account = await fx.member(name);
      const joined = await onboardMember(
        {
          sendCall: async (c: ContractCall) => {
            const r = await account.call(c);
            if (r.failures.length > 0) throw new Error(r.failures.join("; "));
            return r.value;
          },
          view, pollIntervalMs: 200, timeoutMs: 30_000,
        },
        { circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: account.accountId, termsHash: TERMS_HASH, stakeAmount: "100000000", usdtTokenId: fx.usdt.accountId },
      );
      return { id: account.accountId, secretKey: joined.secretKey };
    };
    const [a, b, c] = [await onboard("translator"), await onboard("summarizer"), await onboard("scraper")];
    const epoch = (await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {})).epoch;

    // relayer with a 4-lane gas key, funded
    const relayer = await fx.sandbox.createAccount("relayer", "20");
    const gasKey = KeyPair.fromRandom("ed25519");
    await relayer.account.addFullAccessGasKey(gasKey.getPublicKey(), LANES);
    await relayer.account.transferToGasKey(relayer.accountId, gasKey.getPublicKey(), 10n ** 24n);
    const lanesNow = async () =>
      (
        (await (
          await fetch(fx.sandbox.rpcUrl, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_gas_key_nonces", finality: "optimistic", account_id: relayer.accountId, public_key: gasKey.getPublicKey().toString() } }),
          })
        ).json()) as { result: { nonces: Array<number | string> } }
      ).result.nonces.map(Number);
    const before = await lanesNow();
    expect(before).toHaveLength(LANES);

    const store = new PendingStore(":memory:");
    const pairs = [[a, b], [b, a], [a, c], [c, b]] as const;
    for (const [payer, payee] of pairs) {
      const { signature, ...voucher } = signVoucher(
        { circle: fx.circle.accountId, payer: payer.id, payee: payee.id, epoch, seq: 1, cumulativeAmount: "2000000", unit: "credit", resource: "https://s.example/api" },
        payer.secretKey,
      );
      store.upsert(fx.circle.accountId, voucher, signature);
    }
    const chain = new NearRegistrationChain({
      rpc: new NearRpc({ urls: [fx.sandbox.rpcUrl], timeoutMs: 30_000 }), circleContract: fx.circle.accountId,
      relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey },
      gasKey: { privateKey: gasKey.toString(), lanes: LANES },
    });
    expect(chain.concurrency).toBe(LANES);
    const scheduler = new RegistrationScheduler({ circleContract: fx.circle.accountId, store, chain, concurrency: chain.concurrency, log: () => {} });
    const result = await scheduler.tick();
    expect(result).toMatchObject({ registered: 4, retrying: 0, dropped: 0 });
    expect(store.listOpen(fx.circle.accountId)).toEqual([]);

    for (const [payer, payee] of pairs) {
      const edge = await fx.sandbox.view<{ cumulative: string; last_seq: number }>(fx.circle.accountId, "obligation", { epoch, debtor: payer.id, creditor: payee.id });
      expect(edge).toMatchObject({ cumulative: "2000000", last_seq: 1 });
    }
    // four parallel transactions use four different lanes: the nonce of each lane goes up
    const after = await lanesNow();
    expect(after.filter((n, i) => n > before[i]!)).toHaveLength(LANES);
    store.close();
  }, 300_000);
});
