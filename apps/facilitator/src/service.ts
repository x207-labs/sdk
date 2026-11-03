// Rangkaian facilitator (SD-032): `x402Facilitator` dengan binding `x207:*` untuk tiap lingkaran dan
// `exact` `near:mainnet` dari `@x402/near`; `/supported` dan `/x207/pair-state` (Spec Binding x402 8.3, 8.5).
import { x402Facilitator } from "@x402/core/facilitator";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleRequest,
  SettleResponse,
  SupportedResponse,
  VerifyRequest,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/facilitator";
import type { AccountId } from "@x207/core";
import type { RegisterOutcome } from "./scheduler.js";
import { X207SchemeFacilitator, type CircleConfig, type VerifyOptions } from "@x207/scheme";
import { InvalidRequestError, type FacilitatorService, type PairStateQuery, type PairStateResponse } from "./app.js";
import { NearChain, PendingStoreWriter } from "./chain.js";
import { CachedVerifyChain, type ChainCacheOptions } from "./chain-cache.js";
import { EXACT_DEFAULT_MAX_SPONSORED_GAS, ExactSenderGuard, verifiedExactPayer, type ExactGuardOptions } from "./exact-guard.js";
import type { PendingStore } from "./pending-store.js";
import type { NearRpc } from "./rpc.js";

export const EXACT_NEAR_NETWORK = "near:mainnet" as const;
/** Jaringan `exact` yang didukung `@x402/near`; testnet hanya untuk gladi (SD-034). */
export type ExactNearNetwork = "near:mainnet" | "near:testnet";

export type FacilitatorServiceOptions = {
  circles: readonly CircleConfig[];
  rpc: NearRpc;
  pending: PendingStore;
  /** Akun relayer yang diiklankan di `signers`. */
  signers?: readonly AccountId[];
  /** Signer `exact` NEAR; tanpa ini `exact` tidak didaftarkan. */
  exactSigner?: FacilitatorNearSigner;
  /** Jaringan untuk `exactSigner`; bawaan `near:mainnet`. */
  exactNetwork?: ExactNearNetwork;
  /** Most gas a delegated `ft_transfer` may ask (default `EXACT_DEFAULT_MAX_SPONSORED_GAS`, 30 Tgas). The relayer pays it also when the transfer fails. */
  exactMaxSponsoredGas?: bigint;
  /** Failed settlements per payer before a pause (see `exact-guard.ts`). */
  exactGuard?: ExactGuardOptions;
  verify?: Omit<VerifyOptions, "chain">;
  /** Short-lived cache of the chain reads of `verify` (see `chain-cache.ts` for what may be stale). Off when absent. */
  chainCache?: ChainCacheOptions;
  now?: () => number;
  /**
   * Mode demo `register_voucher` per request (SD-029, SD-030): setiap `/settle` yang berhasil menyimpan voucher langsung meminta
   * registrasi on-chain dan menunggu final paling lama `timeoutMs` (default 10 detik, ADR-25). Final: `registration: "registered"`.
   * Belum final: `success: false, errorReason: "settlement_pending"` (non-terminal, resource tetap dilayani) dan registrasi
   * berjalan terus lalu diulang penjadwal sesuai ADR-23. Gagal terminal (mis. `insufficient_credit` dibuang): kode itu dikembalikan.
   */
  perRequest?: {
    registerNow: (circleContract: AccountId, key: { payer: AccountId; payee: AccountId; epoch: number }) => Promise<RegisterOutcome>;
    timeoutMs?: number;
  };
};

/** Batas tunggu registrasi per request (ADR-25). */
export const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

const PENDING = Symbol("pending");

const invalidNetwork = (network: SettleResponse["network"]): SettleResponse => ({
  success: false, errorReason: "invalid_network", transaction: "", network,
});

