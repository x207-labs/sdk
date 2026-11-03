// Adaptor pembacaan on-chain dan pending store D3 untuk `verify` (SD-024).
import type { PaymentRequirements, SettleRequest, SettleResponse, VerifyRequest, VerifyResponse } from "@x402/core/types";
import type { AccountId, ContractAbi, Ed25519Signature, UnsignedVoucher } from "@x207/core";
import {
  X207SchemeFacilitator,
  type CircleConfig,
  type PendingWriter,
  type VerifyChain,
  type VerifyOptions,
} from "@x207/scheme";
import type { PendingStore } from "./pending-store.js";
import type { NearRpc } from "./rpc.js";

/** Lowest interface version that has the view `is_frozen` (CT-095). */
export const FREEZE_MIN_VERSION = "0.0.12";
/** How long the interface version of the contract is remembered: a contract can be upgraded in place, and then the freeze view appears. */
export const VERSION_TTL_MS = 60_000;

/** `a >= b` for versions `x.y.z`, compared by number (so `0.0.9` is below `0.0.12`); a text that is not a version is an error. */
export function versionAtLeast(a: string, b: string): boolean {
  const parse = (v: string): number[] => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (!m) throw new Error(`interface_version not valid: ${JSON.stringify(v)}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return true;
}

/** View kontrak lewat `NearRpc` (dengan failover) dan baris pending dari `PendingStore`. */
export class NearChain implements VerifyChain {
  #freeze: { at: number; value: Promise<boolean> } | null = null;
  readonly #now: () => number;

  constructor(
    private readonly rpc: NearRpc,
    private readonly circle: CircleConfig,
    private readonly pending: PendingStore,
    options: { now?: () => number } = {},
  ) {
    this.#now = options.now ?? Date.now;
  }

  /**
   * Does the contract have the view `is_frozen`? Read from `interface_version` and remembered for `VERSION_TTL_MS` (B5-F2, review BE-062). A contract below 0.0.12 has no freeze, so nothing is
   * frozen there; from 0.0.12 on the view MUST answer, and a failure of it is an error (fail closed), not "not frozen". A failed read of the version is not remembered.
   */
  #hasFreeze(): Promise<boolean> {
    const hit = this.#freeze;
    if (hit && this.#now() - hit.at < VERSION_TTL_MS) return hit.value;
    const value = this.view<string>("interface_version").then((version) => versionAtLeast(version, FREEZE_MIN_VERSION));
    this.#freeze = { at: this.#now(), value };
    value.catch(() => {
      if (this.#freeze?.value === value) this.#freeze = null;
    });
    return value;
  }

  private view<T>(method: string, args: object = {}): Promise<T> {
    return this.rpc.view<T>(this.circle.circleContract, method, args);
  }

  member(account: AccountId) {
    return this.view<ContractAbi.MemberView | null>("member", { account_id: account });
  }

  getEpoch() {
    return this.view<ContractAbi.EpochView | null>("get_epoch");
  }

  bundle(bundleId: number) {
    return this.view<ContractAbi.BundleView | null>("get_bundle", { bundle_id: bundleId });
  }

  async isFrozen(account: AccountId): Promise<boolean> {
    if (!(await this.#hasFreeze())) return false;
    return this.view<boolean>("is_frozen", { account_id: account });
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
      .map((row) => ({ payee: row.payee, seq: row.seq, cumulativeAmount: row.cumulativeAmount, attempts: row.attempts, bundleId: row.bundleId }));
  }
}

/** `PendingStore` sebagai penulis D3 untuk `settle` satu lingkaran. */
export class PendingStoreWriter implements PendingWriter {
  constructor(private readonly circle: CircleConfig, private readonly pending: PendingStore) {}

  save(voucher: UnsignedVoucher, signature: Ed25519Signature, bundleId?: number): boolean {
    return this.pending.upsert(this.circle.circleContract, voucher, signature, bundleId);
  }

  get(payer: AccountId, payee: AccountId, epoch: number) {
    const row = this.pending.get({ circleContract: this.circle.circleContract, payer, payee, epoch });
    return row
      ? { seq: row.seq, cumulativeAmount: row.cumulativeAmount, signature: row.signature, registeredSeq: row.registeredSeq, attempts: row.attempts, bundleId: row.bundleId }
      : null;
  }
}

function facilitatorsOf(
  circles: readonly CircleConfig[],
  rpc: NearRpc,
  pending: PendingStore,
  options: Omit<VerifyOptions, "chain">,
) {
  return new Map(
    circles.map((circle) => [
      circle.network as string,
      new X207SchemeFacilitator({
        network: circle.network,
        circleContract: circle.circleContract,
        verify: { ...options, chain: new NearChain(rpc, circle, pending) },
        store: new PendingStoreWriter(circle, pending),
      }),
    ]),
  );
}

/** `verify` untuk `FacilitatorService`: satu `X207SchemeFacilitator` per lingkaran yang dikonfigurasi. */
export function createVerify(
  circles: readonly CircleConfig[],
  rpc: NearRpc,
  pending: PendingStore,
  options: Omit<VerifyOptions, "chain"> = {},
): (request: VerifyRequest) => Promise<VerifyResponse> {
  const byNetwork = facilitatorsOf(circles, rpc, pending, options);
  return async ({ paymentPayload, paymentRequirements }) => {
    const facilitator = byNetwork.get(paymentRequirements.network);
    if (!facilitator) return { isValid: false, invalidReason: "invalid_network" };
    return facilitator.verify(paymentPayload, paymentRequirements as PaymentRequirements);
  };
}

/** `settle` untuk `FacilitatorService` (SD-026): verify ulang lalu simpan ke D3. */
export function createSettle(
  circles: readonly CircleConfig[],
  rpc: NearRpc,
  pending: PendingStore,
  options: Omit<VerifyOptions, "chain"> = {},
): (request: SettleRequest) => Promise<SettleResponse> {
  const byNetwork = facilitatorsOf(circles, rpc, pending, options);
  return async ({ paymentPayload, paymentRequirements }) => {
    const facilitator = byNetwork.get(paymentRequirements.network);
    if (!facilitator) {
      return { success: false, errorReason: "invalid_network", transaction: "", network: paymentRequirements.network };
    }
    return facilitator.settle(paymentPayload, paymentRequirements as PaymentRequirements);
  };
}
