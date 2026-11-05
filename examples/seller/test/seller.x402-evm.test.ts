// SD-096: same flow as seller.base-sepolia.test.ts, but the EVM buyer is the real ExactEvmScheme of @x402/evm and the Base Sepolia facilitator
// is the real ExactEvmScheme facilitator (structure, EIP-712 signature and time checks run in the library; only the chain reads and the write are stubbed).
// Was: SD-093: the seller answers 402 with three entries (x207, exact near:mainnet, exact eip155:84532). A member pays by voucher at the x207 facilitator,
// an EVM buyer outside the circle pays `exact` on Base Sepolia at its own (mock) x402 facilitator. No keys, no network, no funds.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wrapFetchWithPayment } from "@x402/fetch";
import { describe, expect, it } from "vitest";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { ExactEvmScheme as ExactEvmFacilitator } from "@x402/evm/exact/facilitator";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { X207PaymentClient, defineCircleConfig } from "@x207/scheme";
import { PendingStore, createApp, createFacilitatorService, type NearRpc } from "../../../apps/facilitator/src/index.js";
import { BASE_SEPOLIA_NETWORK, BASE_SEPOLIA_USDC, createSeller } from "../src/seller.js";

const keys = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8"),
).keys;
const A = "translator.x207-circle.near";
const B = "summarizer.x207-circle.near";
const NETWORK = "x207:agents-main";
const SELLER_EVM = "0x1111111111111111111111111111111111111111";
const CUTOFF_NS = String(BigInt(Date.now() + 3_600_000) * 1_000_000n);
const member = (account: string, pubkey: string) => ({
  account_id: account, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 42,
  limit: "1000000", pubkey_voucher: pubkey, settled_history: "0", stake: "1000000", status: "active", terms_hash: "0".repeat(64),
});
const VIEWS: Record<string, (args: any) => unknown> = {
  get_epoch: () => ({ epoch: 42, cutoff_at: CUTOFF_NS, phase: "open" }),
  member: ({ account_id }) => (account_id === A ? member(A, keys.kA.publicKey) : account_id === B ? member(B, keys.kB.publicKey) : null),
  is_frozen: () => false,
  interface_version: () => "0.0.14",
  headroom: () => "1000000",
  obligation: () => null,
  last_seq: () => 0,
};


// A fresh key for this run, never stored. Its address is the buyer.
const buyer = privateKeyToAccount(generatePrivateKey());
const BUYER_EVM = buyer.address;

type Seen = { host: string; path: string; body: any };

/** The chain side of the facilitator: signature checking is real (viem, local), reads return a funded, unused authorization, the write is recorded. */
function facilitatorSigner(writes: any[]) {
  return {
    getAddresses: () => ["0x3333333333333333333333333333333333333333"] as const,
    verifyTypedData: (args: any) => verifyTypedData(args),
    readContract: async (args: any) => {
      if (args.functionName === "balanceOf") return 10n ** 12n;
      if (args.functionName === "authorizationState") return false;
      // the library simulates the transfer with an eth_call before it accepts the payload: the stub says it would succeed
      if (args.functionName === "transferWithAuthorization") return undefined;
      throw new Error(`stub has no readContract ${args.functionName}`);
    },
    writeContract: async (args: any) => { writes.push(args); return `0x${"ab".repeat(32)}`; },
    sendTransaction: async () => { throw new Error("unexpected sendTransaction"); },
    waitForTransactionReceipt: async () => ({ status: "success" }),
    // the USDC contract has code, the buyer (an EOA) has none
    getCode: async ({ address }: { address: string }) => (address.toLowerCase() === BASE_SEPOLIA_USDC.toLowerCase() ? "0x6001" : undefined),
  } as never;
}

