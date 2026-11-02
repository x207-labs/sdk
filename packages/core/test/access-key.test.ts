// SD-052: verifyFunctionCallKey (prove kelas B). Unit dengan RPC tiruan; sandbox nyata ada di sandbox/access-key.sandbox.test.ts.
import { describe, expect, it } from "vitest";
import { createViewAccessKeyFn, parseFunctionCallKeyScope, verifyFunctionCallKey, type AccessGrant, type AccessKeyView, type ViewAccessKeyFn } from "@x207/core";

const ACCOUNT = "rent1.scraper.near";
const KEY = "ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";
const scope = { receiver_id: "api.near", method_names: ["get", "list"], allowance: "1000000000000000000000000" };
const grant = (patch: Partial<AccessGrant> = {}, s: object = scope): AccessGrant => ({
  grant_id: 3, asset_type: "near-rpc:access", grantor: "scraper.near", grantee: "translator.near", class: "B",
  limits: { scope: JSON.stringify(s), quota: null, expires_at: "1793600000000000000" }, unit: "day", unit_price: "250000", operator: null,
  delivery_pubkey: KEY, status: "active", proof_hash: null, proof_kind: null, ...patch,
});
const fc = (patch: Partial<{ allowance: string | null; receiver_id: string; method_names: string[] }> = {}): AccessKeyView => ({
  nonce: 1, permission: { FunctionCall: { allowance: scope.allowance, receiver_id: "api.near", method_names: ["get"], ...patch } },
});
const viewing = (key: AccessKeyView | null): ViewAccessKeyFn => async () => key;

describe("SD-052 verifyFunctionCallKey", () => {
  it("TC-SD-052-01 kunci yang cocok dengan grant: valid (subset method dan allowance sama atau lebih kecil)", async () => {
    expect(await verifyFunctionCallKey(ACCOUNT, KEY, grant(), viewing(fc()))).toEqual({ valid: true });
    expect(await verifyFunctionCallKey(ACCOUNT, KEY, grant(), viewing(fc({ method_names: ["get", "list"] })))).toEqual({ valid: true });
    expect(await verifyFunctionCallKey(ACCOUNT, KEY, grant(), viewing(fc({ allowance: "1" })))).toEqual({ valid: true });
  });

  it("TC-SD-052-02 method tambahan atau daftar kosong (semua method): invalid method_not_allowed", async () => {
    expect(await verifyFunctionCallKey(ACCOUNT, KEY, grant(), viewing(fc({ method_names: ["get", "transfer"] })))).toEqual({ valid: false, reason: "method_not_allowed" });
    expect(await verifyFunctionCallKey(ACCOUNT, KEY, grant(), viewing(fc({ method_names: [] })))).toEqual({ valid: false, reason: "method_not_allowed" });
  });

  it("TC-SD-052-03 receiver_id lain: invalid receiver_mismatch", async () => {
    expect(await verifyFunctionCallKey(ACCOUNT, KEY, grant(), viewing(fc({ receiver_id: "other.near" })))).toEqual({ valid: false, reason: "receiver_mismatch" });
  });

  it("TC-SD-052-04 allowance lebih besar atau tanpa batas: invalid allowance_exceeded", async () => {
    expect(await verifyFunctionCallKey(ACCOUNT, KEY, grant(), viewing(fc({ allowance: "1000000000000000000000001" })))).toEqual({ valid: false, reason: "allowance_exceeded" });
    expect(await verifyFunctionCallKey(ACCOUNT, KEY, grant(), viewing(fc({ allowance: null })))).toEqual({ valid: false, reason: "allowance_exceeded" });
  });

  it("TC-SD-052-05 kunci akses penuh, kunci tidak ada, grant bukan kelas B, scope rusak", async () => {
    expect(await verifyFunctionCallKey(ACCOUNT, KEY, grant(), viewing({ nonce: 1, permission: "FullAccess" }))).toEqual({ valid: false, reason: "full_access_key" });
    expect(await verifyFunctionCallKey(ACCOUNT, KEY, grant(), viewing(null))).toEqual({ valid: false, reason: "key_not_found" });
    expect(await verifyFunctionCallKey(ACCOUNT, KEY, grant({ class: "D" }), viewing(fc()))).toEqual({ valid: false, reason: "not_class_b" });
    const bad = await verifyFunctionCallKey(ACCOUNT, KEY, grant({ limits: { scope: "bukan json", quota: null, expires_at: "1" } }), viewing(fc()));
    expect(bad).toMatchObject({ valid: false });
    expect((bad as { reason: string }).reason).toMatch(/^bad_scope/);
  });

  it("TC-SD-052-06 RPC tidak terjangkau dilempar, bukan dianggap kunci salah", async () => {
    await expect(verifyFunctionCallKey(ACCOUNT, KEY, grant(), async () => { throw new Error("semua endpoint RPC gagal"); })).rejects.toThrow(/RPC/);
  });

  it("TC-SD-052-07 parseFunctionCallKeyScope menolak bentuk tidak sah", () => {
    expect(parseFunctionCallKeyScope(JSON.stringify(scope))).toEqual(scope);
    for (const bad of ['{"receiver_id":"a.near"}', '{"receiver_id":"a.near","method_names":[],"allowance":"1"}', '{"receiver_id":"a.near","method_names":["x"],"allowance":1}', '[]', 'x']) {
      expect(() => parseFunctionCallKeyScope(bad), bad).toThrow();
    }
  });
});

