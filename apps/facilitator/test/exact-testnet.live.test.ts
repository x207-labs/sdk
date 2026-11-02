// SD-034 on NEAR testnet: an agent outside every circle pays a seller endpoint through the facilitator with the `exact` scheme of
// @x402/near (NEP-366 delegate action; the relayer pays the gas). Real accounts of Main B (x207b-*), a mock USDT, the free testnet RPC.
// Every transaction hash goes to the file in X207_DEMO_RECORD as soon as it exists. Keys are read from the keys directory and never printed.
// Run: X207_TESTNET=1 X207_DEMO_RECORD=/path/testnet-demo.json X207_KEYS_DIR=/path/.secrets/testnet-deployer npx vitest run apps/facilitator/test/exact-testnet.live.test.ts
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import { ExactNearScheme as ExactNearClient, createClientNearSigner, createFacilitatorNearSigner } from "@x402/near";
import { PendingStore, createApp, createFacilitatorService, NearRpc } from "../src/index.js";
import { recordStep } from "../../../test-support/demo-record.js";

const ENABLED = process.env.X207_TESTNET === "1";
const RPC = process.env.X207_TESTNET_RPC ?? "https://rpc.testnet.fastnear.com";
const RECORD = process.env.X207_DEMO_RECORD ?? "";
const KEYS = process.env.X207_KEYS_DIR ?? "";
// `usdt.fakes.testnet` is a standard NEP-141 test token (6 decimals, with storage management and an open `mint`). The mock_ft of the contracts
// repository has no `storage_balance_of`, which @x402/near checks, so it cannot stand in for USDT on this path.
const [USDT, RELAYER, BUYER, SELLER] = ["usdt.fakes.testnet", "x207b-relayer.testnet", "x207b-buyer.testnet", "x207b-seller.testnet"];
const PRICE = "20000"; // 0.02 credit, 6 decimals

const secretOf = (id: string): string => (JSON.parse(readFileSync(join(KEYS, "testnet", `${id}.json`), "utf8")) as { secret_key: string }).secret_key;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function patient<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= 12 || !/429|rate limit/i.test(`${(error as Error).message}`)) throw error;
      await sleep(4000 + attempt * 2000);
    }
  }
}

