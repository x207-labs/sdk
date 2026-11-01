// Adaptor pembacaan on-chain dan pending store D3 untuk `verify` (SD-024).
import type { PaymentRequirements, VerifyRequest, VerifyResponse } from "@x402/core/types";
import type { AccountId, ContractAbi } from "@x207/core";
import { X207SchemeFacilitator, type CircleConfig, type VerifyChain, type VerifyOptions } from "@x207/scheme";
import type { PendingStore } from "./pending-store.js";
import type { NearRpc } from "./rpc.js";

/** View kontrak lewat `NearRpc` (dengan failover) dan baris pending dari `PendingStore`. */
export class NearChain implements VerifyChain {
  constructor(
    private readonly rpc: NearRpc,
    private readonly circle: CircleConfig,
    private readonly pending: PendingStore,
  ) {}

  private view<T>(method: string, args: object = {}): Promise<T> {
    return this.rpc.view<T>(this.circle.circleContract, method, args);
  }

  member(account: AccountId) {
    return this.view<ContractAbi.MemberView | null>("member", { account_id: account });
  }

  getEpoch() {
    return this.view<ContractAbi.EpochView | null>("get_epoch");
  }

  headroom(account: AccountId) {
    return this.view<string>("headroom", { account_id: account });
  }

  obligation(epoch: number, debtor: AccountId, creditor: AccountId) {
    return this.view<ContractAbi.ObligationView | null>("obligation", { epoch, debtor, creditor });
  }

  async pendingByPayer(payer: AccountId, epoch: number) {
    return this.pending
      .listByPayer(this.circle.circleContract, payer, epoch)
      .map((row) => ({ payee: row.payee, seq: row.seq, cumulativeAmount: row.cumulativeAmount, attempts: row.attempts }));
  }
}

/** `verify` untuk `FacilitatorService`: satu `X207SchemeFacilitator` per lingkaran yang dikonfigurasi. */
export function createVerify(
  circles: readonly CircleConfig[],
  rpc: NearRpc,
  pending: PendingStore,
  options: Omit<VerifyOptions, "chain"> = {},
): (request: VerifyRequest) => Promise<VerifyResponse> {
  const byNetwork = new Map(
    circles.map((circle) => [
      circle.network as string,
      new X207SchemeFacilitator({
        network: circle.network,
        circleContract: circle.circleContract,
        verify: { ...options, chain: new NearChain(rpc, circle, pending) },
      }),
    ]),
  );
  return async ({ paymentPayload, paymentRequirements }) => {
    const facilitator = byNetwork.get(paymentRequirements.network);
    if (!facilitator) return { isValid: false, invalidReason: "invalid_network" };
    return facilitator.verify(paymentPayload, paymentRequirements as PaymentRequirements);
  };
}
