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
import { X207SchemeFacilitator, type CircleConfig, type VerifyOptions } from "@x207/scheme";
import { InvalidRequestError, type FacilitatorService, type PairStateQuery, type PairStateResponse } from "./app.js";
import { NearChain, PendingStoreWriter } from "./chain.js";
import type { PendingStore } from "./pending-store.js";
import type { NearRpc } from "./rpc.js";

export const EXACT_NEAR_NETWORK = "near:mainnet" as const;

export type FacilitatorServiceOptions = {
  circles: readonly CircleConfig[];
  rpc: NearRpc;
  pending: PendingStore;
  /** Akun relayer yang diiklankan di `signers`. */
  signers?: readonly AccountId[];
  /** Signer `exact` NEAR; tanpa ini `exact` tidak didaftarkan. */
  exactSigner?: FacilitatorNearSigner;
  verify?: Omit<VerifyOptions, "chain">;
  now?: () => number;
};

const invalidNetwork = (network: SettleResponse["network"]): SettleResponse => ({
  success: false, errorReason: "invalid_network", transaction: "", network,
});

export function createFacilitatorService(options: FacilitatorServiceOptions): FacilitatorService {
  const { circles, rpc, pending } = options;
  const facilitator = new x402Facilitator();
  const byNetwork = new Map<string, { circle: CircleConfig; scheme: X207SchemeFacilitator; chain: NearChain }>();

  for (const circle of circles) {
    const chain = new NearChain(rpc, circle, pending);
    const scheme = new X207SchemeFacilitator({
      network: circle.network,
      circleContract: circle.circleContract,
      signers: options.signers ?? [],
      verify: { ...options.verify, chain },
      store: new PendingStoreWriter(circle, pending),
      epochSource: {
        currentEpoch: async () => {
          const epoch = await chain.getEpoch();
          if (!epoch) throw new Error(`get_epoch kosong untuk ${circle.circleContract}`);
          return epoch.epoch;
        },
      },
      ...(options.now ? { now: options.now } : {}),
    });
    facilitator.register(circle.network, scheme);
    byNetwork.set(circle.network, { circle, scheme, chain });
  }
  if (options.exactSigner) facilitator.register(EXACT_NEAR_NETWORK, new ExactNearScheme(options.exactSigner));

  const registered = (requirements: PaymentRequirements): boolean =>
    facilitator.getSupported().kinds.some((k) => k.scheme === requirements.scheme && k.network === requirements.network);

  return {
    async verify({ paymentPayload, paymentRequirements }: VerifyRequest): Promise<VerifyResponse> {
      if (!registered(paymentRequirements as PaymentRequirements)) return { isValid: false, invalidReason: "invalid_network" };
      return facilitator.verify(paymentPayload as PaymentPayload, paymentRequirements as PaymentRequirements);
    },

    async settle({ paymentPayload, paymentRequirements }: SettleRequest): Promise<SettleResponse> {
      if (!registered(paymentRequirements as PaymentRequirements)) return invalidNetwork(paymentRequirements.network);
      return facilitator.settle(paymentPayload as PaymentPayload, paymentRequirements as PaymentRequirements);
    },

    async supported(): Promise<SupportedResponse> {
      await Promise.all([...byNetwork.values()].map(({ scheme }) => scheme.refreshExtra()));
      return facilitator.getSupported() as SupportedResponse;
    },

    async pairState({ network, payer, payee, epoch }: PairStateQuery): Promise<PairStateResponse> {
      const entry = byNetwork.get(network);
      if (!entry) throw new InvalidRequestError(`network ${network} tidak dikonfigurasi`);
      const [row] = (await entry.chain.pendingByPayer(payer, epoch)).filter((r) => r.payee === payee);
      const base = { network, payer, payee, epoch };
      if (row) return { ...base, lastSeq: row.seq, lastCumulativeAmount: row.cumulativeAmount, source: "pending" };
      const onchain = await entry.chain.obligation(epoch, payer, payee);
      if (onchain) return { ...base, lastSeq: onchain.last_seq, lastCumulativeAmount: onchain.cumulative, source: "onchain" };
      return { ...base, lastSeq: 0, lastCumulativeAmount: "0", source: "none" };
    },
  };
}
