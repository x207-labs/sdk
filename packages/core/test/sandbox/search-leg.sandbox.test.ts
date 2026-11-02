// SD-047 (interface 0.0.5) di near-sandbox: `search_leg` di syarat bundle. Kontrak menghitung `terms_hash` dari legs dan `search_leg` sendiri,
// jadi `get_bundle.terms_hash` sama dengan `termsHash(terms)` dari SDK membuktikan byte JSON kanoniknya sama. Lewati bila binary near-sandbox
// atau wasm kontrak 0.0.5 tidak ada.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCircleViewFn, onboardMember, signBundle, termsHash, type BundleTerms, type ContractAbi, type ContractCall } from "../../src/index.js";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../../test-support/circle.js";
import { sandboxAvailable } from "../../../../test-support/sandbox.js";

const CREDIT = 1_000_000n;

describe.skipIf(!sandboxAvailable)("SD-047 search_leg di near-sandbox", () => {
  let fx: CircleFixture;
  beforeAll(async () => {
    fx = await deployCircle();
  }, 300_000);
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-047-20 terms_hash kontrak sama dengan SDK dengan dan tanpa search_leg; batas bagian pencari dan tanda tangan atas search_leg ditegakkan", async () => {
    expect(await fx.sandbox.view<string>(fx.circle.accountId, "interface_version", {})).toBe("0.0.7");
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

    // 6 dari 101 credit melewati batas bawaan 500 bps
    const over = await commit({ ...base, legs: legs(55n, 40n, 6n), search_leg: search });
    expect(over.failures.join(" ")).toContain("ERR_SEARCH_SHARE_EXCEEDED");
    // search_leg yang bukan leg: SDK menolaknya sebelum menandatangani, jadi kirim mentah; kontrak menolaknya sebelum memeriksa tanda tangan
    expect(() => termsHash({ ...base, legs: legs(55n, 40n, 5n), search_leg: { payer: a.id, payee: c.id } })).toThrow(/search_leg/);
    const stranger = await solver.call(
      {
        receiverId: fx.circle.accountId, methodName: "commit_bundle", deposit: 0n, gas: 200_000_000_000_000n,
        args: { bundle: { epoch, legs: legs(55n, 40n, 5n), search_leg: { payer: a.id, payee: c.id } }, signatures: [] },
      },
      "EXECUTED_OPTIMISTIC",
    );
    expect(stranger.failures.join(" ")).toContain("ERR_BAD_BUNDLE");
    // peserta menandatangani syarat tanpa search_leg, kontrak menghitung hash dengan search_leg: tanda tangan tidak cocok
    const unsigned = await commit({ ...base, legs: legs(55n, 40n, 5n), search_leg: search }, { ...base, legs: legs(55n, 40n, 5n) });
    expect(unsigned.failures.join(" ")).toContain("ERR_BUNDLE_SIGNATURES");

    // tepat 500 bps: diterima, dan hash yang disimpan kontrak sama dengan hash SDK
    const withSearch: BundleTerms = { ...base, legs: legs(55n, 40n, 5n), search_leg: search };
    const ok = await commit(withSearch);
    expect(ok.failures).toEqual([]);
    const stored = await fx.sandbox.view<ContractAbi.BundleView | null>(fx.circle.accountId, "get_bundle", { bundle_id: 1 });
    expect(stored?.terms_hash).toBe(termsHash(withSearch));

    // tanpa search_leg bytes tidak berubah dari format lama; legs lain supaya hash berbeda
    const plain: BundleTerms = { ...base, legs: legs(10n, 10n, 10n) };
    expect((await commit(plain)).failures).toEqual([]);
    const storedPlain = await fx.sandbox.view<ContractAbi.BundleView | null>(fx.circle.accountId, "get_bundle", { bundle_id: 2 });
    expect(storedPlain?.terms_hash).toBe(termsHash(plain));
    expect(termsHash({ ...plain, search_leg: null })).toBe(termsHash(plain));
  }, 600_000);
});