describe("SD-052 createViewAccessKeyFn", () => {
  const reply = (body: unknown, ok = true) => async () => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response;
  it("TC-SD-052-08 membaca permission, kunci tidak ada menjadi null, error RPC dilempar, failover ke endpoint berikutnya", async () => {
    const requests: unknown[] = [];
    const okFetch = (async (_u: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, json: async () => ({ result: { nonce: 5, permission: { FunctionCall: { allowance: "1", receiver_id: "api.near", method_names: ["get"] } } } }) } as Response;
    }) as typeof fetch;
    const view = createViewAccessKeyFn({ rpcUrls: ["http://rpc"], fetch: okFetch });
    expect(await view(ACCOUNT, KEY)).toMatchObject({ nonce: 5 });
    expect(requests[0]).toMatchObject({ method: "query", params: { request_type: "view_access_key", finality: "final", account_id: ACCOUNT, public_key: KEY } });

    const missing = createViewAccessKeyFn({ rpcUrls: ["http://rpc"], fetch: reply({ error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } }) as unknown as typeof fetch });
    expect(await missing(ACCOUNT, KEY)).toBeNull();
    const missingResult = createViewAccessKeyFn({ rpcUrls: ["http://rpc"], fetch: reply({ result: { error: "access key ed25519:x does not exist while viewing" } }) as unknown as typeof fetch });
    expect(await missingResult(ACCOUNT, KEY)).toBeNull();
    const broken = createViewAccessKeyFn({ rpcUrls: ["http://rpc"], fetch: reply({ error: { name: "HANDLER_ERROR" } }) as unknown as typeof fetch });
    await expect(broken(ACCOUNT, KEY)).rejects.toThrow(/RPC error/);

    let calls = 0;
    const flaky = createViewAccessKeyFn({
      rpcUrls: ["http://a", "http://b"],
      fetch: (async (url: string) => (++calls, url === "http://a" ? reply({}, false)() : okFetch(url, { body: "{}" }))) as unknown as typeof fetch,
    });
    expect(await flaky(ACCOUNT, KEY)).toMatchObject({ nonce: 5 });
    expect(calls).toBe(2);
    await expect(createViewAccessKeyFn({ rpcUrls: ["http://a"], fetch: reply({}, false) as unknown as typeof fetch })(ACCOUNT, KEY)).rejects.toThrow(/semua endpoint RPC gagal/);
  });
});
