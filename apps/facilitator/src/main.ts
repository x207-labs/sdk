// Menjalankan facilitator lokal: `npm run start -w @x207/facilitator`.
import { serve } from "@hono/node-server";
import { NotImplementedError } from "@x207/scheme";
import { createApp, type FacilitatorService } from "./app.js";
import { loadConfig } from "./config.js";
import { createSettle, createVerify } from "./chain.js";
import { PendingStore } from "./pending-store.js";
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

const server = serve({ fetch: createApp(service).fetch, port: config.port }, ({ port }) => {
  console.log(`x207 facilitator listening on :${port} (${config.circles.map((c) => c.network).join(", ")})`);
});

process.on("SIGINT", () => {
  server.close();
  pending.close();
  process.exit(0);
});
