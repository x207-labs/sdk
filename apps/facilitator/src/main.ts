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
        return new RegistrationScheduler({
          circleContract: circle.circleContract, store: pending, chain, mode: config.registerMode, concurrency: chain.concurrency,
          onRegistered: ({ payer }) => service.invalidatePayer?.(circle.circleContract, payer),
        });
      })(),
    )
  : [];
if (schedulers.length === 0) console.warn("X207_RELAYER_ACCOUNT_ID is empty: vouchers are not registered on-chain");
schedulers.forEach((scheduler) => scheduler.start());
const byContract = new Map(schedulers.map((scheduler, i) => [config.circles[i]!.circleContract, scheduler]));
// Chain reads of /verify are cached for a few seconds (src/chain-cache.ts); X207_CHAIN_CACHE=off turns it off.
const service = createFacilitatorService({
  circles: config.circles,
  rpc,
  pending,
  ...(process.env.X207_CHAIN_CACHE === "off" ? {} : { chainCache: {} }),
  ...(config.relayer ? { signers: [config.relayer.accountId] } : {}),
  ...(exactSigner
    ? {
        exactSigner, exactNetwork,
        ...(process.env.X207_EXACT_MAX_SPONSORED_GAS ? { exactMaxSponsoredGas: BigInt(process.env.X207_EXACT_MAX_SPONSORED_GAS) } : {}),
        exactGuard: {
          ...(process.env.X207_EXACT_FAILURE_LIMIT ? { failureLimit: Number(process.env.X207_EXACT_FAILURE_LIMIT) } : {}),
          ...(process.env.X207_EXACT_PAUSE_MS ? { pauseMs: Number(process.env.X207_EXACT_PAUSE_MS) } : {}),
        },
      }
    : {}),
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

// Rate limit on /verify and /settle per client: X207_RATE_LIMIT_MAX per minute (default 120, 0 = off); X207_TRUST_PROXY=1 reads x-forwarded-for.
const rateLimitMax = process.env.X207_RATE_LIMIT_MAX === undefined ? undefined : Number(process.env.X207_RATE_LIMIT_MAX);
const app = createApp(service, {
  rateLimit: rateLimitMax === 0 ? false : rateLimitMax === undefined ? {} : { max: rateLimitMax },
  trustProxy: process.env.X207_TRUST_PROXY === "1",
});

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`x207 facilitator listening on :${port} (${config.circles.map((c) => c.network).join(", ")})`);
});

process.on("SIGINT", () => {
  schedulers.forEach((scheduler) => scheduler.stop());
  server.close();
  pending.close();
  process.exit(0);
});
