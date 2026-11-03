// SD-048: voucher leg bundle F5. Bytes voucher sama dengan voucher biasa; `bundleId` di payload membuat facilitator memeriksa batas leg
// D8 (`get_bundle`) alih-alih headroom bebas, dan klien memilih x207 walau headroom bebas habis.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { signVoucher, validateX207Payload, type ContractAbi, type UnsignedVoucher } from "@x207/core";
import { HeadroomEstimator, X207SchemeClient, X207SchemeFacilitator, computeHeadroom, selectX207Requirements, type VerifyChain } from "@x207/scheme";

const keys = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8")).keys;
const seed = (name: string) => Buffer.from(keys[name].seed, "hex");
const CIRCLE = "x207-circle.near";
const A = "a.x207-circle.near";
const B = "b.x207-circle.near";
const C = "c.x207-circle.near";
const NETWORK = "x207:agents-main";
const NOW = 1_793_836_800_000;

const member = (account: string, key: string): ContractAbi.MemberView => ({
  account_id: account, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 42, limit: "100000000",
  pubkey_voucher: keys[key].publicKey, settled_history: "0", stake: "100000000", status: "active", terms_hash: "0".repeat(64),
});
const bundle = (over: Partial<ContractAbi.BundleView> = {}): ContractAbi.BundleView => ({
  bundle_id: 7, epoch: 42, status: "active", terms_hash: "f".repeat(64),
  legs: [{ payer: A, payee: B, max_amount: "100000000", registered: "0" }, { payer: B, payee: C, max_amount: "60000000", registered: "0" }],
  ...over,
});

function chain(over: { bundles?: Record<number, ContractAbi.BundleView | null>; headroom?: string; noBundleView?: boolean } = {}): VerifyChain {
  const epoch = { epoch: 42, cutoff_at: String(BigInt(NOW + 3_600_000) * 1_000_000n), phase: "open" } as unknown as ContractAbi.EpochView;
  return {
    member: async (a) => ({ [A]: member(A, "kA"), [B]: member(B, "kB"), [C]: member(C, "kOther") })[a] ?? null,
    getEpoch: async () => epoch,
    headroom: async () => over.headroom ?? "0",
    obligation: async () => null,
    pendingByPayer: async () => [],
    ...(over.noBundleView ? {} : { bundle: async (id: number) => (over.bundles ?? { 7: bundle() })[id] ?? null }),
  };
}

const requirements = (amount: string): PaymentRequirements => ({
  scheme: "batch-settlement", network: NETWORK, amount, asset: "USD", payTo: B, maxTimeoutSeconds: 60,
  extra: { circleContract: CIRCLE, unit: "credit", decimals: 6, epoch: 42 },
}) as PaymentRequirements;

function payload(cumulative: string, bundleId?: number) {
  const unsigned: UnsignedVoucher = { circle: CIRCLE, payer: A, payee: B, epoch: 42, seq: 1, cumulativeAmount: cumulative, unit: "credit", resource: "https://seller.example/api" };
  const { signature, ...voucher } = signVoucher(unsigned, seed("kA"));
  const reqs = requirements(cumulative);
  return { x402Version: 2, resource: { url: unsigned.resource }, accepted: reqs, payload: { voucher, signature, ...(bundleId === undefined ? {} : { bundleId }) } } as any;
}
const verify = (c: VerifyChain, cumulative: string, bundleId?: number) =>
  new X207SchemeFacilitator({ network: NETWORK, circleContract: CIRCLE, verify: { chain: c, now: () => NOW } }).verify(payload(cumulative, bundleId), requirements(cumulative));

