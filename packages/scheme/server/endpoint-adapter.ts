// Adaptor referensi kelas D (SD-051, F8): endpoint x402 milik pemberi dibungkus sebagai `AccessAssetAdapter` tanpa mengubah alur F2.
// `deliver` = endpoint, `meter` = voucher ADR-17 (payee = pemberi), `revoke` = facilitator menolak payer yang `suspended` (kontrak yang menyetel
// status; adaptor hanya mencatat dan memberi tahu). `paywall()` mengembalikan `x207Middleware` yang sama persis, jadi 402 dan alurnya identik.
import {
  meterGrant, priceOfGrant, type AccessAssetAdapter, type AccessGrant, type MeterCharge, type PriceQuote, type ProofResult, type RevokeReason, type Usage,
} from "@x207/core";
import { x207Middleware, type X207Middleware, type X207MiddlewareOptions } from "./middleware.js";

export type EndpointDelivery = { endpoint: string };

export type EndpointAdapterOptions = {
  /** URL dasar endpoint penjual yang diserahkan ke penerima. */
  endpoint: string;
  /** Opsi `x207Middleware` penjual, dipakai apa adanya oleh `paywall()`. */
  paywall: X207MiddlewareOptions;
  /** Dipanggil saat `revoke`; contoh: operator menandai payer untuk diperiksa ulang. Penolakan sebenarnya dilakukan facilitator (`member_not_active`). */
  onRevoke?: (grant: AccessGrant, reason: RevokeReason) => void | Promise<void>;
};

export class EndpointAdapter implements AccessAssetAdapter<EndpointDelivery> {
  readonly assetClass = "D" as const;
  /** Grant yang dicabut, urut waktu. */
  readonly revoked: Array<{ grantId: number; grantee: string | null; reason: RevokeReason }> = [];
  readonly #options: EndpointAdapterOptions;

  // Tanpa parameter property: berkas ini dimuat agents yang memakai erasableSyntaxOnly.
  constructor(options: EndpointAdapterOptions) {
    this.#options = options;
  }

  price(grant: AccessGrant): PriceQuote {
    return priceOfGrant(grant);
  }

  /** Kelas D tidak butuh bukti: endpoint adalah milik pemberi sendiri. */
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

  /** Middleware penjual yang sama dengan `x207Middleware(opsi)`: 402 dan alur F2 tidak berubah. */
  paywall(): X207Middleware {
    return x207Middleware(this.#options.paywall);
  }
}
