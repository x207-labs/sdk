import { describe, expect, it } from "vitest";
import { checkAccountLockBeforePay, evaluateAccountLock, readAccountOnChain, type AccountLockFacts } from "../src/account-lock.js";

const CIRCLE = "circle.testnet";
const SOLD = "sold.testnet";
const HASH = "5hDBGoCJgeCCfnCsRBkbkGwDq5uVjXQKEx3mTDFYrt3r";
const OTHER_HASH = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrZb9rXzFaVzJ";

const good = (): AccountLockFacts => ({
  keys: [],
  codeHash: HASH,
  locker: { circle: CIRCLE, grant_id: 7, return_pubkey: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp", state: "held" },
  escrow: { grant_id: 7, account_id: SOLD, state: "held" },
  officialCodeHashes: [HASH],
});
const verdict = (facts: AccountLockFacts) => evaluateAccountLock({ circle: CIRCLE, grantId: 7, soldAccount: SOLD, facts });

describe("SD-119 pre-pay check of a locked account", () => {
  it("TC-SD-119-02 passes only when every fact is right", () => {
    expect(verdict(good())).toEqual({ ok: true, reasons: [] });
  });

  it("TC-SD-119-03 a leftover key, unofficial code, a missing locker and a missing escrow each refuse", () => {
    expect(verdict({ ...good(), keys: ["ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"] }).reasons).toEqual(["keys_left"]);
    expect(verdict({ ...good(), codeHash: OTHER_HASH }).reasons).toEqual(["code_not_official"]);
    expect(verdict({ ...good(), officialCodeHashes: [] }).reasons).toEqual(["no_official_list"]);
    expect(verdict({ ...good(), locker: null }).reasons).toEqual(["locker_missing"]);
    expect(verdict({ ...good(), escrow: null }).reasons).toEqual(["escrow_missing"]);
  });

  it("TC-SD-119-04 a locker of another circle or grant, or in another state, and an escrow of another account refuse", () => {
    const locker = good().locker!;
    expect(verdict({ ...good(), locker: { ...locker, circle: "evil.testnet" } }).reasons).toEqual(["locker_other_circle"]);
    expect(verdict({ ...good(), locker: { ...locker, grant_id: 8 } }).reasons).toEqual(["locker_other_grant"]);
    for (const state of ["pending", "released", "returned"]) expect(verdict({ ...good(), locker: { ...locker, state } }).reasons).toEqual(["locker_not_held"]);
    expect(verdict({ ...good(), escrow: { grant_id: 7, account_id: "other.testnet", state: "held" } }).reasons).toEqual(["escrow_other_account"]);
    expect(verdict({ ...good(), escrow: { grant_id: 7, account_id: SOLD, state: "delivered" } }).reasons).toEqual(["escrow_not_held"]);
  });

  it("TC-SD-119-05 several faults are all reported", () => {
    const check = verdict({ ...good(), keys: ["ed25519:x"], codeHash: OTHER_HASH, locker: null });
    expect(check.ok).toBe(false);
    expect(check.reasons).toEqual(["keys_left", "code_not_official", "locker_missing"]);
  });

  const answer = (method: string, params: { request_type: string; method_name?: string }) => {
    if (params.request_type === "view_access_key_list") return { keys: [] };
    if (params.request_type === "view_account") return { code_hash: method === "official" ? HASH : OTHER_HASH };
    const state = { circle: CIRCLE, grant_id: 7, return_pubkey: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp", state: "held" };
    return { result: [...Buffer.from(JSON.stringify(state))] };
  };
  const rpc = (code: string): typeof fetch =>
    (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body)) as { params: { request_type: string; method_name?: string } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x207", result: answer(code, body.params) }), { status: 200 });
    }) as unknown as typeof fetch;

  it("TC-SD-119-06 reads keys, code hash and locker state through the RPC and passes with the circle's list", async () => {
    const circleView = async (method: string) => (method === "get_account_escrow" ? { grant_id: 7, account_id: SOLD, state: "held" } : [HASH]);
    const check = await checkAccountLockBeforePay({ circle: CIRCLE, circleView, grantId: 7, soldAccount: SOLD, rpcUrls: ["https://rpc.test"], fetch: rpc("official") });
    expect(check).toMatchObject({ ok: true, reasons: [] });
    expect(check.facts.locker?.state).toBe("held");
    const fake = await checkAccountLockBeforePay({ circle: CIRCLE, circleView, grantId: 7, soldAccount: SOLD, rpcUrls: ["https://rpc.test"], fetch: rpc("other") });
    expect(fake.reasons).toEqual(["code_not_official"]);
  });

  it("TC-SD-119-07 an account without a locker answers with an error: no locker, not a crash", async () => {
    const fetchFn = (async (_url: unknown, init?: { body?: string }) => {
      const { params } = JSON.parse(String(init?.body)) as { params: { request_type: string } };
      const result = params.request_type === "view_access_key_list" ? { keys: [{ public_key: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp", access_key: {} }] } : params.request_type === "view_account" ? { code_hash: "11111111111111111111111111111111" } : { error: "wasm execution failed: CodeDoesNotExist" };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x207", result }), { status: 200 });
    }) as unknown as typeof fetch;
    const facts = await readAccountOnChain(SOLD, { rpcUrls: ["https://rpc.test"], fetch: fetchFn });
    expect(facts.locker).toBeNull();
    expect(facts.keys).toHaveLength(1);
  });
});
