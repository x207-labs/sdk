// SD-052 di near-sandbox: verifyFunctionCallKey terhadap access key nyata. Kunci yang cocok valid; method tambahan, receiver_id lain, kunci akses penuh,
// kunci tanpa batas method, dan kunci yang tidak ada ditolak. Pemasangan kunci memakai near-api-js, bukan kode produk.
import { afterAll, describe, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import { createViewAccessKeyFn, verifyFunctionCallKey, type AccessGrant } from "@x207/core";
import { sandboxAvailable, startSandbox, type Sandbox } from "../../../../test-support/sandbox.js";

describe.skipIf(!sandboxAvailable)("SD-052 prove kelas B di near-sandbox", () => {
  let sandbox: Sandbox | undefined;
  afterAll(async () => {
    await sandbox?.stop();
  });

  it("TC-SD-052-09 kunci function-call nyata: cocok valid, melenceng invalid", async () => {
    sandbox = await startSandbox();
    const rent = await sandbox.createAccount("rent1", "20");
    const view = createViewAccessKeyFn({ rpcUrls: [sandbox.rpcUrl], finality: "optimistic" });
    const allowance = 10n ** 24n;
    const scope = { receiver_id: "api.near", method_names: ["get", "list"], allowance: allowance.toString() };
    const grant: AccessGrant = {
      grant_id: 1, asset_type: "near-rpc:access", grantor: rent.accountId, grantee: "translator.near", class: "B",
      limits: { scope: JSON.stringify(scope), quota: null, expires_at: "1793600000000000000" }, unit: "day", unit_price: "250000", operator: null,
      delivery_pubkey: null, status: "active", proof_hash: null, proof_kind: null,
    };
    const add = async (contractId: string, methodNames: string[], keyAllowance: bigint) => {
      const key = KeyPair.fromRandom("ed25519");
      await rent.account.addFunctionCallAccessKey({ publicKey: key.getPublicKey(), contractId, methodNames, allowance: keyAllowance });
      return key.getPublicKey().toString();
    };
    const check = (publicKey: string) => verifyFunctionCallKey(rent.accountId, publicKey, grant, view);

    expect(await check(await add("api.near", ["get"], allowance))).toEqual({ valid: true });
    expect(await check(await add("api.near", ["get", "list"], allowance / 2n))).toEqual({ valid: true });
    expect(await check(await add("api.near", ["get", "transfer"], allowance))).toEqual({ valid: false, reason: "method_not_allowed" });
    expect(await check(await add("api.near", [], allowance))).toEqual({ valid: false, reason: "method_not_allowed" });
    expect(await check(await add("other.near", ["get"], allowance))).toEqual({ valid: false, reason: "receiver_mismatch" });
    expect(await check(await add("api.near", ["get"], allowance * 2n))).toEqual({ valid: false, reason: "allowance_exceeded" });
    const full = KeyPair.fromRandom("ed25519");
    await rent.account.addFullAccessKey(full.getPublicKey());
    expect(await check(full.getPublicKey().toString())).toEqual({ valid: false, reason: "full_access_key" });
    expect(await check(KeyPair.fromRandom("ed25519").getPublicKey().toString())).toEqual({ valid: false, reason: "key_not_found" });
  }, 300_000);
});
