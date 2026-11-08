// SD-089: /evm/* routes of the facilitator with a fake NEAR caller. The signatures are the vectors of the contract (CT-104).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp, type FacilitatorService } from "../src/app.js";
import { EVM_JOIN_DEPOSIT, EvmRelay, feeModeFor, type EvmCaller } from "../src/evm-relay.js";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/core/test/fixtures/evm-eip712-v1.json", import.meta.url)), "utf8")); // eight-field Action: contracts 0.0.14 and 0.0.15 (SD-100: v1)
const fixture9 = JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/core/test/fixtures/evm-eip712.json", import.meta.url)), "utf8")); // nine fields, maxFee: contract 0.0.16
const v = fixture.vectors;
const sig = (name: string) => `eip712:${v[name].signature}`;
const NOW = 1_800_000_000_000; // before the deadline 1_900_000_000_000 of the vectors

type Sent = { method: string; args: Record<string, unknown>; deposit: bigint };
function setup(fail?: string, options: { maxJoinsPerHour?: number; perAddressMax?: number; maxDeadlineMs?: number; withMaxFee?: boolean | "all" } = {}) {
  const sent: Sent[] = [];
  const caller: EvmCaller = {
    async call(method, args, deposit) {
      if (fail) throw new Error(`Smart contract panicked: ${fail}`);
      sent.push({ method, args, deposit });
      return { hash: `hash${sent.length}` };
    },
  };
  let now = NOW;
  const relay = new EvmRelay({ circleContract: fixture.circle, caller, now: () => now, maxJoinsPerHour: options.maxJoinsPerHour ?? 20, perAddress: { max: options.perAddressMax ?? 10 }, ...(options.maxDeadlineMs !== undefined ? { maxDeadlineMs: options.maxDeadlineMs } : {}), ...(options.withMaxFee ? { withMaxFee: options.withMaxFee } : {}) });
  const service = { verify: async () => ({}), settle: async () => ({}), supported: async () => ({}) } as unknown as FacilitatorService;
  const app = createApp(service, { evm: relay, rateLimit: false });
  const post = async (path: string, body: unknown) => {
    const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any, retryAfter: res.headers.get("retry-after") };
  };
  return { sent, post, advance: (ms: number) => { now += ms; } };
}

const joinBody = () => ({ address: fixture.address, termsHash: v.join.message.termsHash, deadline: Number(v.join.message.deadline), signature: sig("join") });
const claimBody = () => ({ member: fixture.address, epoch: 5, receiver: "agent.testnet", nonce: 0, deadline: Number(v.claim.message.deadline), signature: sig("claim") });
const exitBody = () => ({ member: fixture.address, nonce: 1, deadline: Number(v.request_exit.message.deadline), signature: sig("request_exit") });
const withdrawBody = () => ({ member: fixture.address, receiver: "agent.testnet", nonce: 2, deadline: Number(v.withdraw_stake.message.deadline), signature: sig("withdraw_stake") });

