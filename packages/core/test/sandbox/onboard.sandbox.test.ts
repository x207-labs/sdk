// Integrasi near-sandbox untuk F1: TC-SD-012-07, TC-SD-012-08, TC-SD-013-01, TC-SD-013-02, sebagian TC-SD-011-17.
// Dilewati bila binary near-sandbox atau wasm kontrak tidak ada (lihat test-support/sandbox.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildJoinCall,
  contractErrorCode,
  createCircleViewFn,
  getMember,
  isKnownX207Event,
  onboardMember,
  parseEventLog,
  type ContractCall,
} from "@x207/core";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../../test-support/circle.js";
import { sandboxAvailable, type SandboxAccount, type TxResult } from "../../../../test-support/sandbox.js";

const STAKE = "50000000";

describe.skipIf(!sandboxAvailable)("SD-011/012/013 onboarding di near-sandbox", () => {
  let fx: CircleFixture;
  let view: ReturnType<typeof createCircleViewFn>;
  const eventsSeen: Array<{ event: string } & Record<string, unknown>> = [];

  const record = (result: TxResult) => {
    for (const log of result.logs) for (const parsed of parseEventLog(log) ?? []) {
      expect(isKnownX207Event(parsed), `event ${parsed.event} dikenal`).toBe(true);
      eventsSeen.push(parsed as never);
    }
  };
  const sender = (account: SandboxAccount) => async (call: ContractCall) => {
    const result = await account.call(call);
    record(result);
    if (result.failures.length > 0) throw new Error(result.failures.join("; "));
    return result.value;
  };

  beforeAll(async () => {
    fx = await deployCircle();
    view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
  }, 180_000);
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-013-01/02 onboardMember membawa akun baru sampai active dengan kunci voucher terpisah", async () => {
    const translator = await fx.member("translator");
    const result = await onboardMember(
      { sendCall: sender(translator), view, pollIntervalMs: 200, timeoutMs: 20_000 },
      {
        circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: translator.accountId,
        termsHash: TERMS_HASH, stakeAmount: STAKE, usdtTokenId: fx.usdt.accountId,
      },
    );
    expect(result.member.status).toBe("active");
    expect(result.member.stake).toBe(STAKE);
    expect(result.member.pubkey_voucher).toBe(result.publicKey);

    const keys = await fx.sandbox.provider.viewAccessKeyList({ accountId: translator.accountId });
    expect(keys.keys.map((k) => k.public_key)).not.toContain(result.publicKey);
  }, 120_000);

  it("TC-SD-012-08 join, stake 50 USDT mock, baca member", async () => {
    const summarizer = await fx.member("summarizer");
    await onboardMember(
      { sendCall: sender(summarizer), view, pollIntervalMs: 200, timeoutMs: 20_000 },
      {
        circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: summarizer.accountId,
        termsHash: TERMS_HASH, stakeAmount: STAKE, usdtTokenId: fx.usdt.accountId,
      },
    );
    const member = await getMember(view, summarizer.accountId);
    expect(member).toMatchObject({ status: "active", stake: STAKE });
    expect(await getMember(view, `nobody.${fx.sandbox.rootAccountId}`)).toBeNull();
  }, 120_000);

  it("TC-SD-012-07 join kedua melempar ERR_ALREADY_MEMBER", async () => {
    const translator = await fx.member("translator");
    const again = await translator.call(
      buildJoinCall({
        circleContract: fx.circle.accountId, circleId: fx.circleId,
        pubkeyVoucher: "ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9", termsHash: TERMS_HASH,
      }),
    );
    expect(again.failures.length).toBeGreaterThan(0);
    expect(contractErrorCode(new Error(again.failures.join("; ")))).toBe("ERR_ALREADY_MEMBER");
  }, 60_000);

  it("TC-SD-011-17 (sebagian) log nyata member_joined dan stake_added ter-parse", () => {
    const names = eventsSeen.map((e) => e.event);
    expect(names).toContain("member_joined");
    expect(names).toContain("stake_added");
    const joined = eventsSeen.find((e) => e.event === "member_joined")!;
    expect(joined).toMatchObject({ status: "pending", terms_hash: TERMS_HASH });
  });
});
