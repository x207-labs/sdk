// SD-050 di near-sandbox (interface 0.0.6): log nyata `asset_class_set`, `grant_offered`, `grant_activated` dari kontrak ter-parse oleh parser,
// dan tipe `AccessGrant` cocok dengan view `get_grant`. Dengan X207_UPDATE_FIXTURES=1 log disimpan ke spec/test-vectors/events/sandbox/.
// `grant_revoked` belum ada di kontrak 0.0.6 (CT-071), jadi tidak ada fixture sandbox untuknya.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createCircleViewFn, grantResource, meterGrant, onboardMember, parseEventLog, type AccessGrant, type AssetClassEntry, type ContractCall } from "@x207/core";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../../test-support/circle.js";
import { sandboxAvailable } from "../../../../test-support/sandbox.js";

const OUT = fileURLToPath(new URL("../../../../spec/test-vectors/events/sandbox/", import.meta.url));

describe.skipIf(!sandboxAvailable)("SD-050 event dan view F8 di near-sandbox", () => {
  let fx: CircleFixture;
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-050-10 log nyata set_asset_class, offer_grant dan accept_grant ter-parse; get_grant cocok dengan AccessGrant", async () => {
    fx = await deployCircle();
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
    const onboard = async (name: string) => {
      const account = await fx.member(name);
      await onboardMember(
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
      return account;
    };
    const [grantor, grantee] = [await onboard("scraper"), await onboard("translator")];
    const dao = await fx.sandbox.createAccount("dao", "5");
    const lines = new Map<string, string>();
    const collect = (logs: string[]) => {
      for (const line of logs) for (const event of parseEventLog(line) ?? []) if (!lines.has(event.event)) lines.set(event.event, line);
    };

    const entry: AssetClassEntry = { asset_type: "near-rpc:access", class: "B", delivery_methods: ["near_access_key"], accepted_proofs: ["rpc_access_key"], terms_hash: "ab".repeat(32) };
    const set = await dao.call({ receiverId: fx.circle.accountId, methodName: "set_asset_class", args: { asset_type: entry.asset_type, entry }, deposit: 0n });
    expect(set.failures).toEqual([]);
    collect(set.logs);
    expect(await fx.sandbox.view<AssetClassEntry | null>(fx.circle.accountId, "get_asset_class", { asset_type: entry.asset_type })).toEqual(entry);

    const expiresAt = BigInt(await fx.sandbox.blockTimestampMs()) * 1_000_000n + 3_600_000_000_000n;
    const offered = await grantor.call({
      receiverId: fx.circle.accountId, methodName: "offer_grant", deposit: 0n,
      args: {
        input: {
          asset_type: entry.asset_type, delivery_method: "near_access_key",
          limits: { scope: '{"receiver_id":"api.near","method_names":["get"],"allowance":"1"}', quota: "100", expires_at: expiresAt.toString() },
          unit: "call", unit_price: "10000", operator: null, proof_hash: null, proof_kind: null,
        },
      },
    });
    expect(offered.failures).toEqual([]);
    collect(offered.logs);
    const accepted = await grantee.call({ receiverId: fx.circle.accountId, methodName: "accept_grant", args: { grant_id: 1, delivery_pubkey: null }, deposit: 0n });
    expect(accepted.failures).toEqual([]);
    collect(accepted.logs);

    for (const name of ["asset_class_set", "grant_offered", "grant_activated"]) expect(lines.has(name), name).toBe(true);
    const [offeredEvent] = parseEventLog(lines.get("grant_offered")!)!;
    expect(offeredEvent).toMatchObject({ event: "grant_offered", grant_id: 1, asset_type: "near-rpc:access", grantor: grantor.accountId, class: "B", unit: "call", unit_price: "10000" });

    const grant = await fx.sandbox.view<AccessGrant | null>(fx.circle.accountId, "get_grant", { grant_id: 1 });
    expect(grant).toMatchObject({ grant_id: 1, status: "active", grantor: grantor.accountId, grantee: grantee.accountId, class: "B", unit: "call", unit_price: "10000" });
    // meter: tagihan 3 panggilan = 30000 dari penerima ke pemberi, resource memuat grantId
    expect(meterGrant(grant!, { quantity: 3 })).toEqual({ payer: grantee.accountId, payee: grantor.accountId, amount: "30000", resource: grantResource(1) });

    if (process.env.X207_UPDATE_FIXTURES === "1") {
      mkdirSync(OUT, { recursive: true });
      for (const name of ["asset_class_set", "grant_offered", "grant_activated"]) writeFileSync(`${OUT}${name}.log`, `${lines.get(name)}\n`);
    }
  }, 600_000);
});
