// SD-053: F8 grant endpoint. The server puts `grantId` in `extra` with `payTo` = the grantor, the client builds a voucher with payee = payTo and
// resource `x207:grant:<grantId>`, and the facilitator rejects a voucher whose payee is the broker account (`payee_mismatch`) or whose resource differs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import { grantResource, validatePaymentRequirements, verifyVoucher, type ContractAbi, type X207Payload } from "@x207/core";
import {
  MemoryVoucherStateStore, X207ExtraSource, X207SchemeClient, X207SchemeFacilitator, X207_NETWORK_FAMILY, buildPaymentRequirements, x207Middleware,
  type VerifyChain,
} from "@x207/scheme";

const vectors = fileURLToPath(new URL("../../../spec/test-vectors/", import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(`${vectors}${path}`, "utf8")) as any;
const vector = read("grant/voucher_grant.json");
const keys = read("keys.json").keys;
const GRANTEE = vector.input.voucher.payer as string;
const GRANTOR = vector.input.requirements.payTo as string;
const CIRCLE = "x207-circle.near";
const NOW = 1_793_836_800_000;
const NETWORK = "x207:agents-main";

const member = (account: string, key: string): ContractAbi.MemberView => ({
  account_id: account, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 42, limit: "100000000",
  pubkey_voucher: keys[key].publicKey, settled_history: "0", stake: "100000000", status: "active", terms_hash: "0".repeat(64),
});
const chain: VerifyChain = {
  member: async (a) => (a === GRANTEE ? member(a, "kA") : a === GRANTOR ? member(a, "kB") : null),
  getEpoch: async () => ({ epoch: 42, cutoff_at: String(BigInt(NOW + 3_600_000) * 1_000_000n), phase: "open" }) as unknown as ContractAbi.EpochView,
  headroom: async () => "100000000",
  obligation: async () => null,
  pendingByPayer: async () => [],
};
const verifyWith = (requirements: PaymentRequirements, voucherWithSignature: any) => {
  const { signature, ...voucher } = voucherWithSignature;
  const payload = { x402Version: 2, resource: { url: "https://broker.example/grants/7/lease" }, accepted: requirements, payload: { voucher, signature } } as any;
  return new X207SchemeFacilitator({ network: NETWORK, circleContract: CIRCLE, verify: { chain, now: () => NOW } }).verify(payload, requirements);
};

describe("SD-053 grant voucher vector", () => {
  it("TC-SD-053-01 file passes schema.json, valid voucher, resource = x207:grant:7, payTo = grantor", () => {
    expect(new Ajv().compile(read("schema.json"))(vector)).toBe(true);
    expect(verifyVoucher(vector.input.voucher, vector.input.publicKey)).toBe(true);
    expect(vector.input.voucher.resource).toBe(grantResource(7));
    expect(vector.expected.resource).toBe("x207:grant:7");
    expect(vector.input.requirements.extra.grantId).toBe(7);
    expect(validatePaymentRequirements(vector.input.requirements).ok).toBe(true);
  });

  it("TC-SD-053-02 the facilitator accepts a grant voucher and rejects the broker payee and other resources", async () => {
    expect(await verifyWith(vector.input.requirements, vector.input.voucher)).toEqual({ isValid: true, payer: GRANTEE });
    for (const c of vector.cases) {
      expect(await verifyWith(c.requirements, c.voucher), c.name).toMatchObject({ isValid: false, invalidReason: c.facilitatorReason, payer: GRANTEE });
    }
  });
});

describe("SD-053 requirements and client", () => {
  const extraSource = (): X207ExtraSource =>
    ({ get: async () => ({ circleContract: CIRCLE, unit: "credit", decimals: 6, epoch: 42 }) }) as unknown as X207ExtraSource;

  it("TC-SD-053-03 buildPaymentRequirements: grantId only on the x207 entry, payTo is the grantor", async () => {
    const [x207, exact] = await buildPaymentRequirements({ circleId: "agents-main", payTo: GRANTOR, price: "0.25", extra: extraSource(), grantId: 7 });
    expect(x207!.payTo).toBe(GRANTOR);
    expect((x207!.extra as Record<string, unknown>).grantId).toBe(7);
    expect(exact!.extra).toEqual({});
    const [plain] = await buildPaymentRequirements({ circleId: "agents-main", payTo: GRANTOR, price: "0.25", extra: extraSource() });
    expect("grantId" in (plain!.extra as object)).toBe(false);
  });

  it("TC-SD-053-04 the client builds the voucher with payee = payTo (not the broker account) and resource x207:grant:7", async () => {
    const scheme = new X207SchemeClient({ payer: GRANTEE, secretKey: Buffer.from(keys.kA.seed, "hex"), store: new MemoryVoucherStateStore() });
    const client = new x402Client().register(X207_NETWORK_FAMILY, scheme);
    const result = await client.createPaymentPayload({ x402Version: 2, resource: { url: "https://broker.example/grants/7/lease" }, accepts: [vector.input.requirements] });
    const { voucher, signature } = result.payload as unknown as X207Payload;
    expect(voucher).toMatchObject({ payer: GRANTEE, payee: GRANTOR, resource: "x207:grant:7", epoch: 42, seq: 1, cumulativeAmount: "250000" });
    expect(verifyVoucher({ ...voucher, signature }, keys.kA.publicKey)).toBe(true);
    // the same bytes as the vector (same key and data)
    expect(signature).toBe(vector.input.voucher.signature);
  });

  it("TC-SD-053-05 middleware: route.grant sets payTo and extra.grantId per request; a missing grant answers 404", async () => {
    const middleware = x207Middleware({
      routes: {
        "/grants/7/lease": { price: "0.25", grant: () => ({ grantId: 7, payTo: GRANTOR }) },
        "/grants/9/lease": { price: "0.25", grant: () => undefined },
      },
      facilitatorUrl: "http://facilitator.invalid", circleId: "agents-main", payTo: "broker.x207-circle.near", extra: extraSource(),
    });
    const next = () => new Response("unreachable");
    const res = await middleware(new Request("http://broker.example/grants/7/lease"), next);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<{ scheme: string; payTo: string; extra: Record<string, unknown> }> };
    const x207 = body.accepts.find((a) => a.scheme === "batch-settlement")!;
    expect(x207.payTo).toBe(GRANTOR);
    expect(x207.extra.grantId).toBe(7);
    expect(body.accepts.find((a) => a.scheme === "exact")!.payTo).toBe(GRANTOR);
    const missing = await middleware(new Request("http://broker.example/grants/9/lease"), next);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "grant_not_found" });
  });
});
