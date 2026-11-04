// `onboardMember` (SD-013): voucher keypair, join, stake via ft_transfer_call, wait for `pending` to become `active`.
import { generateVoucherKeypair, voucherPublicKey } from "../voucher.js";
import type { AccountId, U128String } from "../types.js";
import { buildJoinCall, buildStakeTransferCall, getMember, type CircleViewFn } from "./client.js";
import type { ContractCall } from "./settlement.js";
import type { MemberView } from "./types.generated.js";

export class OnboardTimeoutError extends Error {
  constructor(readonly status: string | null, timeoutMs: number) {
    super(`member is not active after ${timeoutMs} ms (last status: ${status ?? "not a member"})`);
    this.name = "OnboardTimeoutError";
  }
}

/** `ft_transfer_call` returns the amount the contract used; less than `amount` means partly refunded. */
export class StakeRejectedError extends Error {
  constructor(readonly used: string, readonly amount: string) {
    super(`stake rejected by the contract: used ${used} of ${amount} (the rest is refunded; check the member status and msg)`);
    this.name = "StakeRejectedError";
  }
}

export type OnboardDeps = {
  /** Send a transaction from the member account and return the receipt success value (JSON). Throws if the transaction fails. */
  sendCall(call: ContractCall): Promise<unknown>;
  view: CircleViewFn;
  /** Polling interval of `member` (default 1000 ms). */
  pollIntervalMs?: number;
  /** Limit on waiting for `active` (default 60000 ms). */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type OnboardInput = {
  circleContract: AccountId;
  circleId: string;
  accountId: AccountId;
  /** lowercase sha256 hex of the circle terms. */
  termsHash: string;
  /** Amount of USDT (smallest unit) locked as stake. */
  stakeAmount: U128String;
  /** An existing voucher key; if empty, a new one is created. */
  secretKey?: `ed25519:${string}`;
  usdtTokenId?: AccountId;
};

export type OnboardResult = { secretKey: `ed25519:${string}`; publicKey: `ed25519:${string}`; member: MemberView };

export async function onboardMember(deps: OnboardDeps, input: OnboardInput): Promise<OnboardResult> {
  const { secretKey, publicKey } = input.secretKey
    ? { secretKey: input.secretKey, publicKey: voucherPublicKey(input.secretKey) }
    : generateVoucherKeypair();

  await deps.sendCall(
    buildJoinCall({
      circleContract: input.circleContract, circleId: input.circleId, pubkeyVoucher: publicKey, termsHash: input.termsHash,
    }),
  );

  const used = await deps.sendCall(
    buildStakeTransferCall({
      circleContract: input.circleContract, amount: input.stakeAmount, memberId: input.accountId,
      ...(input.usdtTokenId ? { usdtTokenId: input.usdtTokenId } : {}),
    }),
  );
  if (typeof used === "string" && /^\d+$/.test(used) && BigInt(used) < BigInt(input.stakeAmount)) {
    throw new StakeRejectedError(used, input.stakeAmount);
  }

  const member = await waitUntilActive(deps, input.accountId);
  if (member.pubkey_voucher !== publicKey) {
    throw new Error(`pubkey_voucher in the contract (${member.pubkey_voucher}) is not the key that was created (${publicKey})`);
  }
  return { secretKey, publicKey, member };
}

async function waitUntilActive(deps: OnboardDeps, accountId: AccountId): Promise<MemberView> {
  const interval = deps.pollIntervalMs ?? 1000;
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let last: MemberView | null = null;
  for (;;) {
    last = await getMember(deps.view, accountId);
    if (last?.status === "active") return last;
    if (now() >= deadline) throw new OnboardTimeoutError(last?.status ?? null, timeoutMs);
    await sleep(interval);
  }
}