describe("SD-048 verify voucher leg bundle", () => {
  it("TC-SD-048-01 a valid leg passes even with zero free headroom, and the same voucher without a bundle is rejected", async () => {
    expect(await verify(chain({ headroom: "0" }), "100000000", 7)).toEqual({ isValid: true, payer: A });
    expect(await verify(chain({ headroom: "0" }), "100000000")).toMatchObject({ isValid: false, invalidReason: "insufficient_credit" });
  });

  it("TC-SD-048-02 exceeding the leg limit is rejected", async () => {
    expect(await verify(chain(), "100000001", 7)).toMatchObject({ isValid: false, invalidReason: "bundle_leg_exceeded", payer: A });
  });

  it("TC-SD-048-03 unknown bundle, other epoch, not active, pair is not a leg", async () => {
    expect(await verify(chain({ bundles: {} }), "20000000", 7)).toMatchObject({ invalidReason: "bundle_unknown" });
    expect(await verify(chain({ bundles: { 7: bundle({ epoch: 41 }) } }), "20000000", 7)).toMatchObject({ invalidReason: "bundle_epoch_mismatch" });
    expect(await verify(chain({ bundles: { 7: bundle({ status: "settled" as "active" }) } }), "20000000", 7)).toMatchObject({ invalidReason: "bundle_epoch_mismatch" });
    const other = bundle({ legs: [{ payer: B, payee: C, max_amount: "60000000", registered: "0" }] });
    expect(await verify(chain({ bundles: { 7: other } }), "20000000", 7)).toMatchObject({ invalidReason: "not_a_bundle_leg" });
  });

  it("TC-SD-048-04 a chain without a bundle view throws instead of passing silently", async () => {
    await expect(verify(chain({ noBundleView: true }), "20000000", 7)).rejects.toThrow(/VerifyChain\.bundle/);
  });

  it("TC-SD-048-05 payload schema: bundleId must be an integer >= 0", () => {
    const ok = payload("20000000", 7).payload;
    expect(validateX207Payload(ok).ok).toBe(true);
    for (const bad of ["7", -1, 1.5]) expect(validateX207Payload({ ...ok, bundleId: bad }).ok).toBe(false);
  });

  it("TC-SD-048-06 a pending bundle leg does not reduce free headroom", async () => {
    const sources = {
      headroom: async () => "50000000",
      obligation: async () => null,
      pendingByPayer: async () => [
        { payee: B, seq: 1, cumulativeAmount: "40000000", bundleId: 7 },
        { payee: C, seq: 1, cumulativeAmount: "5000000", bundleId: null },
      ],
    };
    expect(await computeHeadroom(A, 42, sources)).toBe("45000000");
  });
});

describe("SD-048 klien", () => {
  const unsignedFor = (client: X207SchemeClient, amount = "20000") =>
    (async () => {
      const reqs = requirements(amount);
      await client.schemeHooks.onBeforePaymentCreation?.({ selectedRequirements: reqs, paymentRequired: { resource: { url: "https://seller.example/api" } } } as any);
      return (await client.createPaymentPayload(2, reqs)).payload as any;
    })();

  it("TC-SD-048-07 the payload carries bundleId for a leg and not for a normal payment; voucher bytes are the same", async () => {
    const leg = new X207SchemeClient({ payer: A, secretKey: seed("kA"), bundleFor: (payee, epoch) => (payee === B && epoch === 42 ? 7 : undefined) });
    const plain = new X207SchemeClient({ payer: A, secretKey: seed("kA") });
    const withBundle = await unsignedFor(leg);
    const without = await unsignedFor(plain);
    expect(withBundle.bundleId).toBe(7);
    expect("bundleId" in without).toBe(false);
    expect(withBundle.voucher).toEqual(without.voucher);
    expect(withBundle.signature).toBe(without.signature);
  });

  it("TC-SD-048-08 selection picks x207 for a leg even when free headroom is used up", async () => {
    const estimator = new HeadroomEstimator({ payer: A, source: async () => "0", now: () => NOW });
    await estimator.ensureFresh(CIRCLE);
    const exact = { ...requirements("20000"), scheme: "exact", network: "near:mainnet", extra: {} } as PaymentRequirements;
    const accepts = [requirements("20000"), exact];
    expect(selectX207Requirements(estimator)(2, accepts).scheme).toBe("exact");
    expect(selectX207Requirements(estimator, (payee) => (payee === B ? 7 : undefined))(2, accepts).scheme).toBe("batch-settlement");
    expect(selectX207Requirements(estimator, (payee) => (payee === C ? 7 : undefined))(2, accepts).scheme).toBe("exact");
  });
});
