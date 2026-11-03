// deployCircle(params, { mockIntents: true }): the circle gets the mock Intents contract as `intents_id` (interface 0.0.9). Checks the fixture and the
// calls of the residual route that need no epoch: the view `intents_balance`, and `withdraw_intents_balance` with nothing to withdraw.
// Needs `cargo near build non-reproducible-wasm --manifest-path probes/mock_intents/Cargo.toml` in `contracts`.
import { afterAll, describe, expect, it } from "vitest";
import { buildWithdrawIntentsBalanceCall, contractErrorCode } from "../../src/index.js";
import { SHORT_PARAMS, deployCircle, type CircleFixture } from "../../../../test-support/circle.js";
import { sandboxAvailable } from "../../../../test-support/sandbox.js";

describe.skipIf(!sandboxAvailable)("SD-010 mock Intents as intents_id in near-sandbox", () => {
  let fx: CircleFixture;
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-010-30 the circle is bound to the mock Intents account; nothing to withdraw is ERR_NOTHING_TO_WITHDRAW", async () => {
    fx = await deployCircle(SHORT_PARAMS, { mockIntents: true });
    expect(fx.intents).toBeDefined();
    const circle = await fx.sandbox.view<{ intents_id: string }>(fx.circle.accountId, "get_circle", {});
    expect(circle.intents_id).toBe(fx.intents!.accountId);
    expect(await fx.sandbox.view<string>(fx.circle.accountId, "intents_balance", {})).toBe("0");
    expect(await fx.sandbox.view<string>(fx.intents!.accountId, "balance_of", { account_id: fx.circle.accountId })).toBe("0");
    const caller = await fx.member("anyone");
    const result = await caller.call(buildWithdrawIntentsBalanceCall(fx.circle.accountId));
    expect(result.failures.join(" ")).toContain("ERR_NOTHING_TO_WITHDRAW");
    expect(contractErrorCode(new Error(result.failures.join(" ")))).toBe("ERR_NOTHING_TO_WITHDRAW");
  }, 300_000);
});
