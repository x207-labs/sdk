// SD-048 di near-sandbox: bundle F5 A -> B -> C -> A di-commit, voucher leg diperiksa facilitator terhadap batas leg lalu didaftarkan
// scheduler lewat register_in_bundle dengan headroom cadangan. Lewati bila binary near-sandbox atau wasm kontrak 0.0.4 tidak ada.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCircleViewFn, onboardMember, signBundle, signVoucher, termsHash, type BundleTerms, type ContractAbi, type ContractCall,
} from "@x207/core";
import { X207SchemeFacilitator } from "@x207/scheme";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { sandboxAvailable, type SandboxAccount } from "../../../test-support/sandbox.js";
import { NearChain } from "../src/chain.js";
import { PendingStore } from "../src/pending-store.js";
import { NearRegistrationChain } from "../src/relay.js";
import { NearRpc } from "../src/rpc.js";
import { RegistrationScheduler } from "../src/scheduler.js";

const CREDIT = 1_000_000n;

describe.skipIf(!sandboxAvailable)("SD-048 voucher leg bundle di near-sandbox", () => {
  let fx: CircleFixture;
  let relayer: SandboxAccount;
  beforeAll(async () => {
    fx = await deployCircle();
    relayer = await fx.sandbox.createAccount("relayer", "20");
  }, 300_000);
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-048-12 a valid leg is registered from reserve headroom; exceeding the leg is rejected by verify and the contract", async () => {
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
      return { account, secretKey: joined.secretKey };
    };
    const [a, b, c] = [await onboard("translator"), await onboard("summarizer"), await onboard("scraper")];
    const epoch = (await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {})).epoch;
    const headroom = async (m: { account: SandboxAccount }) => BigInt(await fx.sandbox.view<string>(fx.circle.accountId, "headroom", { account_id: m.account.accountId }));
    const freeBefore = await headroom(a);

    // Bundle: a -> b 30, b -> c 20, c -> a 25 credit; ketiganya menandatangani terms_hash
    const terms: BundleTerms = {
      circle: fx.circle.accountId, epoch,
      legs: [
        { payer: a.account.accountId, payee: b.account.accountId, max_amount: String(30n * CREDIT) },
        { payer: b.account.accountId, payee: c.account.accountId, max_amount: String(20n * CREDIT) },
        { payer: c.account.accountId, payee: a.account.accountId, max_amount: String(25n * CREDIT) },
      ],
    };
    const signatures = [a, b, c].map((m) => {
      const s = signBundle(terms, m.account.accountId, m.secretKey);
      return { account_id: s.account, signature: s.signature };
    });
    const committed = await relayer.call(
      { receiverId: fx.circle.accountId, methodName: "commit_bundle", args: { bundle: { epoch, legs: terms.legs }, signatures }, deposit: 0n, gas: 200_000_000_000_000n },
      "EXECUTED_OPTIMISTIC",
    );
    expect(committed.failures).toEqual([]);
    const stored = await fx.sandbox.view<ContractAbi.BundleView | null>(fx.circle.accountId, "get_bundle", { bundle_id: 1 });
    expect(stored).toMatchObject({ bundle_id: 1, epoch, terms_hash: termsHash(terms), status: "active" });
    // headroom bebas a berkurang sebesar cadangan leg-nya
    expect(await headroom(a)).toBe(freeBefore - 30n * CREDIT);

    const rpc = new NearRpc({ urls: [fx.sandbox.rpcUrl], timeoutMs: 30_000 });
    const circle = { network: "x207:agents-main", circleContract: fx.circle.accountId } as const;
    const pending = new PendingStore(":memory:");
    const nearChain = new NearChain(rpc, circle as never, pending);
    // NearRpc membaca blok final; tunggu bundle yang baru di-commit terlihat di sana (sebelumnya verify menjawab bundle_unknown)
    for (let i = 0; i < 60 && !(await nearChain.bundle(1)); i++) await new Promise((r) => setTimeout(r, 1_000));
    expect(await nearChain.bundle(1)).not.toBeNull();
    const facilitator = new X207SchemeFacilitator({ network: circle.network, circleContract: circle.circleContract, verify: { chain: nearChain } });
    const voucherPayload = (cumulative: bigint, bundleId?: number) => {
      const unsigned = { circle: fx.circle.accountId, payer: a.account.accountId, payee: b.account.accountId, epoch, seq: 1, cumulativeAmount: cumulative.toString(), unit: "credit" as const, resource: "https://seller.example/api" };
      const { signature, ...voucher } = signVoucher(unsigned, a.secretKey);
      const requirements = {
        scheme: "batch-settlement", network: circle.network, amount: cumulative.toString(), asset: "USD", payTo: b.account.accountId, maxTimeoutSeconds: 60,
        extra: { circleContract: fx.circle.accountId, unit: "credit", decimals: 6, epoch },
      };
      return { payload: { x402Version: 2, resource: { url: unsigned.resource }, accepted: requirements, payload: { voucher, signature, ...(bundleId === undefined ? {} : { bundleId }) } } as never, requirements: requirements as never, voucher, signature };
    };

    // verify memakai batas leg: 40 > 30 ditolak; 30 lolos
    const tooBig = voucherPayload(40n * CREDIT, 1);
    expect(await facilitator.verify(tooBig.payload, tooBig.requirements)).toMatchObject({ isValid: false, invalidReason: "bundle_leg_exceeded" });
    const fits = voucherPayload(30n * CREDIT, 1);
    expect(await facilitator.verify(fits.payload, fits.requirements)).toEqual({ isValid: true, payer: a.account.accountId });

    // scheduler mendaftarkan lewat register_in_bundle; headroom bebas tidak berubah
    const logs: string[][] = [];
    pending.upsert(fx.circle.accountId, fits.voucher, fits.signature, 1);
    const scheduler = new RegistrationScheduler({
      circleContract: fx.circle.accountId, store: pending, log: () => {},
      chain: new NearRegistrationChain({ rpc, circleContract: fx.circle.accountId, relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey }, onLogs: (l) => logs.push(l) }),
      registerThreshold: 1n,
    });
    expect(await scheduler.tick()).toMatchObject({ registered: 1, dropped: 0, retrying: 0 });
    const obligation = await fx.sandbox.view<ContractAbi.ObligationView>(fx.circle.accountId, "obligation", { epoch, debtor: a.account.accountId, creditor: b.account.accountId });
    expect(obligation.cumulative).toBe(String(30n * CREDIT));
    const after = await fx.sandbox.view<ContractAbi.BundleView>(fx.circle.accountId, "get_bundle", { bundle_id: 1 });
    expect(after.legs.find((l) => l.payer === a.account.accountId)?.registered).toBe(String(30n * CREDIT));
    expect(await headroom(a)).toBe(freeBefore - 30n * CREDIT);

    // kontrak juga menolak voucher di atas batas leg bila facilitator dilewati
    const direct = voucherPayload(40n * CREDIT, 1);
    const stale = signVoucher({ ...direct.voucher, seq: 2 }, a.secretKey);
    const { signature: sig2, ...v2 } = stale;
    const refused = await relayer.call(
      { receiverId: fx.circle.accountId, methodName: "register_in_bundle", args: { bundle_id: 1, voucher: v2, signature: sig2 }, deposit: 0n, gas: 100_000_000_000_000n },
      "EXECUTED_OPTIMISTIC",
    );
    expect(refused.failures.join(" ")).toContain("ERR_BUNDLE_LEG_EXCEEDED");
    pending.close();
  }, 600_000);
});
