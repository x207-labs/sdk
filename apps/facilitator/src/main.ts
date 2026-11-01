// Menjalankan facilitator lokal: `npm run start -w @x207/facilitator`.
import { serve } from "@hono/node-server";
import { NotImplementedError } from "@x207/scheme";
import { createApp, type FacilitatorService } from "./app.js";
import { loadConfig } from "./config.js";
import { PendingStore } from "./pending-store.js";

const config = loadConfig();
const pending = new PendingStore(config.pendingDbPath);

// verify, settle, dan supported diisi SD-024, SD-026, dan SD-032; sampai itu rute menjawab 500 internal_error.
const pending_ = (method: string, itemId: string) => async (): Promise<never> => {
  throw new NotImplementedError(method, itemId);
};
const service: FacilitatorService = {
  verify: pending_("verify", "SD-024"),
  settle: pending_("settle", "SD-026"),
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
