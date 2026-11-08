// Runs the local facilitator: `npm run start -w @x207/facilitator`.
import { serve } from "@hono/node-server";
import type { KeyPairString } from "@near-js/crypto";
import { createFacilitatorNearSigner } from "@x402/near";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PendingStore } from "./pending-store.js";
import { EvmRelay, feeModeFor } from "./evm-relay.js";
import { NearContractCaller, NearRegistrationChain } from "./relay.js";
import { EXACT_NEAR_NETWORK, createFacilitatorService, type ExactNearNetwork } from "./service.js";
import { RegistrationScheduler } from "./scheduler.js";
import { NearRpc } from "./rpc.js";

const config = loadConfig();
const pending = new PendingStore(config.pendingDbPath);

// Default near:mainnet; X207_EXACT_NETWORK=near:testnet is only for testnet rehearsals.
const exactNetwork: ExactNearNetwork = process.env.X207_EXACT_NETWORK === "near:testnet" ? "near:testnet" : EXACT_NEAR_NETWORK;
const rpc = new NearRpc({ urls: config.rpcUrls, timeoutMs: config.rpcTimeoutMs });
// `exact` on near:mainnet needs a relayer account; without it the facilitator only serves x207.
const exactSigner = config.relayer
  ? createFacilitatorNearSigner({
      relayers: [{ accountId: config.relayer.accountId, secretKey: config.relayer.privateKey as KeyPairString }],
      rpcUrls: { [exactNetwork]: config.rpcUrls[0]! },
    })
  : undefined;
// The registration scheduler (SD-028) runs if a relayer account is configured; without it vouchers are only stored in D3.
const schedulers = config.relayer
  ? config.circles.map((circle) =>
      (() => {
        // SD-031: with a gas key, registration runs in parallel on different nonce lanes
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
  // SD-029 demo mode: `/settle` waits for on-chain registration, or answers `settlement_pending` after a timeout (SD-030).
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
// SD-089: relayer for EVM agents (`/evm/*`). Needs its own NEAR account (X207_EVM_RELAYER_ACCOUNT_ID and _PRIVATE_KEY; the registration relayer would share its nonce) and the circle it serves
// (X207_EVM_CIRCLE, a circle id of X207_CIRCLES; default the first). The account pays gas and the 0.35 NEAR deposit of each join.
const evmAccount = process.env.X207_EVM_RELAYER_ACCOUNT_ID;
const evmKey = process.env.X207_EVM_RELAYER_PRIVATE_KEY;
if (Boolean(evmAccount) !== Boolean(evmKey)) throw new Error("X207_EVM_RELAYER_ACCOUNT_ID and X207_EVM_RELAYER_PRIVATE_KEY must be set together");
const evmCircle = config.circles.find((c) => c.network === `x207:${process.env.X207_EVM_CIRCLE}`) ?? config.circles[0]!;
// A-SD-01: contract 0.0.16 and 0.0.17 sign a ninth field `maxFee`, and 0.0.17 takes `max_fee` on claim, exit, withdraw and auto-settle. X207_EVM_MAX_FEE = auto (default: read
// `interface_version` of the circle; 0.0.18 and later give "all" too), off (0.0.14/0.0.15), 0.0.16 (claim and withdraw) or 0.0.17 / 0.0.18 (all four routes; 0.0.18 changes no signed action).
const evmFeeSetting = process.env.X207_EVM_MAX_FEE ?? "auto";
const evmWithMaxFee: boolean | "all" =
  evmFeeSetting === "off" ? false : evmFeeSetting === "0.0.16" ? true : evmFeeSetting === "0.0.17" || evmFeeSetting === "0.0.18" ? "all"
  : evmFeeSetting === "auto" ? (evmAccount && evmKey ? feeModeFor(await rpc.view<string>(evmCircle.circleContract, "interface_version")) : false)
  : (() => { throw new Error("X207_EVM_MAX_FEE must be auto, off, 0.0.16, 0.0.17 or 0.0.18"); })();
const evm = evmAccount && evmKey
  ? new EvmRelay({
      circleContract: evmCircle.circleContract,
      withMaxFee: evmWithMaxFee,
      caller: new NearContractCaller({ rpc, circleContract: evmCircle.circleContract, account: { accountId: evmAccount, privateKey: evmKey }, onHash: (hash) => console.log(JSON.stringify({ evmRelayTx: hash })) }),
      ...(process.env.X207_EVM_STAKE_TOKEN && process.env.X207_EVM_STAKE_AMOUNT ? { stake: { tokenId: process.env.X207_EVM_STAKE_TOKEN, amount: process.env.X207_EVM_STAKE_AMOUNT } } : {}),
      maxDeadlineMs: Number(process.env.X207_EVM_MAX_DEADLINE_SECONDS || 900) * 1000,
      ...(process.env.X207_EVM_MAX_JOINS_PER_HOUR ? { maxJoinsPerHour: Number(process.env.X207_EVM_MAX_JOINS_PER_HOUR) } : {}),
    })
  : undefined;
const app = createApp(service, {
  ...(evm ? { evm } : {}),
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
