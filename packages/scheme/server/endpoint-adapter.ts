// Class D reference adapter (SD-051, F8): the grantor's x402 endpoint is wrapped as an `AccessAssetAdapter` without changing the F2 flow.
// `deliver` = endpoint, `meter` = ADR-17 voucher (payee = grantor), `revoke` = the facilitator rejects a `suspended` payer (the contract sets the
// status; the adapter only records and notifies). `paywall()` returns exactly the same `x207Middleware`, so the 402 and its flow are identical.
import {
  meterGrant, priceOfGrant, type AccessAssetAdapter, type AccessGrant, type MeterCharge, type PriceQuote, type ProofResult, type RevokeReason, type Usage,
} from "@x207/core";
import { x207Middleware, type X207Middleware, type X207MiddlewareOptions } from "./middleware.js";

export type EndpointDelivery = { endpoint: string };

export type EndpointAdapterOptions = {
  /** Base URL of the seller endpoint handed to the recipient. */
  endpoint: string;
  /** Seller `x207Middleware` options, used as-is by `paywall()`. */
  paywall: X207MiddlewareOptions;
  /** Called on `revoke`; example: an operator flags the payer for re-review. The actual rejection is done by the facilitator (`member_not_active`). */
  onRevoke?: (grant: AccessGrant, reason: RevokeReason) => void | Promise<void>;
};

export class EndpointAdapter implements AccessAssetAdapter<EndpointDelivery> {
  readonly assetClass = "D" as const;
  /** Revoked grants, in time order. */
  readonly revoked: Array<{ grantId: number; grantee: string | null; reason: RevokeReason }> = [];
  readonly #options: EndpointAdapterOptions;

  // No parameter properties: this file is loaded by agents that use erasableSyntaxOnly.
  constructor(options: EndpointAdapterOptions) {
    this.#options = options;
  }

  price(grant: AccessGrant): PriceQuote {
    return priceOfGrant(grant);
  }

  /** Class D needs no proof: the endpoint belongs to the grantor itself. */
  prove(): ProofResult {
    return { valid: true };
  }

  deliver(): EndpointDelivery {
    return { endpoint: this.#options.endpoint };
  }

  meter(grant: AccessGrant, usage: Usage): MeterCharge {
    return meterGrant(grant, usage);
  }

  async revoke(grant: AccessGrant, reason: RevokeReason): Promise<void> {
    this.revoked.push({ grantId: grant.grant_id, grantee: grant.grantee ?? null, reason });
    await this.#options.onRevoke?.(grant, reason);
  }

  /** Seller middleware identical to `x207Middleware(options)`: the 402 and the F2 flow do not change. */
  paywall(): X207Middleware {
    return x207Middleware(this.#options.paywall);
  }
}
