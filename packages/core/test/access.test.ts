// SD-050: F8 types and the AccessAssetAdapter interface from @x207/core (public exports only, like an outside developer). The example adapter below must pass
// type-check; the `tsc` test (npm run typecheck) checks it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FtEscrowView, MtEscrowView } from "../src/access.js";
import {
  AccessGrantError, GRANT_UNITS, assertBuyerRegisteredAtToken, buildFtEscrowDepositCall, buildMtEscrowDepositCall, mtEscrowGrantScope, buildFtEscrowMsg, buildRemoveIntentCall, ftEscrowGrantScope, buildWithdrawIntentsBalanceCall, escrowGrantScope, grantResource, isKnownX207Event, listGrantsOf, meterGrant, parseEventLog, parseGrantResource, priceOfGrant,
  type AccessAssetAdapter, type AccessGrant, type EscrowState, type EscrowStep, type EscrowView, type AssetClassEntry, type ContractAbi, type GrantStatus, type MeterCharge, type ProofResult, type RegisteredAssetClass, type RevokeReason,
} from "@x207/core";

const A = "scraper.x207-circle.near";
const B = "translator.x207-circle.near";
const grant = (patch: Partial<AccessGrant> = {}): AccessGrant => ({
  grant_id: 7, asset_type: "near-rpc:access", grantor: A, grantee: B, class: "B",
  limits: { scope: '{"receiver_id":"api.near","method_names":["get"],"allowance":"1"}', quota: "100", expires_at: "1793600000000000000" },
  unit: "day", unit_price: "250000", operator: null, delivery_pubkey: null, status: "active", proof_hash: null, proof_kind: null, ...patch,
});

// Class D example adapter: the grantor's x402 endpoint. `deliver` = endpoint, `meter` = voucher per call, `revoke` records the rejected payer.
class ExampleEndpointAdapter implements AccessAssetAdapter<{ endpoint: string }> {
  readonly assetClass = "D" as const;
  readonly revoked: Array<{ grantId: number; reason: RevokeReason }> = [];
  price(g: AccessGrant) {
    return priceOfGrant(g);
  }
  prove(): ProofResult {
    return { valid: true };
  }
  deliver(g: AccessGrant) {
    return { endpoint: `https://${g.grantor}/api` };
  }
  meter(g: AccessGrant, usage: { quantity: number }): MeterCharge {
    return meterGrant(g, usage);
  }
  revoke(g: AccessGrant, reason: RevokeReason) {
    this.revoked.push({ grantId: g.grant_id, reason });
  }
}