export function createFacilitatorService(options: FacilitatorServiceOptions): FacilitatorService {
  const { circles, rpc, pending } = options;
  const facilitator = new x402Facilitator();
  const byNetwork = new Map<string, { circle: CircleConfig; scheme: X207SchemeFacilitator; chain: NearChain | CachedVerifyChain }>();
  const caches = new Map<string, CachedVerifyChain>();

  for (const circle of circles) {
    const plain = new NearChain(rpc, circle, pending);
    const chain = options.chainCache ? new CachedVerifyChain(plain, options.chainCache) : plain;
    if (chain instanceof CachedVerifyChain) caches.set(circle.circleContract, chain);
    const scheme = new X207SchemeFacilitator({
      network: circle.network,
      circleContract: circle.circleContract,
      signers: options.signers ?? [],
      verify: { ...options.verify, chain },
      store: new PendingStoreWriter(circle, pending),
      epochSource: {
        currentEpoch: async () => {
          const epoch = await chain.getEpoch();
          if (!epoch) throw new Error(`get_epoch is empty for ${circle.circleContract}`);
          return epoch.epoch;
        },
      },
      ...(options.now ? { now: options.now } : {}),
    });
    facilitator.register(circle.network, scheme);
    byNetwork.set(circle.network, { circle, scheme, chain });
  }
  const exactGuard = new ExactSenderGuard(options.exactGuard);
  if (options.exactSigner) {
    facilitator.register(
      options.exactNetwork ?? EXACT_NEAR_NETWORK,
      new ExactNearScheme(options.exactSigner, undefined, { maxSponsoredGas: options.exactMaxSponsoredGas ?? EXACT_DEFAULT_MAX_SPONSORED_GAS }),
    );
  }

  const registered = (requirements: PaymentRequirements): boolean =>
    facilitator.getSupported().kinds.some((k) => k.scheme === requirements.scheme && k.network === requirements.network);

  /** `exact`: refuse a paused payer before anything is submitted, and count a settlement that was submitted and failed (the relayer paid its gas). */
  async function settleExact(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const payer = verifiedExactPayer(payload);
    const paused = payer === undefined ? 0 : exactGuard.pausedFor(payer);
    if (paused > 0) {
      return {
        success: false, errorReason: "payer_paused", errorMessage: `too many failed settlements; retry in ${Math.ceil(paused / 1000)} s`,
        transaction: "", network: requirements.network, payer,
      };
    }
    const response = await facilitator.settle(payload, requirements);
    if (response.payer !== undefined && payer === response.payer) {
      if (response.success) exactGuard.recordSuccess(payer);
      else if (response.errorReason === "settlement_failed") exactGuard.recordFailure(payer);
    }
    return response;
  }

  return {
    invalidatePayer(circleContract: AccountId, payer: AccountId): void {
      caches.get(circleContract)?.invalidatePayer(payer);
    },

    async verify({ paymentPayload, paymentRequirements }: VerifyRequest): Promise<VerifyResponse> {
      if (!registered(paymentRequirements as PaymentRequirements)) return { isValid: false, invalidReason: "invalid_network" };
      return facilitator.verify(paymentPayload as PaymentPayload, paymentRequirements as PaymentRequirements);
    },

    async settle({ paymentPayload, paymentRequirements }: SettleRequest): Promise<SettleResponse> {
      if (!registered(paymentRequirements as PaymentRequirements)) return invalidNetwork(paymentRequirements.network);
      if (paymentRequirements.scheme === "exact") return settleExact(paymentPayload as PaymentPayload, paymentRequirements as PaymentRequirements);
      const response = await facilitator.settle(paymentPayload as PaymentPayload, paymentRequirements as PaymentRequirements);
      const perRequest = options.perRequest;
      const entry = byNetwork.get(paymentRequirements.network);
      const x207 = (response.extensions as { x207?: { epoch?: number; registration?: string } } | undefined)?.x207;
      if (!perRequest || !entry || !response.success || !response.payer || x207?.epoch === undefined || x207.registration === "registered") return response;

      const key = { payer: response.payer, payee: paymentRequirements.payTo, epoch: x207.epoch };
      const attempt = perRequest.registerNow(entry.circle.circleContract, key);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        attempt,
        new Promise<typeof PENDING>((resolve) => {
          timer = setTimeout(() => resolve(PENDING), perRequest.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      // Registrasi yang terlambat tetap berjalan; kegagalannya dicatat penjadwal, jadi tidak boleh menjadi penolakan tak tertangani.
      attempt.catch(() => undefined);

      const withRegistration = (registration: string) => ({ ...response, extensions: { ...response.extensions, x207: { ...x207, registration } } });
      if (outcome === PENDING || outcome.status === "retrying") return { ...withRegistration("pending"), success: false, errorReason: "settlement_pending" };
      if (outcome.status === "failed") return { ...withRegistration("pending"), success: false, errorReason: outcome.code };
      return withRegistration("registered");
    },

    async supported(): Promise<SupportedResponse> {
      await Promise.all([...byNetwork.values()].map(({ scheme }) => scheme.refreshExtra()));
      return facilitator.getSupported() as SupportedResponse;
    },

    async pairState({ network, payer, payee, epoch }: PairStateQuery): Promise<PairStateResponse> {
      const entry = byNetwork.get(network);
      if (!entry) throw new InvalidRequestError(`network ${network} is not configured`);
      const [row] = (await entry.chain.pendingByPayer(payer, epoch)).filter((r) => r.payee === payee);
      const base = { network, payer, payee, epoch };
      if (row) return { ...base, lastSeq: row.seq, lastCumulativeAmount: row.cumulativeAmount, source: "pending" };
      const onchain = await entry.chain.obligation(epoch, payer, payee);
      if (onchain) return { ...base, lastSeq: onchain.last_seq, lastCumulativeAmount: onchain.cumulative, source: "onchain" };
      return { ...base, lastSeq: 0, lastCumulativeAmount: "0", source: "none" };
    },
  };
}
