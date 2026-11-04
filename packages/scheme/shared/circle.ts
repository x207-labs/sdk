// Binding identity and circle network validation (SD-015, x402 Binding Spec 5.3).
import type { AccountId, CircleNetwork } from "@x207/core";

export const X207_SCHEME = "batch-settlement" as const;
/** The pattern registered through `register()` on the client, server, and facilitator. */
export const X207_NETWORK_FAMILY = "x207:*" as const;

/** CAIP-2 regex; x402 `register()` does not validate the network, so it is checked in configuration. */
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

/** Configuration of one circle; fails here, not on the first request. */
export function defineCircleConfig(input: { network: string; circleContract: AccountId }): CircleConfig {
  assertCircleId(input.network);
  return { network: input.network, circleContract: input.circleContract };
}

/** SD-015 skeleton: a method whose body is done by another item throws this error. */
export class NotImplementedError extends Error {
  constructor(method: string, itemId: string) {
    super(`${method} is not implemented yet (${itemId})`);
    this.name = "NotImplementedError";
  }
}
