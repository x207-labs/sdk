// SD-050: tipe F8 dan antarmuka AccessAssetAdapter dari @x207/core (hanya ekspor publik, seperti developer luar). Adaptor contoh di bawah harus lolos
// type-check; `tsc` test (npm run typecheck) memeriksanya.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AccessGrantError, GRANT_UNITS, grantResource, isKnownX207Event, meterGrant, parseEventLog, parseGrantResource, priceOfGrant,
  type AccessAssetAdapter, type AccessGrant, type AssetClassEntry, type ContractAbi, type GrantStatus, type MeterCharge, type ProofResult, type RegisteredAssetClass, type RevokeReason,
} from "@x207/core";

const A = "scraper.x207-circle.near";
const B = "translator.x207-circle.near";
const grant = (patch: Partial<AccessGrant> = {}): AccessGrant => ({
  grant_id: 7, asset_type: "near-rpc:access", grantor: A, grantee: B, class: "B",
  limits: { scope: '{"receiver_id":"api.near","method_names":["get"],"allowance":"1"}', quota: "100", expires_at: "1793600000000000000" },
  unit: "day", unit_price: "250000", operator: null, delivery_pubkey: null, status: "active", proof_hash: null, proof_kind: null, ...patch,
});

// Adaptor contoh kelas D: endpoint x402 milik pemberi. `deliver` = endpoint, `meter` = voucher per panggilan, `revoke` mencatat payer yang ditolak.
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

describe("SD-050 tipe dan antarmuka F8", () => {
  it("TC-SD-050-01 adaptor contoh memakai kelima fungsi; meter menghasilkan tagihan ber-payee pemberi dan resource grant", async () => {
    const adapter = new ExampleEndpointAdapter();
    const g = grant({ class: "D", unit: "call", unit_price: "20000" });
    expect(adapter.price(g)).toEqual({ assetType: "near-rpc:access", unit: "call", unitPrice: "20000" });
    expect(adapter.prove()).toEqual({ valid: true });
    expect(adapter.deliver(g)).toEqual({ endpoint: `https://${A}/api` });
    expect(adapter.meter(g, { quantity: 5 })).toEqual({ payer: B, payee: A, amount: "100000", resource: "x207:grant:7" });
    adapter.revoke(g, "defaulted");
    expect(adapter.revoked).toEqual([{ grantId: 7, reason: "defaulted" }]);
  });

  it("TC-SD-050-02 meter menolak grant yang belum active, tanpa penerima, atau jumlah tidak sah", () => {
    expect(() => meterGrant(grant({ status: "offered", grantee: null }), { quantity: 1 })).toThrow(AccessGrantError);
    expect(() => meterGrant(grant({ status: "revoked" }), { quantity: 1 })).toThrow(/revoked/);
    expect(() => meterGrant(grant({ grantee: null }), { quantity: 1 })).toThrow(/penerima/);
    expect(() => meterGrant(grant(), { quantity: 0 })).toThrow(/quantity/);
    expect(() => meterGrant(grant(), { quantity: 1.5 })).toThrow(/quantity/);
    // jumlah besar tidak kehilangan presisi
    expect(meterGrant(grant({ unit_price: "340282366920938463463374607431768211455" }), { quantity: 2 }).amount).toBe("680564733841876926926749214863536422910");
  });

  it("TC-SD-050-03 grantResource dan parseGrantResource saling membalik; resource lain bukan grant", () => {
    expect(grantResource(7)).toBe("x207:grant:7");
    expect(parseGrantResource("x207:grant:7")).toBe(7);
    for (const bad of ["x207:grant:", "x207:grant:07", "x207:grant:-1", "x207:grant:1.5", "invoice:abc", "x207:grant:99999999999999999999"]) expect(parseGrantResource(bad), bad).toBeNull();
  });

  it("TC-SD-050-04 tipe cocok dengan abi.json yang dipin: kelas, status, unit, dan entri registri", () => {
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
  it("TC-SD-050-05 log nyata dari near-sandbox: keempat event F8 dikenal parser", () => {
    for (const name of ["asset_class_set", "grant_offered", "grant_activated", "grant_revoked"]) {
      const events = parseEventLog(readFileSync(`${dir}${name}.log`, "utf8").trim());
      expect(events, name).not.toBeNull();
      expect(isKnownX207Event(events![0]!), name).toBe(true);
      expect(events![0]!.event).toBe(name);
    }
    const [offered] = parseEventLog(readFileSync(`${dir}grant_offered.log`, "utf8").trim())!;
    expect(offered).toMatchObject({ grant_id: 1, class: "B", unit: "call", unit_price: "10000" });
  });

  it("TC-SD-050-06 grant_revoked: dikenal dengan lima alasan yang sah, alasan lain ditolak", () => {
    const log = (reason: string) => `EVENT_JSON:${JSON.stringify({ standard: "x207", version: "0.0.6", event: "grant_revoked", data: [{ grant_id: 1, reason }] })}`;
    for (const reason of ["grantor", "grantee", "operator", "expired", "defaulted"]) {
      expect(parseEventLog(log(reason))![0], reason).toMatchObject({ event: "grant_revoked", grant_id: 1, reason });
    }
    expect(() => parseEventLog(log("bored"))).toThrow(/reason/);
  });
});