describe.skipIf(!ENABLED)("SD-034 exact NEAR on testnet", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.closeAllConnections?.() ?? s.close()));

  it("a buyer outside the circle pays a seller endpoint through the facilitator; the relayer pays the gas", async () => {
    expect(RECORD && KEYS, "set X207_DEMO_RECORD and X207_KEYS_DIR").toBeTruthy();
    const provider = new JsonRpcProvider({ url: RPC });
    const accountOf = (id: string) => new Account(id, provider, KeyPairSigner.fromSecretKey(secretOf(id) as never));
    const view = async <T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> =>
      (await patient(() => provider.callFunction({ contractId: contract, method, args }))) as T;
    const near = async (id: string) => BigInt((await patient(() => provider.viewAccount({ accountId: id }))).amount);
    const step = (s: string, hash: string, account: string, method: string, note?: string) =>
      recordStep(RECORD, { section: "sd-034-exact", step: s, account, method, hash, ...(note ? { note } : {}) });

    // USDT.e: register buyer and seller, mint to the buyer when it holds less than 1 USDT
    const balanceOf = async (id: string) => BigInt(await view<string>(USDT, "ft_balance_of", { account_id: id }));
    const storageDeposit = async (who: string) => {
      if ((await view<unknown>(USDT, "storage_balance_of", { account_id: who })) !== null) return;
      const r = (await patient(() => accountOf(who).callFunctionRaw({ contractId: USDT, methodName: "storage_deposit", args: { account_id: who, registration_only: true }, deposit: 10n ** 22n, gas: 50_000_000_000_000n, waitUntil: "FINAL" }))) as any;
      step(`register ${who} on the token`, r.transaction.hash, who, "storage_deposit");
    };
    await storageDeposit(BUYER);
    await storageDeposit(SELLER);
    if ((await balanceOf(BUYER)) < 1_000_000n) {
      const minted = (await patient(() => accountOf(BUYER).callFunctionRaw({ contractId: USDT, methodName: "mint", args: { account_id: BUYER, amount: "5000000" }, deposit: 0n, gas: 50_000_000_000_000n, waitUntil: "FINAL" }))) as any;
      step("mint 5 USDT.e to the buyer", minted.transaction.hash, BUYER, "mint");
    }

    // facilitator with only `exact` on near:testnet; the relayer is x207b-relayer
    const facilitator = createApp(
      createFacilitatorService({
        circles: [], rpc: new NearRpc({ urls: [RPC], timeoutMs: 20_000 }), pending: new PendingStore(":memory:"),
        exactNetwork: "near:testnet",
        exactSigner: createFacilitatorNearSigner({ relayers: [{ accountId: RELAYER, secretKey: secretOf(RELAYER) as never }], rpcUrls: { "near:testnet": RPC } }),
      }),
    );
    const post = (path: string, body: unknown) => facilitator.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const requirements = { scheme: "exact", network: "near:testnet", amount: PRICE, asset: USDT, payTo: SELLER, maxTimeoutSeconds: 60, extra: {} };
    const resource = { url: "http://seller.local/api/summarize" };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
    const decode = (header: string | null) => JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8"));

    // seller endpoint: 402 with the exact entry; with a payment it asks the facilitator, then answers
    let settled: { success: boolean; transaction?: string; network?: string; payer?: string } | undefined;
    const seller = createServer((req, res) => {
      void (async () => {
        const header = req.headers["payment-signature"];
        if (typeof header !== "string") {
          res.writeHead(402, { "PAYMENT-REQUIRED": encode({ x402Version: 2, resource, accepts: [requirements] }) }).end();
          return;
        }
        const body = { x402Version: 2, paymentPayload: decode(header), paymentRequirements: requirements };
        const verified = (await (await post("/verify", body)).json()) as { isValid: boolean; invalidReason?: string };
        if (!verified.isValid) return void res.writeHead(402, { "x-reason": verified.invalidReason ?? "invalid" }).end();
        settled = (await (await post("/settle", body)).json()) as typeof settled;
        res.writeHead(settled?.success ? 200 : 402, { "PAYMENT-RESPONSE": encode(settled) }).end(JSON.stringify({ summary: "halo" }));
      })();
    });
    servers.push(seller);
    await new Promise<void>((r) => seller.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(seller.address() as AddressInfo).port}/api/summarize`;

    // buyer: not a member of any circle, no NEAR needed for gas
    const buyerSigner = createClientNearSigner({ accountId: BUYER, secretKey: secretOf(BUYER) as never, rpcUrls: { "near:testnet": RPC } });
    const client = new ExactNearClient(buyerSigner);
    const [buyerUsdtBefore, sellerUsdtBefore, buyerNearBefore, relayerNearBefore] = [await balanceOf(BUYER), await balanceOf(SELLER), await near(BUYER), await near(RELAYER)];

    const challenge = await fetch(url);
    expect(challenge.status).toBe(402);
    const accepted = decode(challenge.headers.get("PAYMENT-REQUIRED")).accepts[0];
    expect(accepted).toMatchObject({ scheme: "exact", network: "near:testnet", payTo: SELLER, asset: USDT, amount: PRICE });
    const created = await client.createPaymentPayload(2, accepted);
    const paid = await fetch(url, { headers: { "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource, accepted, payload: created.payload }) } });
    expect(paid.status, `verify reason ${paid.headers.get("x-reason")}; settle ${JSON.stringify(settled)}`).toBe(200);
    expect(settled).toMatchObject({ success: true, network: "near:testnet", payer: BUYER });
    step("exact payment settled by the relayer", settled!.transaction!, RELAYER, "submit SignedDelegate (ft_transfer)", `buyer ${BUYER} pays ${PRICE} to ${SELLER}`);

    // on-chain: the seller got the amount, the transaction was signed by the relayer, the buyer spent no NEAR on gas
    const [buyerUsdtAfter, sellerUsdtAfter, buyerNearAfter, relayerNearAfter] = [await balanceOf(BUYER), await balanceOf(SELLER), await near(BUYER), await near(RELAYER)];
    expect(buyerUsdtBefore - buyerUsdtAfter).toBe(BigInt(PRICE));
    expect(sellerUsdtAfter - sellerUsdtBefore).toBe(BigInt(PRICE));
    const tx = (await patient(() => provider.viewTransactionStatus({ txHash: settled!.transaction!, accountId: RELAYER, waitUntil: "FINAL" } as never))) as any;
    expect(tx.transaction.signer_id).toBe(RELAYER);
    expect(tx.status).toHaveProperty("SuccessValue");
    expect(buyerNearBefore - buyerNearAfter, "the buyer pays at most the 1 yocto deposit").toBeLessThanOrEqual(1n);
    expect(relayerNearBefore - relayerNearAfter, "the relayer paid the gas").toBeGreaterThan(0n);
    recordStep(RECORD, { section: "sd-034-exact", step: "balances", note: `USDT buyer ${buyerUsdtBefore}->${buyerUsdtAfter}, seller ${sellerUsdtBefore}->${sellerUsdtAfter}; NEAR buyer delta ${buyerNearBefore - buyerNearAfter} yocto, relayer paid ${relayerNearBefore - relayerNearAfter} yocto` });
  }, 300_000);
});
