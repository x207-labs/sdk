// An agent that holds only an EVM key (`0x…`). It joins an x207 circle through the relayer, pays x402 endpoints with EIP-712 vouchers, claims what it is owed and exits. It has no NEAR key,
// no NEAR account and no NEAR token: the relayer pays the gas and the join deposit, and the agent only signs. Nothing here prints or returns the private key.
import { wrapFetchWithPayment } from "@x402/fetch";
import { createCircleViewFn, type AccountId, type CircleViewFn } from "@x207/core";
import { evmSignerFromPrivateKey, type EvmVoucherSigner } from "@x207/core/evm";
import { X207PaymentClient, headroomFromRpc } from "@x207/scheme";

export type EvmAgentOptions = {
  /** `0x` + 64 hex characters. */
  privateKey: string;
  /** Base URL of the facilitator that runs the relayer routes `/evm/*`. */
  relayerUrl: string;
  /** The circle contract, e.g. `x207-v014.testnet`. */
  circleContract: AccountId;
  rpcUrls?: readonly string[];
  fetch?: typeof fetch;
  /** Unix ms; the signature deadline is `now() + ttlMs`. Default `Date.now` (a sandbox passes its block time). */
  now?: () => number;
  /** How long a signed action stays valid (default 10 minutes; the relayer refuses more than 15 minutes ahead, security review M3). */
  ttlMs?: number;
  /**
   * SD-100: set for a circle of contract 0.0.16 (`x207-v016.testnet`), where every signed action has the ninth field `maxFee`. The value is the ceiling of the relayer's fee for `claim` and
   * `withdrawStake` (credit unit, 6 decimals); every other action signs 0. Leave it out for 0.0.14 and 0.0.15 (eight fields), and the relayer must run with `withMaxFee` to match.
   */
  maxFee?: bigint | number | string;
};

export type FeeOption = { /** Overrides `EvmAgentOptions.maxFee` for this call. */ maxFee?: bigint | number | string };

export type RelayAnswer = { ok: true; method: string; txHash: string; stakeTxHash?: string };

export class RelayRefused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`relayer refused (${status} ${code}): ${message}`);
    this.name = "RelayRefused";
  }
}

export interface EvmAgent {
  /** The member id in the circle: the lower-case `0x` address. */
  readonly id: `0x${string}`;
  readonly signer: EvmVoucherSigner;
  /** Join the circle (nonce 0). The relayer pays the deposit and, on testnet, stakes for the agent. */
  join(termsHash: string): Promise<RelayAnswer>;
  /** `fetch` that pays x402 `x207` entries with an EIP-712 voucher of this agent. */
  payFetch(): typeof fetch;
  /** Claim what the agent is owed in a finalized epoch; the payout goes to the NEAR account `receiver`. */
  claim(epoch: number, receiver: string, fee?: FeeOption): Promise<RelayAnswer>;
  /** Withdraw the stake to the NEAR account `receiver` (the member must have asked to exit). */
  withdrawStake(receiver: string, fee?: FeeOption): Promise<RelayAnswer>;
  /** Ask to leave the circle. */
  exit(): Promise<RelayAnswer>;
  /** Opt in (or out) of settlement from the stake: a due that is missed is paid from the stake by `finalize_epoch` and the agent stays active (contract 0.0.15). */
  setAutoSettle(enabled: boolean): Promise<RelayAnswer>;
  /** Next nonce for a member action, read from the contract (`evm_signer`). */
  nextNonce(): Promise<number>;
}

export function createEvmAgent(options: EvmAgentOptions): EvmAgent {
  const signer = evmSignerFromPrivateKey(options.privateKey);
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 600_000;
  const base = options.relayerUrl.replace(/\/+$/, "");
  const view: CircleViewFn = createCircleViewFn({ circleContract: options.circleContract, ...(options.rpcUrls ? { rpcUrls: options.rpcUrls } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });

  /** 0.0.16: the ninth field is signed on every action; the actions that take no fee sign 0. For 0.0.14 and 0.0.15 (no `maxFee` option) nothing is added. */
  const feeFree = options.maxFee === undefined ? {} : { maxFee: 0 };
  /** The ceiling of the fee of `claim` and `withdrawStake`: the call's, else the agent's; `undefined` for an eight-field circle. */
  const feeOf = (fee: FeeOption): bigint | number | string | undefined => fee.maxFee ?? options.maxFee;

  async function relay(path: string, body: object): Promise<RelayAnswer> {
    const response = await doFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const answer = (await response.json()) as { ok?: boolean; error?: string; message?: string } & RelayAnswer;
    if (!response.ok || answer.ok !== true) throw new RelayRefused(response.status, answer.error ?? "unknown", answer.message ?? "");
    return answer;
  }

  const agent: EvmAgent = {
    id: signer.id,
    signer,
    async nextNonce() {
      const record = (await view("evm_signer", { account_id: signer.id })) as { nonce: string | number } | null;
      return record === null ? 0 : Number(record.nonce);
    },
    async join(termsHash) {
      const deadline = now() + ttl;
      const signature = await signer.signAction({ circle: options.circleContract, action: "join", epoch: 0, receiver: "", termsHash, nonce: 0, deadline }, feeFree);
      return relay("/evm/join", { address: signer.id, termsHash, deadline, signature });
    },
    payFetch() {
      const client = new X207PaymentClient({
        payer: signer.id,
        signer,
        headroom: headroomFromRpc({ ...(options.rpcUrls ? { rpcUrls: options.rpcUrls } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) }),
      });
      return wrapFetchWithPayment(doFetch, client);
    },
    async claim(epoch, receiver, fee = {}) {
      const nonce = await agent.nextNonce();
      const deadline = now() + ttl;
      const maxFee = feeOf(fee);
      const signature = await signer.signAction({ circle: options.circleContract, action: "claim", epoch, receiver, termsHash: "", nonce, deadline }, maxFee === undefined ? {} : { maxFee });
      return relay("/evm/claim", { member: signer.id, epoch, receiver, nonce, deadline, ...(maxFee === undefined ? {} : { maxFee: String(maxFee) }), signature });
    },
    async withdrawStake(receiver, fee = {}) {
      const nonce = await agent.nextNonce();
      const deadline = now() + ttl;
      const maxFee = feeOf(fee);
      const signature = await signer.signAction({ circle: options.circleContract, action: "withdraw_stake", epoch: 0, receiver, termsHash: "", nonce, deadline }, maxFee === undefined ? {} : { maxFee });
      return relay("/evm/withdraw", { member: signer.id, receiver, nonce, deadline, ...(maxFee === undefined ? {} : { maxFee: String(maxFee) }), signature });
    },
    async setAutoSettle(enabled) {
      const nonce = await agent.nextNonce();
      const deadline = now() + ttl;
      const signature = await signer.signAction({ circle: options.circleContract, action: enabled ? "auto_settle" : "auto_settle_off", epoch: 0, receiver: "", termsHash: "", nonce, deadline }, feeFree);
      return relay("/evm/auto-settle", { member: signer.id, enabled, nonce, deadline, signature });
    },
    async exit() {
      const nonce = await agent.nextNonce();
      const deadline = now() + ttl;
      const signature = await signer.signAction({ circle: options.circleContract, action: "request_exit", epoch: 0, receiver: "", termsHash: "", nonce, deadline }, feeFree);
      return relay("/evm/exit", { member: signer.id, nonce, deadline, signature });
    },
  };
  return agent;
}