describe("SD-089 EVM relayer", () => {
  it("TC-SD-089-01 the four routes send the contract methods; join attaches the 0.35 NEAR deposit", async () => {
    const { sent, post } = setup();
    expect(await post("/evm/join", joinBody())).toMatchObject({ status: 200, body: { ok: true, method: "join_evm", txHash: "hash1" } });
    expect((await post("/evm/claim", claimBody())).body.method).toBe("claim_evm");
    expect((await post("/evm/exit", exitBody())).body.method).toBe("request_exit_evm");
    expect((await post("/evm/withdraw", withdrawBody())).body.method).toBe("withdraw_stake_evm");
    expect(sent.map((s) => s.method)).toEqual(["join_evm", "claim_evm", "request_exit_evm", "withdraw_stake_evm"]);
    expect(sent[0]).toMatchObject({ deposit: EVM_JOIN_DEPOSIT, args: { address: fixture.address, terms_hash: v.join.message.termsHash, deadline: 1_900_000_000_000, signature: sig("join") } });
    expect(sent[1]).toMatchObject({ deposit: 0n, args: { member: fixture.address, epoch: 5, receiver: "agent.testnet", nonce: 0 } });
    expect(sent[3]?.args).toMatchObject({ receiver: "agent.testnet", nonce: 2 });
  });

  it("TC-SD-089-02 a changed field or a signature of another action is refused before any transaction", async () => {
    const { sent, post } = setup();
    expect((await post("/evm/claim", { ...claimBody(), receiver: "evil.testnet" })).body.error).toBe("bad_signature");
    expect((await post("/evm/claim", { ...claimBody(), epoch: 6 })).body.error).toBe("bad_signature");
    expect((await post("/evm/claim", { ...claimBody(), nonce: 1 })).body.error).toBe("bad_signature");
    expect((await post("/evm/claim", { ...claimBody(), signature: sig("withdraw_stake") })).body.error).toBe("bad_signature");
    expect((await post("/evm/join", { ...joinBody(), termsHash: "b".repeat(64) })).body.error).toBe("bad_signature");
    expect((await post("/evm/exit", { ...exitBody(), member: "0x0000000000000000000000000000000000000001" })).body.error).toBe("bad_signature");
    expect(sent).toEqual([]);
  });

  it("TC-SD-089-03 shapes: bad address, bad signature string, missing fields, not JSON", async () => {
    const { sent, post } = setup();
    for (const body of [
      { ...joinBody(), address: fixture.address.toUpperCase().replace("0X", "0x") }, { ...joinBody(), address: "a.testnet" }, { ...joinBody(), termsHash: "xyz" },
      { ...joinBody(), signature: "eip712:0x12" }, { ...joinBody(), signature: `ed25519:${v.join.signature}` }, { ...joinBody(), deadline: "1900000000000" }, { ...joinBody(), deadline: -1 },
      { ...claimBody(), receiver: "Bad Account" }, { ...claimBody(), epoch: 1.5 }, [], "text",
    ]) {
      const res = await post("/evm/join", body);
      expect([res.status, res.body.error]).toEqual([400, "invalid_request"]);
    }
    expect((await post("/evm/claim", { ...claimBody(), receiver: "Bad Account" })).body.error).toBe("invalid_request");
    expect((await post("/evm/claim", { ...claimBody(), epoch: 1.5 })).body.error).toBe("invalid_request");
    expect(sent).toEqual([]);
  });

  it("TC-SD-089-04 a deadline in the past is refused", async () => {
    const { sent, post, advance } = setup();
    advance(200_000_000_000); // now is past 1_900_000_000_000
    expect(await post("/evm/join", joinBody())).toMatchObject({ status: 400, body: { error: "expired" } });
    expect(sent).toEqual([]);
  });

  it("TC-SD-089-04b security review M3: with maxDeadlineMs a deadline further ahead than that is refused before anything is sent", async () => {
    const { sent, post } = setup(undefined, { maxDeadlineMs: 900_000 });
    expect(await post("/evm/join", joinBody())).toMatchObject({ status: 400, body: { error: "deadline_too_far" } });
    expect(sent).toEqual([]);
    const near = setup(undefined, { maxDeadlineMs: 2e11 }); // the deadline of the vectors is 1e11 ahead of NOW
    expect((await near.post("/evm/join", joinBody())).status).toBe(200);
  });

  it("TC-SD-089-05 contract panics become readable answers", async () => {
    for (const [panic, status, code] of [["ERR_EVM_NONCE: expected 3", 409, "bad_nonce"], ["ERR_ALREADY_MEMBER: 0x", 409, "already_member"], ["ERR_NOT_EVM_MEMBER", 404, "not_evm_member"], ["ERR_BAD_EVM_RECEIVER: x", 400, "bad_receiver"], ["ERR_MAX_MEMBERS: 64", 409, "circle_full"], ["ERR_SOMETHING_ELSE", 502, "contract_err_something_else"], ["connection reset", 502, "relay_failed"]] as const) {
      const { post } = setup(panic);
      const res = await post("/evm/claim", claimBody());
      expect([res.status, res.body.error]).toEqual([status, code]);
    }
  });

  it("TC-SD-089-06 rate limit per address answers 429 with Retry-After", async () => {
    const { post } = setup(undefined, { perAddressMax: 2 });
    expect((await post("/evm/exit", exitBody())).status).toBe(200);
    expect((await post("/evm/exit", exitBody())).status).toBe(200);
    const third = await post("/evm/exit", exitBody());
    expect([third.status, third.body.error]).toEqual([429, "rate_limited"]);
    expect(Number(third.retryAfter)).toBeGreaterThanOrEqual(1);
  });

  it("TC-SD-109-01 requests with a bad signature do not use up the budget of the address they name (A-SD-09)", async () => {
    const { post, sent } = setup(undefined, { perAddressMax: 2 });
    const forged = { ...exitBody(), signature: `eip712:0x${"11".repeat(64)}1b` };
    for (let i = 0; i < 10; i++) expect((await post("/evm/exit", forged)).body.error).toBe("bad_signature");
    // the owner of the address can still act: two signed requests fit, the third is limited
    expect((await post("/evm/exit", exitBody())).status).toBe(200);
    expect((await post("/evm/exit", exitBody())).status).toBe(200);
    expect((await post("/evm/exit", exitBody())).status).toBe(429);
    expect(sent).toHaveLength(2);
  });

  it("TC-SD-089-07 the relayer sponsors at most maxJoinsPerHour joins", async () => {
    const { sent, post, advance } = setup(undefined, { maxJoinsPerHour: 1 });
    expect((await post("/evm/join", joinBody())).status).toBe(200);
    const second = await post("/evm/join", joinBody());
    expect([second.status, second.body.error]).toEqual([503, "join_budget_used"]);
    expect(sent).toHaveLength(1);
    advance(3_600_000);
    expect((await post("/evm/join", joinBody())).status).toBe(200);
  });

  it("TC-SD-089-09 with a stake option the relayer also stakes for the new member; a failing stake is reported", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown>; deposit: bigint; receiverId: string | undefined }> = [];
    const caller: EvmCaller = { async call(method, args, deposit, receiverId) { calls.push({ method, args, deposit, receiverId }); return { hash: `h${calls.length}` }; } };
    const make = (c: EvmCaller) => createApp({ verify: async () => ({}), settle: async () => ({}), supported: async () => ({}) } as unknown as FacilitatorService, {
      rateLimit: false, evm: new EvmRelay({ circleContract: fixture.circle, caller: c, now: () => NOW, stake: { tokenId: "usdt.testnet", amount: "50000000" } }),
    });
    const res = await make(caller).request("/evm/join", { method: "POST", body: JSON.stringify(joinBody()) });
    expect(await res.json()).toMatchObject({ ok: true, txHash: "h1", stakeTxHash: "h2" });
    expect(calls[1]).toEqual({ method: "ft_transfer_call", receiverId: "usdt.testnet", deposit: 1n, args: { receiver_id: fixture.circle, amount: "50000000", msg: JSON.stringify({ action: "stake", member_id: fixture.address }) } });
    const failing: EvmCaller = { async call(method) { if (method === "ft_transfer_call") throw new Error("not enough balance"); return { hash: "h" }; } };
    const bad = await make(failing).request("/evm/join", { method: "POST", body: JSON.stringify(joinBody()) });
    expect([bad.status, (await bad.json() as any).error]).toEqual([502, "stake_failed"]);
  });

  it("TC-SD-089-08 without an EVM relay the routes do not exist", async () => {
    const service = { verify: async () => ({}), settle: async () => ({}), supported: async () => ({}) } as unknown as FacilitatorService;
    const res = await createApp(service, { rateLimit: false }).request("/evm/join", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("TC-SD-094-01 /evm/auto-settle sends set_auto_settle_evm; the signed action decides on or off (CT-108)", async () => {
    const { sent, post } = setup();
    const on = { member: fixture.address, enabled: true, nonce: 3, deadline: Number(v.auto_settle.message.deadline), signature: sig("auto_settle") };
    const off = { member: fixture.address, enabled: false, nonce: 4, deadline: Number(v.auto_settle_off.message.deadline), signature: sig("auto_settle_off") };
    expect((await post("/evm/auto-settle", on)).body).toMatchObject({ ok: true, method: "set_auto_settle_evm" });
    expect((await post("/evm/auto-settle", off)).body.ok).toBe(true);
    expect(sent.map((x) => x.args)).toEqual([
      { member: fixture.address, enabled: true, nonce: 3, deadline: 1_900_000_000_000, signature: sig("auto_settle") },
      { member: fixture.address, enabled: false, nonce: 4, deadline: 1_900_000_000_000, signature: sig("auto_settle_off") },
    ]);
    // a signed "on" cannot be sent as "off", and the other way round
    expect((await post("/evm/auto-settle", { ...on, enabled: false })).body.error).toBe("bad_signature");
    expect((await post("/evm/auto-settle", { ...off, enabled: true })).body.error).toBe("bad_signature");
    expect((await post("/evm/auto-settle", { ...on, enabled: "yes" })).body.error).toBe("invalid_request");
  });

  it("TC-SD-100-04 an eight-field circle (0.0.14, 0.0.15) refuses a maxFee in the body and still verifies the eight-field vectors", async () => {
    const { post, sent } = setup();
    expect((await post("/evm/claim", { ...claimBody(), maxFee: "250000" })).body.error).toBe("invalid_request");
    expect((await post("/evm/withdraw", { ...withdrawBody(), maxFee: "0" })).body.error).toBe("invalid_request");
    expect((await post("/evm/claim", claimBody())).body.ok).toBe(true);
    expect(sent.map((s) => s.args)).toEqual([{ member: fixture.address, epoch: 5, receiver: "agent.testnet", nonce: 0, deadline: 1_900_000_000_000, signature: sig("claim") }]);
    // a signature of the nine-field type is not valid for an eight-field circle
    const nine = fixture9.vectors;
    expect((await post("/evm/claim", { ...claimBody(), signature: `eip712:${nine.claim.signature}` })).body.error).toBe("bad_signature");
  });

  it("TC-SD-100-05 a 0.0.16 circle (withMaxFee) verifies the nine-field vectors and passes max_fee to claim_evm and withdraw_stake_evm; the others sign maxFee 0 and send no max_fee", async () => {
    const nine = fixture9.vectors;
    const s9 = (name: string) => `eip712:${nine[name].signature}`;
    const { post, sent } = setup(undefined, { withMaxFee: true, perAddressMax: 100 });
    const deadline = (name: string) => Number(nine[name].message.deadline);
    const claim = { member: fixture9.address, epoch: 5, receiver: "agent.testnet", nonce: 0, deadline: deadline("claim"), maxFee: "250000", signature: s9("claim") };
    const withdraw = { member: fixture9.address, receiver: "agent.testnet", nonce: 2, deadline: deadline("withdraw_stake"), maxFee: "100000", signature: s9("withdraw_stake") };
    const joined = await post("/evm/join", { address: fixture9.address, termsHash: nine.join.message.termsHash, deadline: deadline("join"), signature: s9("join") });
    expect(joined.body, JSON.stringify(joined.body)).toMatchObject({ ok: true });
    expect((await post("/evm/claim", claim)).body.ok).toBe(true);
    expect((await post("/evm/exit", { member: fixture9.address, nonce: 1, deadline: deadline("request_exit"), signature: s9("request_exit") })).body.ok).toBe(true);
    expect((await post("/evm/withdraw", withdraw)).body.ok).toBe(true);
    expect((await post("/evm/auto-settle", { member: fixture9.address, enabled: true, nonce: 3, deadline: deadline("auto_settle"), signature: s9("auto_settle") })).body.ok).toBe(true);
    expect(sent.map((s) => s.method)).toEqual(["join_evm", "claim_evm", "request_exit_evm", "withdraw_stake_evm", "set_auto_settle_evm"]);
    expect(sent[1]!.args).toEqual({ member: fixture9.address, epoch: 5, receiver: "agent.testnet", nonce: 0, deadline: 1_900_000_000_000, max_fee: "250000", signature: s9("claim") });
    expect(sent[3]!.args).toEqual({ member: fixture9.address, receiver: "agent.testnet", nonce: 2, deadline: 1_900_000_000_000, max_fee: "100000", signature: s9("withdraw_stake") });
    expect(sent[2]!.args).not.toHaveProperty("max_fee");
    // the ceiling is signed: another maxFee, or none, is refused and nothing is sent
    expect((await post("/evm/claim", { ...claim, maxFee: "250001" })).body.error).toBe("bad_signature");
    expect((await post("/evm/claim", { ...claim, maxFee: "-1" })).body.error).toBe("invalid_request");
    expect((await post("/evm/claim", { ...claim, maxFee: undefined })).body.error).toBe("invalid_request");
    expect((await post("/evm/claim", { ...claim, maxFee: 250000 })).body.ok).toBe(true); // a safe integer is read as the same value
    expect((await post("/evm/exit", { member: fixture9.address, nonce: 1, maxFee: "5", deadline: deadline("request_exit"), signature: s9("request_exit") })).body.error).toBe("invalid_request");
    // an eight-field signature is not valid for a 0.0.16 circle
    expect((await post("/evm/claim", { ...claim, signature: sig("claim") })).body.error).toBe("bad_signature");
    expect(sent).toHaveLength(6);
  });

  it("TC-SD-104-01 a 0.0.17 circle (withMaxFee all) sends max_fee on claim, exit, withdraw and auto-settle, and none on join (A-SD-01)", async () => {
    const nine = fixture9.vectors;
    const s9 = (name: string) => `eip712:${nine[name].signature}`;
    const { post, sent } = setup(undefined, { withMaxFee: "all", perAddressMax: 100 });
    const deadline = (name: string) => Number(nine[name].message.deadline);
    const joined = await post("/evm/join", { address: fixture9.address, termsHash: nine.join.message.termsHash, deadline: deadline("join"), signature: s9("join") });
    expect(joined.body, JSON.stringify(joined.body)).toMatchObject({ ok: true });
    expect((await post("/evm/claim", { member: fixture9.address, epoch: 5, receiver: "agent.testnet", nonce: 0, deadline: deadline("claim"), maxFee: "250000", signature: s9("claim") })).body.ok).toBe(true);
    const exited = await post("/evm/exit", { member: fixture9.address, nonce: 1, deadline: deadline("request_exit"), maxFee: "0", signature: s9("request_exit") });
    expect(exited.body, JSON.stringify(exited.body)).toMatchObject({ ok: true });
    expect((await post("/evm/withdraw", { member: fixture9.address, receiver: "agent.testnet", nonce: 2, deadline: deadline("withdraw_stake"), maxFee: "100000", signature: s9("withdraw_stake") })).body.ok).toBe(true);
    expect((await post("/evm/auto-settle", { member: fixture9.address, enabled: true, nonce: 3, deadline: deadline("auto_settle"), maxFee: "0", signature: s9("auto_settle") })).body.ok).toBe(true);
    expect((await post("/evm/auto-settle", { member: fixture9.address, enabled: false, nonce: 4, deadline: deadline("auto_settle_off"), maxFee: "0", signature: s9("auto_settle_off") })).body.ok).toBe(true);
    expect(sent.map((s) => s.method)).toEqual(["join_evm", "claim_evm", "request_exit_evm", "withdraw_stake_evm", "set_auto_settle_evm", "set_auto_settle_evm"]);
    expect(sent[0]!.args).not.toHaveProperty("max_fee");
    expect(sent[1]!.args).toMatchObject({ max_fee: "250000" });
    expect(sent[2]!.args).toEqual({ member: fixture9.address, nonce: 1, deadline: 1_900_000_000_000, max_fee: "0", signature: s9("request_exit") });
    expect(sent[3]!.args).toMatchObject({ max_fee: "100000" });
    expect(sent[4]!.args).toEqual({ member: fixture9.address, enabled: true, nonce: 3, deadline: 1_900_000_000_000, max_fee: "0", signature: s9("auto_settle") });
    expect(sent[5]!.args).toMatchObject({ enabled: false, max_fee: "0" });
    // the ceiling of exit and auto-settle is signed too: a missing, another or malformed maxFee sends nothing
    expect((await post("/evm/exit", { member: fixture9.address, nonce: 1, deadline: deadline("request_exit"), signature: s9("request_exit") })).body.error).toBe("invalid_request");
    expect((await post("/evm/exit", { member: fixture9.address, nonce: 1, deadline: deadline("request_exit"), maxFee: "5", signature: s9("request_exit") })).body.error).toBe("bad_signature");
    expect((await post("/evm/auto-settle", { member: fixture9.address, enabled: true, nonce: 3, deadline: deadline("auto_settle"), maxFee: "-1", signature: s9("auto_settle") })).body.error).toBe("invalid_request");
    expect(sent).toHaveLength(6);
  });

  it("TC-SD-104-02 feeModeFor reads the interface_version of the circle: 0.0.17 and later all, 0.0.16 true, older and unknown false", () => {
    expect(feeModeFor("0.0.17")).toBe("all");
    expect(feeModeFor("0.0.18")).toBe("all");
    expect(feeModeFor("0.1.0")).toBe("all");
    expect(feeModeFor("0.0.16")).toBe(true);
    expect(feeModeFor("0.0.15")).toBe(false);
    expect(feeModeFor("0.0.14")).toBe(false);
    expect(feeModeFor("")).toBe(false);
    expect(feeModeFor("v17")).toBe(false);
  });
});

