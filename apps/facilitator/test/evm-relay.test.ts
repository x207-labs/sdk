// SD-089: /evm/* routes of the facilitator with a fake NEAR caller. The signatures are the vectors of the contract (CT-104).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp, type FacilitatorService } from "../src/app.js";
import { EVM_JOIN_DEPOSIT, EvmRelay, type EvmCaller } from "../src/evm-relay.js";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/core/test/fixtures/evm-eip712.json", import.meta.url)), "utf8"));
const v = fixture.vectors;
const sig = (name: string) => `eip712:${v[name].signature}`;
const NOW = 1_800_000_000_000; // before the deadline 1_900_000_000_000 of the vectors

type Sent = { method: string; args: Record<string, unknown>; deposit: bigint };
function setup(fail?: string, options: { maxJoinsPerHour?: number; perAddressMax?: number; maxDeadlineMs?: number } = {}) {
  const sent: Sent[] = [];
  const caller: EvmCaller = {
    async call(method, args, deposit) {
      if (fail) throw new Error(`Smart contract panicked: ${fail}`);
      sent.push({ method, args, deposit });
      return { hash: `hash${sent.length}` };
    },
  };
  let now = NOW;
  const relay = new EvmRelay({ circleContract: fixture.circle, caller, now: () => now, maxJoinsPerHour: options.maxJoinsPerHour ?? 20, perAddress: { max: options.perAddressMax ?? 10 }, ...(options.maxDeadlineMs !== undefined ? { maxDeadlineMs: options.maxDeadlineMs } : {}) });
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
});

