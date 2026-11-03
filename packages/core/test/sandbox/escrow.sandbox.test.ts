// SD-050 di near-sandbox (interface 0.0.7, CT-075): log nyata `escrow_held` dan `escrow_failed` dari kontrak ter-parse oleh parser, dan tipe
// `EscrowView` cocok dengan view `get_escrow`. Dengan X207_UPDATE_FIXTURES=1 log disimpan ke spec/test-vectors/events/sandbox/.
// Alur: pemberi menawarkan grant kelas A (`escrow_nft`), menyetor NFT lewat `nft_transfer_call` (`escrow_held`); pembeli yang tidak bisa
// menerima NFT memanggil `complete_escrow` dan transfer gagal (`escrow_failed`, pembayaran dibatalkan); pembeli lain menyelesaikannya.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createCircleViewFn, escrowGrantScope, onboardMember, parseEventLog, signVoucher, type AccessGrant, type ContractAbi, type EscrowView } from "@x207/core";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../../test-support/circle.js";
import { MOCK_NFT_WASM, sandboxAvailable } from "../../../../test-support/sandbox.js";

const OUT = fileURLToPath(new URL("../../../../spec/test-vectors/events/sandbox/", import.meta.url));
const PRICE = "10000000";

describe.skipIf(!sandboxAvailable)("SD-050 class A escrow on near-sandbox", () => {
  let fx: CircleFixture;
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-050-11 real escrow_held and escrow_failed logs parse; get_escrow matches EscrowView", async () => {
    fx = await deployCircle();
    const lines = new Map<string, string>();
    const collect = (logs: string[]) => {
      for (const line of logs) for (const event of parseEventLog(line) ?? []) if (!lines.has(event.event)) lines.set(event.event, line);
    };
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
    const onboard = async (name: string) => {
      const account = await fx.member(name);
      const result = await onboardMember(
        {
          sendCall: async (c) => {
            const r = await account.call(c);
            if (r.failures.length > 0) throw new Error(r.failures.join("; "));
            return r.value;
          },
          view, pollIntervalMs: 200, timeoutMs: 30_000,
        },
        { circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: account.accountId, termsHash: TERMS_HASH, stakeAmount: "150000000", usdtTokenId: fx.usdt.accountId },
      );
      return { account, ...result };
    };
    const seller = await onboard("alice");
    const blocked = await onboard("bob");
    const buyer = await onboard("carol");

    const ok = async (r: { failures: string[]; logs: string[] }, what: string) => {
      expect(r.failures, what).toEqual([]);
      collect(r.logs);
    };
    const dao = await fx.sandbox.createAccount("dao", "5");
    const entry = { asset_type: "nft:ticket", class: "A", delivery_methods: ["escrow_nft"], accepted_proofs: [], terms_hash: "5a".repeat(32) };
    await ok(await dao.call({ receiverId: fx.circle.accountId, methodName: "set_asset_class", args: { asset_type: entry.asset_type, entry }, deposit: 0n }), "set_asset_class");

    const nft = await fx.sandbox.createAccount("nft", "10");
    await fx.sandbox.deploy(nft, MOCK_NFT_WASM);
    await ok(await nft.call({ receiverId: nft.accountId, methodName: "new", args: {}, deposit: 0n }), "nft new");
    await ok(await nft.call({ receiverId: nft.accountId, methodName: "nft_mint", args: { token_id: "t1", owner_id: seller.account.accountId }, deposit: 0n }), "nft_mint");

    const expiresAt = BigInt(await fx.sandbox.blockTimestampMs()) * 1_000_000n + 3_600_000_000_000n;
    await ok(await seller.account.call({
      receiverId: fx.circle.accountId, methodName: "offer_grant", deposit: 0n,
      args: { input: { asset_type: entry.asset_type, delivery_method: "escrow_nft", limits: { scope: escrowGrantScope(nft.accountId, "t1"), quota: null, expires_at: expiresAt.toString() }, unit: "once", unit_price: PRICE, operator: null, proof_hash: null, proof_kind: null } },
    }), "offer_grant");
    await ok(await seller.account.call({
      receiverId: nft.accountId, methodName: "nft_transfer_call", deposit: 1n, gas: 150_000_000_000_000n,
      args: { receiver_id: fx.circle.accountId, token_id: "t1", msg: JSON.stringify({ grant_id: 1 }) },
    }), "nft_transfer_call");

    const held = await fx.sandbox.view<EscrowView | null>(fx.circle.accountId, "get_escrow", { grant_id: 1 });
    expect(held).toMatchObject({ grant_id: 1, nft_contract: nft.accountId, token_id: "t1", state: "held" });
    const [heldEvent] = parseEventLog(lines.get("escrow_held")!)!;
    expect(heldEvent).toMatchObject({ event: "escrow_held", grant_id: 1, nft_contract: nft.accountId, token_id: "t1" });

    const epoch = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {});
    const pay = (who: typeof blocked) => {
      const { signature, ...voucher } = signVoucher(
        { circle: fx.circle.accountId, payer: who.account.accountId, payee: seller.account.accountId, epoch: epoch.epoch, seq: 1, cumulativeAmount: PRICE, unit: "credit", resource: "https://example.test/api" },
        who.secretKey,
      );
      return { grant_id: 1, voucher, signature };
    };
    // Penerima yang diblok NFT: transfer gagal, pembayaran dibatalkan, escrow kembali `held`, grant tetap `offered`.
    await ok(await nft.call({ receiverId: nft.accountId, methodName: "block_receiver", args: { account_id: blocked.account.accountId }, deposit: 0n }), "block_receiver");
    // Panic NFT di receipt `nft_transfer` ikut terlapor di `failures`; transaksi lingkaran sendiri sukses (callback memulihkan).
    const tried = await blocked.account.call({ receiverId: fx.circle.accountId, methodName: "complete_escrow", args: pay(blocked), deposit: 0n, gas: 200_000_000_000_000n });
    expect(tried.failures.join(" ")).toContain("The receiver cannot receive tokens");
    collect(tried.logs);
    const [failedEvent] = parseEventLog(lines.get("escrow_failed")!)!;
    expect(failedEvent).toMatchObject({ event: "escrow_failed", grant_id: 1, step: "complete", reverted: true, payer: blocked.account.accountId, payee: seller.account.accountId, delta: PRICE });
    expect(await fx.sandbox.view<EscrowView | null>(fx.circle.accountId, "get_escrow", { grant_id: 1 })).toMatchObject({ state: "held" });
    expect(await fx.sandbox.view<AccessGrant | null>(fx.circle.accountId, "get_grant", { grant_id: 1 })).toMatchObject({ status: "offered" });

    // Pembeli lain menyelesaikannya.
    await ok(await buyer.account.call({ receiverId: fx.circle.accountId, methodName: "complete_escrow", args: pay(buyer), deposit: 0n, gas: 200_000_000_000_000n }), "complete_escrow");
    expect(await fx.sandbox.view<EscrowView | null>(fx.circle.accountId, "get_escrow", { grant_id: 1 })).toMatchObject({ state: "delivered", buyer: buyer.account.accountId });
    expect(await fx.sandbox.view<AccessGrant | null>(fx.circle.accountId, "get_grant", { grant_id: 1 })).toMatchObject({ status: "active", grantee: buyer.account.accountId });

    if (process.env.X207_UPDATE_FIXTURES === "1") {
      mkdirSync(OUT, { recursive: true });
      for (const name of ["escrow_held", "escrow_failed"]) writeFileSync(`${OUT}${name}.log`, `${lines.get(name)}\n`);
    }
  }, 600_000);
});
