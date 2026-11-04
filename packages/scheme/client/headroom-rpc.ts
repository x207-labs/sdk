// `HeadroomSource` from the contract views: `member` (null if not a member) then `headroom`.
import { createCircleViewFn, getMember } from "@x207/core";
import type { HeadroomSource } from "./select.js";

export function headroomFromRpc(options: { rpcUrls?: readonly string[]; fetch?: typeof fetch } = {}): HeadroomSource {
  return async (circleContract, payer) => {
    const view = createCircleViewFn({
      circleContract,
      ...(options.rpcUrls ? { rpcUrls: options.rpcUrls } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    if ((await getMember(view, payer)) === null) return null;
    return (await view("headroom", { account_id: payer })) as string;
  };
}