describe("SD-050 F8 types and interface", () => {
  it("TC-SD-050-01 the example adapter uses all five functions; meter produces a bill whose payee is the giver and whose resource is the grant", async () => {
    const adapter = new ExampleEndpointAdapter();
    const g = grant({ class: "D", unit: "call", unit_price: "20000" });
    expect(adapter.price(g)).toEqual({ assetType: "near-rpc:access", unit: "call", unitPrice: "20000" });
    expect(adapter.prove()).toEqual({ valid: true });
    expect(adapter.deliver(g)).toEqual({ endpoint: `https://${A}/api` });
    expect(adapter.meter(g, { quantity: 5 })).toEqual({ payer: B, payee: A, amount: "100000", resource: "x207:grant:7" });
    adapter.revoke(g, "defaulted");
    expect(adapter.revoked).toEqual([{ grantId: 7, reason: "defaulted" }]);
  });

  it("TC-SD-050-02 meter rejects a grant that is not active, has no grantee, or has an invalid amount", () => {
    expect(() => meterGrant(grant({ status: "offered", grantee: null }), { quantity: 1 })).toThrow(AccessGrantError);
    expect(() => meterGrant(grant({ status: "revoked" }), { quantity: 1 })).toThrow(/revoked/);
    expect(() => meterGrant(grant({ grantee: null }), { quantity: 1 })).toThrow(/no grantee/);
    expect(() => meterGrant(grant(), { quantity: 0 })).toThrow(/quantity/);
    expect(() => meterGrant(grant(), { quantity: 1.5 })).toThrow(/quantity/);
    // a large amount does not lose precision
    expect(meterGrant(grant({ unit_price: "340282366920938463463374607431768211455" }), { quantity: 2 }).amount).toBe("680564733841876926926749214863536422910");
  });

  it("TC-SD-050-03 grantResource and parseGrantResource invert each other; another resource is not a grant", () => {
    expect(grantResource(7)).toBe("x207:grant:7");
    expect(parseGrantResource("x207:grant:7")).toBe(7);
    for (const bad of ["x207:grant:", "x207:grant:07", "x207:grant:-1", "x207:grant:1.5", "invoice:abc", "x207:grant:99999999999999999999"]) expect(parseGrantResource(bad), bad).toBeNull();
  });

  it("TC-SD-050-04 the types match the pinned abi.json: class, status, unit, and registry entry", () => {
    const classes: RegisteredAssetClass[] = ["A", "B", "C", "D", "X"];
    const statuses: GrantStatus[] = ["offered", "active", "revoked", "expired"];
    expect(classes).toHaveLength(5);
    expect(statuses).toHaveLength(4);
    expect([...GRANT_UNITS]).toEqual(["call", "minute", "day", "once"]);
    const entry: AssetClassEntry = { asset_type: "near-rpc:access", class: "B", delivery_methods: ["near_access_key"], accepted_proofs: ["rpc_access_key"], terms_hash: "ab".repeat(32) };
    const abi = JSON.parse(readFileSync(fileURLToPath(new URL("../abi/x207-circle.abi.json", import.meta.url)), "utf8")) as {
      body: { root_schema: { definitions: Record<string, { properties?: Record<string, unknown>; enum?: string[]; oneOf?: Array<{ enum?: string[] }> }> } };
    };
    const defs = abi.body.root_schema.definitions;
    expect(Object.keys(defs.AssetClassEntry!.properties!).sort()).toEqual(Object.keys(entry).sort());
    expect(Object.keys(defs.AccessGrant!.properties!).sort()).toEqual(Object.keys(grant()).sort());
    const enumOf = (name: string) => (defs[name]!.enum ?? defs[name]!.oneOf!.flatMap((o) => o.enum ?? [])).sort();
    expect(enumOf("AssetClass")).toEqual([...classes].sort());
    expect(enumOf("GrantStatus")).toEqual([...statuses].sort());
    const typed: ContractAbi.AccessGrant = grant();
    expect(typed.grant_id).toBe(7);
  });
});

