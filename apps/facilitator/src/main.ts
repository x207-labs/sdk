// Menjalankan facilitator lokal: `npm run start -w @x207/facilitator`.
import { serve } from "@hono/node-server";
import { NotImplementedError } from "@x207/scheme";
import { createApp, type FacilitatorService } from "./app.js";
import { loadConfig } from "./config.js";
import { createSettle, createVerify } from "./chain.js";
import { PendingStore } from "./pending-store.js";
import { NearRegistrationChain } from "./relay.js";
import { RegistrationScheduler } from "./scheduler.js";
import { NearRpc } from "./rpc.js";

const config = loadConfig();
const pending = new PendingStore(config.pendingDbPath);

// supported diisi SD-032; sampai itu rute menjawab 500 internal_error.
const pending_ = (method: string, itemId: string) => async (): Promise<never> => {
  throw new NotImplementedError(method, itemId);
};
const rpc = new NearRpc({ urls: config.rpcUrls, timeoutMs: config.rpcTimeoutMs });
const service: FacilitatorService = {
  verify: createVerify(config.circles, rpc, pending),
  settle: createSettle(config.circles, rpc, pending),
  supported: pending_("supported", "SD-032"),
};

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
