// Source of the x207 `extra` for the server: the facilitator `GET /supported`, cached for at most 60 seconds (Spec Binding 5.3).
import { CREDIT_DECIMALS, CREDIT_UNIT, validateX207Extra, type X207Extra } from "@x207/core";
import { X207_SCHEME } from "../shared/circle.js";

export const EXTRA_CACHE_MS = 60_000;

export type X207ExtraSourceOptions = {
  facilitatorUrl: string;
  fetch?: typeof fetch;
  cacheMs?: number;
  now?: () => number;
};

type SupportedKinds = { kinds?: { scheme?: string; network?: string; extra?: unknown }[] };

export class X207ExtraSource {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private cache: { at: number; body: SupportedKinds } | undefined;

  constructor(options: X207ExtraSourceOptions) {
    this.url = options.facilitatorUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? fetch;
    this.cacheMs = options.cacheMs ?? EXTRA_CACHE_MS;
    this.now = options.now ?? Date.now;
  }

  /** `extra` for network `x207:<circleId>`; `epoch` follows the `/supported` cache, `unit` and `decimals` come from the core constants. */
  async get(network: string): Promise<X207Extra> {
    const body = await this.supported();
    const kind = body.kinds?.find((k) => k.scheme === X207_SCHEME && k.network === network);
    if (!kind) throw new Error(`facilitator does not support ${X207_SCHEME} on ${network}`);
    const extra = (kind.extra ?? {}) as Partial<X207Extra>;
    const full = { circleContract: extra.circleContract, unit: CREDIT_UNIT, decimals: CREDIT_DECIMALS, epoch: extra.epoch };
    const checked = validateX207Extra(full);
    if (!checked.ok) throw new Error(`extra /supported for ${network} not valid: ${checked.field} ${checked.message}`);
    return checked.value;
  }

  private async supported(): Promise<SupportedKinds> {
    if (this.cache && this.now() - this.cache.at < this.cacheMs) return this.cache.body;
    const response = await this.fetchFn(`${this.url}/supported`);
    if (!response.ok) throw new Error(`GET /supported failed: HTTP ${response.status}`);
    const body = (await response.json()) as SupportedKinds;
    this.cache = { at: this.now(), body };
    return body;
  }
}
