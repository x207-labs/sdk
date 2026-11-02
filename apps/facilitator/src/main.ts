// Menjalankan facilitator lokal: `npm run start -w @x207/facilitator`.
import { serve } from "@hono/node-server";
import type { KeyPairString } from "@near-js/crypto";
import { createFacilitatorNearSigner } from "@x402/near";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PendingStore } from "./pending-store.js";
import { NearRegistrationChain } from "./relay.js";
import { EXACT_NEAR_NETWORK, createFacilitatorService, type ExactNearNetwork } from "./service.js";
import { RegistrationScheduler } from "./scheduler.js";
import { NearRpc } from "./rpc.js";

const config = loadConfig();
const pending = new PendingStore(config.pendingDbPath);

// Bawaan near:mainnet; X207_EXACT_NETWORK=near:testnet hanya untuk gladi testnet.
const exactNetwork: ExactNearNetwork = process.env.X207_EXACT_NETWORK === "near:testnet" ? "near:testnet" : EXACT_NEAR_NETWORK;
const rpc = new NearRpc({ urls: config.rpcUrls, timeoutMs: config.rpcTimeoutMs });
// `exact` near:mainnet butuh akun relayer; tanpa itu facilitator hanya melayani x207.
const exactSigner = config.relayer
  ? createFacilitatorNearSigner({
      relayers: [{ accountId: config.relayer.accountId, secretKey: config.relayer.privateKey as KeyPairString }],
      rpcUrls: { [exactNetwork]: config.rpcUrls[0]! },
    })
  : undefined;
// Penjadwal registrasi (SD-028) jalan bila akun relayer dikonfigurasi; tanpa itu voucher hanya tersimpan di D3.
const schedulers = config.relayer
  ? config.circles.map((circle) =>
      (() => {
        // SD-031: dengan gas key, registrasi berjalan paralel di jalur nonce berbeda
        const chain = new NearRegistrationChain({ rpc, circleContract: circle.circleContract, relayer: config.relayer!, ...(config.gasKey ? { gasKey: config.gasKey } : {}) });
        return new RegistrationScheduler({ circleContract: circle.circleContract, store: pending, chain, mode: config.registerMode, concurrency: chain.concurrency });
      })(),
    )
  : [];
if (schedulers.length === 0) console.warn("X207_RELAYER_ACCOUNT_ID kosong: voucher tidak diregistrasi on-chain");
schedulers.forEach((scheduler) => scheduler.start());
const byContract = new Map(schedulers.map((scheduler, i) => [config.circles[i]!.circleContract, scheduler]));
const service = createFacilitatorService({
  circles: config.circles,
  rpc,
  pending,
  ...(config.relayer ? { signers: [config.relayer.accountId] } : {}),
  ...(exactSigner ? { exactSigner, exactNetwork } : {}),
  // Mode demo SD-029: `/settle` menunggu registrasi on-chain, atau menjawab `settlement_pending` setelah timeout (SD-030).
  ...(config.registerMode === "per_request"
    ? {
        perRequest: {
          registerNow: async (circleContract: string, key: { payer: string; payee: string; epoch: number }) =>
            (await byContract.get(circleContract)?.registerNow(key)) ?? { status: "none" as const },
          timeoutMs: config.settleTimeoutMs,
        },
      }
    : {}),
});

const server = serve({ fetch: createApp(service).fetch, port: config.port }, ({ port }) => {
  console.log(`x207 facilitator listening on :${port} (${config.circles.map((c) => c.network).join(", ")})`);
});

process.on("SIGINT", () => {
  schedulers.forEach((scheduler) => scheduler.stop());
  server.close();
  pending.close();
  process.exit(0);
});