function world() {
  const seen: Seen[] = [];
  const writes: any[] = [];
  const verdicts: any[] = [];
  const baseFacilitator = new ExactEvmFacilitator(facilitatorSigner(writes));
  const rpc = { view: async (_c: string, method: string, args: any) => (VIEWS[method] ?? (() => { throw new Error(`no view ${method}`); }))(args) } as unknown as NearRpc;
  const x207Facilitator = createApp(
    createFacilitatorService({
      circles: [defineCircleConfig({ network: NETWORK, circleContract: "x207-circle.near" })], rpc, pending: new PendingStore(":memory:"),
    }),
  );
  let routed: typeof fetch;
  const seller = createSeller({
    facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B,
    baseSepolia: { payTo: SELLER_EVM, facilitatorUrl: "http://base.facilitator.test" },
    fetch: (i, n) => routed(i, n),
  });
  routed = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const { hostname, pathname } = new URL(request.url);
    if (hostname === "base.facilitator.test") {
      const body = (await request.json()) as any;
      seen.push({ host: hostname, path: pathname, body });
      const { paymentPayload, paymentRequirements } = body;
      const result = pathname === "/verify" ? await baseFacilitator.verify(paymentPayload, paymentRequirements) : await baseFacilitator.settle(paymentPayload, paymentRequirements);
      verdicts.push({ path: pathname, result });
      return Response.json(result);
    }
    if (hostname === "facilitator.test") {
      if (request.method === "POST") seen.push({ host: hostname, path: pathname, body: await request.clone().json() });
      return x207Facilitator.fetch(request);
    }
    return seller.fetch(request);
  }) as typeof fetch;
  return { routed, seen, writes, verdicts };
}

const URL_ = "https://seller.test/api/summarize";
const decode = (header: string | null) => JSON.parse(Buffer.from(header!, "base64").toString("utf8"));

describe("SD-096 seller example with the real @x402/evm exact scheme", () => {
  it("TC-SD-096-01 the payload of ExactEvmScheme passes the library facilitator: structure, EIP-712 signature, time window, balance", async () => {
    const { routed, seen, writes, verdicts } = world();
    const client = new X207PaymentClient({ payer: BUYER_EVM, secretKey: Buffer.from(keys.kZ.seed, "hex"), headroom: async () => null });
    client.register("eip155:*", new ExactEvmClient(buyer));
    const response = await wrapFetchWithPayment(routed, client)(URL_);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: "summary text" });

    const verify = verdicts.find((v) => v.path === "/verify")!.result;
    expect(verify).toMatchObject({ isValid: true, payer: BUYER_EVM });
    const settle = verdicts.find((v) => v.path === "/settle")!.result;
    expect(settle).toMatchObject({ success: true, network: BASE_SEPOLIA_NETWORK, payer: BUYER_EVM, transaction: `0x${"ab".repeat(32)}` });
    expect(decode(response.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: true, network: BASE_SEPOLIA_NETWORK });

    // what the library signed is what the seller asked for
    const payload = seen.find((s) => s.path === "/verify")!.body.paymentPayload;
    expect(payload.accepted).toMatchObject({ scheme: "exact", network: BASE_SEPOLIA_NETWORK, asset: BASE_SEPOLIA_USDC, payTo: SELLER_EVM, amount: "20000" });
    expect(payload.payload.authorization).toMatchObject({ from: BUYER_EVM, to: SELLER_EVM, value: "20000" });
    expect(payload.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
    // settle would call transferWithAuthorization on the USDC contract
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ address: BASE_SEPOLIA_USDC, functionName: "transferWithAuthorization" });
    // the x207 facilitator saw nothing of this payment
    expect(seen.filter((s) => s.host === "facilitator.test" && (s.path === "/verify" || s.path === "/settle"))).toEqual([]);
  });

  it("TC-SD-096-02 a tampered payload is refused by the library (value changed after signing)", async () => {
    const { routed, verdicts } = world();
    const client = new X207PaymentClient({ payer: BUYER_EVM, secretKey: Buffer.from(keys.kZ.seed, "hex"), headroom: async () => null });
    client.register("eip155:*", new ExactEvmClient(buyer));
    // a wrapper that alters the signed authorization before it reaches the seller
    const tampering: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const raw = headers.get("PAYMENT-SIGNATURE");
      if (raw) {
        const p = decode(raw);
        p.payload.authorization.value = "1";
        headers.set("PAYMENT-SIGNATURE", Buffer.from(JSON.stringify(p), "utf8").toString("base64"));
      }
      return routed(input instanceof Request ? new Request(input, { headers }) : input, { ...init, headers });
    };
    const response = await wrapFetchWithPayment(tampering, client)(URL_);
    expect(response.status).toBe(402);
    const refusal = verdicts.find((v) => v.path === "/verify")!.result;
    expect(refusal).toMatchObject({ isValid: false, invalidReason: "invalid_exact_evm_signature" });
    expect(verdicts.some((v) => v.path === "/settle")).toBe(false);
  });
});
