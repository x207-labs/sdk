// Identitas binding dan validasi network lingkaran (SD-015, Spec Binding x402 5.3).
import type { AccountId, CircleNetwork } from "@x207/core";

export const X207_SCHEME = "batch-settlement" as const;
/** Pola yang didaftarkan lewat `register()` di klien, server, dan facilitator. */
export const X207_NETWORK_FAMILY = "x207:*" as const;

/** Regex CAIP-2; `register()` x402 tidak memvalidasi network, jadi dicek di konfigurasi. */
const CAIP2_NETWORK = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const X207_NAMESPACE = "x207:";

export class CircleIdError extends Error {
  constructor(network: string) {
    super(
      `network "${network}" is not a valid x207:<circleId> (CAIP-2 regex ^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$, no dot)`,
    );
    this.name = "CircleIdError";
  }
}

export function assertCircleId(network: string): asserts network is CircleNetwork {
  if (!CAIP2_NETWORK.test(network) || !network.startsWith(X207_NAMESPACE)) {
    throw new CircleIdError(network);
  }
}

export type CircleConfig = {
  network: CircleNetwork;
  circleContract: AccountId;
};

/** Konfigurasi satu lingkaran; gagal di sini, bukan saat request pertama. */
export function defineCircleConfig(input: { network: string; circleContract: AccountId }): CircleConfig {
  assertCircleId(input.network);
  return { network: input.network, circleContract: input.circleContract };
}

/** Kerangka SD-015: method yang isinya dikerjakan item lain melempar error ini. */
export class NotImplementedError extends Error {
  constructor(method: string, itemId: string) {
    super(`${method} is not implemented yet (${itemId})`);
    this.name = "NotImplementedError";
  }
}