describe("SD-050 event F8", () => {
  const dir = fileURLToPath(new URL("../../../spec/test-vectors/events/sandbox/", import.meta.url));
  it("TC-SD-050-05 real log from near-sandbox: the parser knows all six F8 events", () => {
    for (const name of ["asset_class_set", "grant_offered", "grant_activated", "grant_revoked", "escrow_held", "escrow_failed"]) {
      const events = parseEventLog(readFileSync(`${dir}${name}.log`, "utf8").trim());
      expect(events, name).not.toBeNull();
      expect(isKnownX207Event(events![0]!), name).toBe(true);
      expect(events![0]!.event).toBe(name);
    }
    const [offered] = parseEventLog(readFileSync(`${dir}grant_offered.log`, "utf8").trim())!;
    expect(offered).toMatchObject({ grant_id: 1, class: "B", unit: "call", unit_price: "10000" });
  });

  it("TC-SD-050-06 grant_revoked: known with five valid reasons, another reason is rejected", () => {
    const log = (reason: string) => `EVENT_JSON:${JSON.stringify({ standard: "x207", version: "0.0.6", event: "grant_revoked", data: [{ grant_id: 1, reason }] })}`;
    for (const reason of ["grantor", "grantee", "operator", "expired", "defaulted"]) {
      expect(parseEventLog(log(reason))![0], reason).toMatchObject({ event: "grant_revoked", grant_id: 1, reason });
    }
    expect(() => parseEventLog(log("bored"))).toThrow(/reason/);
  });

  it("TC-SD-050-07 escrow_held and escrow_failed (0.0.7): parsed, a wrong field is rejected", () => {
    const log = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "x207", version: "0.0.7", event, data: [data] })}`;
    const held = parseEventLog(log("escrow_held", { grant_id: 1, nft_contract: "nft.near", token_id: "t1" }))![0]!;
    expect(isKnownX207Event(held)).toBe(true);
    expect(held).toMatchObject({ event: "escrow_held", grant_id: 1, nft_contract: "nft.near", token_id: "t1" });
    const failed = { grant_id: 1, step: "complete", epoch: 42, payer: B, payee: A, delta: "10000000", reverted: true };
    expect(parseEventLog(log("escrow_failed", failed))![0]).toMatchObject({ event: "escrow_failed", step: "complete", reverted: true, delta: "10000000" });
    expect(parseEventLog(log("escrow_failed", { ...failed, step: "cancel", reverted: false }))![0]).toMatchObject({ step: "cancel", reverted: false });
    expect(() => parseEventLog(log("escrow_failed", { ...failed, step: "refund" }))).toThrow(/step/);
    expect(() => parseEventLog(log("escrow_failed", { ...failed, reverted: "true" }))).toThrow(/reverted/);
    expect(() => parseEventLog(log("escrow_held", { grant_id: 1, nft_contract: "nft.near" }))).toThrow(/token_id/);
  });

  it("TC-SD-050-08 the escrow types match ABI 0.0.10", () => {
    const states: EscrowState[] = ["held", "completing", "cancelling", "delivered", "cancelled", "stuck"];
    const steps: EscrowStep[] = ["complete", "cancel"];
    const view: EscrowView = { grant_id: 1, nft_contract: "nft.near", token_id: "t1", state: "held" };
    const abi = JSON.parse(readFileSync(fileURLToPath(new URL("../abi/x207-circle.abi.json", import.meta.url)), "utf8")) as {
      body: { functions: { name: string }[]; root_schema: { definitions: Record<string, { enum?: string[]; oneOf?: { enum: string[] }[] }> } };
    };
    const enumOf = (name: string) => {
      const def = abi.body.root_schema.definitions[name]!;
      return (def.enum ?? def.oneOf!.flatMap((o) => o.enum)).sort();
    };
    expect(enumOf("EscrowState")).toEqual([...states].sort());
    expect(enumOf("EscrowStep")).toEqual([...steps].sort());
    expect(view.state).toBe("held");
    const methods = abi.body.functions.map((f) => f.name);
    for (const name of ["nft_on_transfer", "complete_escrow", "cancel_escrow", "on_escrow_resolved", "get_escrow"]) expect(methods, name).toContain(name);
  });

  it("TC-SD-050-09 interface 0.0.8: scope of a class A grant, paged grants_of, remove_intent", async () => {
    expect(JSON.parse(escrowGrantScope("nft.near", "t1"))).toEqual({ nft_contract: "nft.near", token_id: "t1" });
    const calls: unknown[] = [];
    const all = Array.from({ length: 7 }, (_, i) => grant({ grant_id: i + 1 }));
    const view = async (method: string, args: object) => {
      calls.push([method, args]);
      const { from_index, limit } = args as { from_index: number; limit: number };
      return all.slice(from_index, from_index + limit);
    };
    expect((await listGrantsOf(view, A, "grantor", 3)).map((g) => g.grant_id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["grants_of", { account_id: A, role: "grantor", from_index: 0, limit: 3 }]);
    expect((await listGrantsOf(view, A, "grantor", 7)).length).toBe(7); // a full last page costs one more, empty, request
    expect(buildWithdrawIntentsBalanceCall("circle.near")).toEqual({ receiverId: "circle.near", methodName: "withdraw_intents_balance", args: {}, deposit: 0n, gas: 150_000_000_000_000n });
    expect(buildRemoveIntentCall("circle.near", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrZb9rXzFaVzJ")).toEqual({
      receiverId: "circle.near", methodName: "remove_intent", args: { intent_hash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrZb9rXzFaVzJ" }, deposit: 0n,
    });
  });

  it("TC-SD-060-01 scope of a token escrow, the deposit message and the builder of the deposit", () => {
    expect(JSON.parse(ftEscrowGrantScope("rwa.near", "2500000"))).toEqual({ ft_contract: "rwa.near", amount: "2500000" });
    expect(() => ftEscrowGrantScope("rwa.near", "0")).toThrow(AccessGrantError);
    expect(() => ftEscrowGrantScope("rwa.near", "1.5")).toThrow(AccessGrantError);
    expect(buildFtEscrowMsg(7)).toBe('{"action":"escrow","grant_id":7}');
    expect(() => buildFtEscrowMsg(0)).toThrow(AccessGrantError);
    expect(buildFtEscrowDepositCall({ circleContract: "circle.near", ftContract: "rwa.near", amount: "2500000", grantId: 7 })).toEqual({
      receiverId: "rwa.near", methodName: "ft_transfer_call", args: { receiver_id: "circle.near", amount: "2500000", msg: '{"action":"escrow","grant_id":7}' }, deposit: 1n,
    });
  });

  it("TC-SD-060-02 the buyer must be registered at the token contract before the purchase", async () => {
    const calls: Array<[string, string, object]> = [];
    const registered = async (c: string, m: string, a: object) => (calls.push([c, m, a]), { total: "1250000000000000000000", available: "0" });
    await expect(assertBuyerRegisteredAtToken(registered, "rwa.near", "buyer.near")).resolves.toBeUndefined();
    expect(calls).toEqual([["rwa.near", "storage_balance_of", { account_id: "buyer.near" }]]);
    await expect(assertBuyerRegisteredAtToken(async () => null, "rwa.near", "buyer.near")).rejects.toThrow(/not registered.*storage_deposit/);
    await expect(assertBuyerRegisteredAtToken(async () => { throw new Error("method not found"); }, "rwa.near", "buyer.near")).rejects.toThrow(/storage_balance_of.*failed/);
  });

  it("TC-SD-060-03 ft_escrow_held (0.0.10) is parsed, a wrong field is refused, and FtEscrowView matches the ABI", () => {
    const log = (data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "x207", version: "0.0.10", event: "ft_escrow_held", data: [data] })}`;
    const held = parseEventLog(log({ grant_id: 3, ft_contract: "rwa.near", amount: "2500000" }))![0]!;
    expect(isKnownX207Event(held)).toBe(true);
    expect(held).toMatchObject({ event: "ft_escrow_held", grant_id: 3, ft_contract: "rwa.near", amount: "2500000" });
    expect(() => parseEventLog(log({ grant_id: 3, ft_contract: "rwa.near" }))).toThrow(/amount/);
    const view: FtEscrowView = { grant_id: 3, ft_contract: "rwa.near", amount: "2500000", state: "held", buyer: null };
    expect(view.state).toBe("held");
  });

  it("TC-SD-060-05 multi-token escrow: scope, deposit through mt_transfer_call, the event and the view type (interface 0.0.11)", () => {
    expect(JSON.parse(mtEscrowGrantScope("mt.near", "nep141:usdt.tether-token.near", "750000"))).toEqual({ mt_contract: "mt.near", token_id: "nep141:usdt.tether-token.near", amount: "750000" });
    expect(() => mtEscrowGrantScope("mt.near", "", "1")).toThrow(AccessGrantError);
    expect(() => mtEscrowGrantScope("mt.near", "t1", "0")).toThrow(AccessGrantError);
    expect(buildMtEscrowDepositCall({ circleContract: "circle.near", mtContract: "mt.near", tokenId: "t1", amount: "750000", grantId: 4 })).toEqual({
      receiverId: "mt.near", methodName: "mt_transfer_call",
      args: { receiver_id: "circle.near", token_id: "t1", amount: "750000", approval: null, memo: null, msg: '{"action":"escrow","grant_id":4}' }, deposit: 1n,
    });
    const log = (data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "x207", version: "0.0.11", event: "mt_escrow_held", data: [data] })}`;
    const held = parseEventLog(log({ grant_id: 4, mt_contract: "mt.near", token_id: "t1", amount: "750000" }))![0]!;
    expect(isKnownX207Event(held)).toBe(true);
    expect(held).toMatchObject({ event: "mt_escrow_held", token_id: "t1", amount: "750000" });
    expect(() => parseEventLog(log({ grant_id: 4, mt_contract: "mt.near", amount: "1" }))).toThrow(/token_id/);
    const view: MtEscrowView = { grant_id: 4, mt_contract: "mt.near", token_id: "t1", amount: "750000", state: "held", buyer: null };
    expect(view.state).toBe("held");
  });
});
