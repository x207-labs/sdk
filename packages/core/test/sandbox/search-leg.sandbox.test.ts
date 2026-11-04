// SD-047 (interface 0.0.5) in near-sandbox: `search_leg` in the bundle terms. The contract computes `terms_hash` from the legs and `search_leg` itself,
// so `get_bundle.terms_hash` equal to the SDK's `termsHash(terms)` proves the canonical JSON bytes are the same. Skipped if the near-sandbox binary
// or the 0.0.5 contract wasm is missing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContractAbi, createCircleViewFn, onboardMember, signBundle, termsHash, type BundleTerms, type ContractCall } from "../../src/index.js";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../../test-support/circle.js";
import { sandboxAvailable } from "../../../../test-support/sandbox.js";

const CREDIT = 1_000_000n;

describe.skipIf(!sandboxAvailable)("SD-047 search_leg on near-sandbox", () => {
  let fx: CircleFixture;
  beforeAll(async () => {
    fx = await deployCircle();
  }, 300_000);
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-047-20 the contract terms_hash equals the SDK with and without search_leg; the seeker share limit and the signature over search_leg are enforced", async () => {
    expect(await fx.sandbox.view<string>(fx.circle.accountId, "interface_version", {})).toBe(ContractAbi.X207_CIRCLE_ABI_VERSION);
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
    const solver = await fx.sandbox.createAccount("solver", "20");
    const epoch = (await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {})).epoch;
    const commit = async (terms: BundleTerms, signedTerms: BundleTerms = terms) => {
      const signatures = [a, b, c].map((m) => {
        const s = signBundle(signedTerms, m.id, m.secretKey);
        return { account_id: s.account, signature: s.signature };
      });
      return solver.call(
        {
          receiverId: fx.circle.accountId, methodName: "commit_bundle", deposit: 0n, gas: 200_000_000_000_000n,
          args: { bundle: { epoch, legs: terms.legs, ...(terms.search_leg ? { search_leg: terms.search_leg } : {}) }, signatures },
        },
        "EXECUTED_OPTIMISTIC",
      );
    };
    const legs = (x: bigint, y: bigint, z: bigint) => [
      { payer: a.id, payee: b.id, max_amount: String(x * CREDIT) },
      { payer: b.id, payee: c.id, max_amount: String(y * CREDIT) },
      { payer: c.id, payee: a.id, max_amount: String(z * CREDIT) },
    ];
    const search = { payer: c.id, payee: a.id };
    const base = { circle: fx.circle.accountId, epoch };

    // 6 of 101 credit passes the default limit of 500 bps
    const over = await commit({ ...base, legs: legs(55n, 40n, 6n), search_leg: search });
    expect(over.failures.join(" ")).toContain("ERR_SEARCH_SHARE_EXCEEDED");
    // a search_leg that is not a leg: the SDK rejects it before signing, so send it raw; the contract rejects it before checking signatures
    expect(() => termsHash({ ...base, legs: legs(55n, 40n, 5n), search_leg: { payer: a.id, payee: c.id } })).toThrow(/search_leg/);
    const stranger = await solver.call(
      {
        receiverId: fx.circle.accountId, methodName: "commit_bundle", deposit: 0n, gas: 200_000_000_000_000n,
        args: { bundle: { epoch, legs: legs(55n, 40n, 5n), search_leg: { payer: a.id, payee: c.id } }, signatures: [] },
      },
      "EXECUTED_OPTIMISTIC",
    );
    expect(stranger.failures.join(" ")).toContain("ERR_BAD_BUNDLE");
    // participants sign the terms without search_leg, the contract computes the hash with search_leg: signature does not match
    const unsigned = await commit({ ...base, legs: legs(55n, 40n, 5n), search_leg: search }, { ...base, legs: legs(55n, 40n, 5n) });
    expect(unsigned.failures.join(" ")).toContain("ERR_BUNDLE_SIGNATURES");

    // exactly 500 bps: accepted, and the hash stored by the contract equals the SDK hash
    const withSearch: BundleTerms = { ...base, legs: legs(55n, 40n, 5n), search_leg: search };
    const ok = await commit(withSearch);
    expect(ok.failures).toEqual([]);
    const stored = await fx.sandbox.view<ContractAbi.BundleView | null>(fx.circle.accountId, "get_bundle", { bundle_id: 1 });
    expect(stored?.terms_hash).toBe(termsHash(withSearch));

    // without search_leg the bytes do not change from the old format; other legs so the hash differs
    const plain: BundleTerms = { ...base, legs: legs(10n, 10n, 10n) };
    expect((await commit(plain)).failures).toEqual([]);
    const storedPlain = await fx.sandbox.view<ContractAbi.BundleView | null>(fx.circle.accountId, "get_bundle", { bundle_id: 2 });
    expect(storedPlain?.terms_hash).toBe(termsHash(plain));
    expect(termsHash({ ...plain, search_leg: null })).toBe(termsHash(plain));
  }, 600_000);
});
