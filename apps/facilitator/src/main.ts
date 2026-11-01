// Menjalankan facilitator lokal: `npm run start -w @x207/facilitator`.
import { serve } from "@hono/node-server";
import type { KeyPairString } from "@near-js/crypto";
import { createFacilitatorNearSigner } from "@x402/near";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PendingStore } from "./pending-store.js";
import { NearRegistrationChain } from "./relay.js";
import { EXACT_NEAR_NETWORK, createFacilitatorService } from "./service.js";
import { RegistrationScheduler } from "./scheduler.js";
import { NearRpc } from "./rpc.js";

const config = loadConfig();
const pending = new PendingStore(config.pendingDbPath);

const rpc = new NearRpc({ urls: config.rpcUrls, timeoutMs: config.rpcTimeoutMs });
// `exact` near:mainnet butuh akun relayer; tanpa itu facilitator hanya melayani x207.
const exactSigner = config.relayer
  ? createFacilitatorNearSigner({
      relayers: [{ accountId: config.relayer.accountId, secretKey: config.relayer.privateKey as KeyPairString }],
      rpcUrls: { [EXACT_NEAR_NETWORK]: config.rpcUrls[0]! },
    })
  : undefined;
const service = createFacilitatorService({
  circles: config.circles,
  rpc,
  pending,
  ...(config.relayer ? { signers: [config.relayer.accountId] } : {}),
  ...(exactSigner ? { exactSigner } : {}),
});

// Penjadwal registrasi (SD-028) jalan bila akun relayer dikonfigurasi; tanpa itu voucher hanya tersimpan di D3.
const schedulers = config.relayer
  ? config.circles.map((circle) =>
      new RegistrationScheduler({
        circleContract: circle.circleContract,
        store: pending,
        chain: new NearRegistrationChain({ rpc, circleContract: circle.circleContract, relayer: config.relayer! }),
        mode: config.registerMode,
      }),
    )
  : [];
if (schedulers.length === 0) console.warn("X207_RELAYER_ACCOUNT_ID kosong: voucher tidak diregistrasi on-chain");
schedulers.forEach((scheduler) => scheduler.start());

const server = serve({ fetch: createApp(service).fetch, port: config.port }, ({ port }) => {
  console.log(`x207 facilitator listening on :${port} (${config.circles.map((c) => c.network).join(", ")})`);
});

process.on("SIGINT", () => {
  schedulers.forEach((scheduler) => scheduler.stop());
  server.close();
  pending.close();
  process.exit(0);
});
