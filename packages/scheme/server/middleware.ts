// Middleware server x207 (SD-017, SD-027, Spec Binding x402 bagian 2, 4, 5.3): 402 dengan `accepts`,
// `/verify` lalu handler lalu `/settle`, dan `PAYMENT-RESPONSE`. Berbasis Request/Response web standar,
// jadi bisa dipasang di Hono (`c.req.raw`), Express (adapter), atau fetch handler apa pun.
import type { PaymentRequirements } from "@x402/core/types";
import type { AccountId, PairState } from "@x207/core";
import { X207ExtraSource } from "./extra.js";
import { buildPaymentRequirements } from "./index.js";

export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";
/** Timeout panggilan facilitator (ADR-25). */
export const FACILITATOR_TIMEOUT_MS = 10_000;
export const RETRY_AFTER_SECONDS = 5;

const RESYNC_REASONS = new Set(["seq_not_increasing", "cumulative_decreased", "amount_mismatch"]);

export type X207RouteConfig = { price: string | number; description?: string; mimeType?: string };

export type X207MiddlewareOptions = {
  /** Kunci `"/path"` atau `"METHOD /path"`. Rute di luar daftar diteruskan ke handler tanpa 402. */
  routes: Record<string, X207RouteConfig>;
  facilitatorUrl: string;
  circleId: string;
  payTo: AccountId;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Menggantikan sumber `extra` bawaan (cache `/supported`, 60 detik). */
  extra?: X207ExtraSource;
};

export type NextHandler = (request: Request) => Response | Promise<Response>;
export type X207Middleware = (request: Request, next: NextHandler) => Promise<Response>;

class FacilitatorUnavailable extends Error {}

const toBase64 = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

function fromBase64(header: string): any {
  const text = Buffer.from(header, "base64").toString("utf8");
  if (!text || Buffer.from(text, "utf8").toString("base64").replace(/=+$/, "") !== header.replace(/=+$/, "")) {
    throw new Error("bukan base64");
  }
  return JSON.parse(text);
}

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function paymentRequiredResponse(
  resource: { url: string; description?: string; mimeType?: string },
  accepts: PaymentRequirements[],
  error: string,
  settleResponse?: unknown,
): Response {
  const body = { x402Version: 2, error, resource, accepts };
  const headers = new Headers({ "content-type": "application/json", [HEADER_PAYMENT_REQUIRED]: toBase64(body) });
  if (settleResponse !== undefined) headers.set(HEADER_PAYMENT_RESPONSE, toBase64(settleResponse));
  return new Response(JSON.stringify(body), { status: 402, headers });
}

const unavailable = (message: string): Response =>
  new Response(JSON.stringify({ error: "facilitator_unavailable", message }), {
    status: 503,
    headers: { "content-type": "application/json", "Retry-After": String(RETRY_AFTER_SECONDS) },
  });

export function x207Middleware(options: X207MiddlewareOptions): X207Middleware {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? FACILITATOR_TIMEOUT_MS;
  const base = options.facilitatorUrl.replace(/\/+$/, "");
  const extra = options.extra ?? new X207ExtraSource({ facilitatorUrl: base, fetch: fetchFn });

  async function call(path: string, init?: RequestInit): Promise<any> {
    let response: Response;
    try {
      response = await fetchFn(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new FacilitatorUnavailable(`${path}: ${(error as Error).message}`);
    }
    if (response.status >= 500) throw new FacilitatorUnavailable(`${path}: HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new FacilitatorUnavailable(`${path}: jawaban bukan JSON`);
    }
  }
  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function resyncResponse(
    reason: string,
    payload: any,
    network: string,
  ): Promise<Record<string, unknown> | undefined> {
    const voucher = payload?.payload?.voucher;
    if (!isRecord(voucher)) return undefined;
    const query = new URLSearchParams({
      network, payer: String(voucher.payer), payee: String(voucher.payee), epoch: String(voucher.epoch),
    });
    try {
      const state = (await call(`/x207/pair-state?${query}`)) as PairState;
      if (typeof state?.lastSeq !== "number") return undefined;
      return {
        success: false, errorReason: reason, transaction: "", network, payer: voucher.payer,
        extensions: { x207: { epoch: voucher.epoch, lastSeq: state.lastSeq, lastCumulativeAmount: state.lastCumulativeAmount } },
      };
    } catch {
      return undefined;
    }
  }

  return async (request, next) => {
    const url = new URL(request.url);
    const route = options.routes[`${request.method} ${url.pathname}`] ?? options.routes[url.pathname];
    if (!route) return next(request);

    const resource = {
      url: request.url,
      ...(route.description ? { description: route.description } : {}),
      ...(route.mimeType ? { mimeType: route.mimeType } : {}),
    };

    let accepts: PaymentRequirements[];
    try {
      accepts = await buildPaymentRequirements({
        circleId: options.circleId, payTo: options.payTo, price: route.price, resource: request.url, extra,
      });
    } catch (error) {
      return unavailable((error as Error).message);
    }

    const header = request.headers.get(HEADER_PAYMENT_SIGNATURE);
    if (header === null) return paymentRequiredResponse(resource, accepts, "PAYMENT-SIGNATURE header is required");

    let payload: any;
    try {
      payload = fromBase64(header);
    } catch {
      return paymentRequiredResponse(resource, accepts, "invalid_payload");
    }
    const accepted = isRecord(payload) ? payload.accepted : undefined;
    const requirements = accepts.find((r) => r.scheme === accepted?.scheme && r.network === accepted?.network);
    if (!requirements) return paymentRequiredResponse(resource, accepts, "invalid_payload");
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements };

    try {
      const verdict = await post("/verify", body);
      if (!verdict?.isValid) {
        const reason = String(verdict?.invalidReason ?? "invalid_payload");
        const resync = RESYNC_REASONS.has(reason) ? await resyncResponse(reason, payload, requirements.network) : undefined;
        return paymentRequiredResponse(resource, accepts, reason, resync);
      }

      const response = await next(request);
      // Handler gagal atau menolak: tidak ada kewajiban (flow `authorization`), respons diteruskan apa adanya.
      if (response.status >= 400) return response;

      const settled = await post("/settle", body);
      if (settled?.success === true || settled?.errorReason === "settlement_pending") {
        const headers = new Headers(response.headers);
        headers.set(HEADER_PAYMENT_RESPONSE, toBase64(settled));
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
      return paymentRequiredResponse(resource, accepts, String(settled?.errorReason ?? "settle_failed"), settled);
    } catch (error) {
      if (error instanceof FacilitatorUnavailable) return unavailable(error.message);
      throw error;
    }
  };
}
