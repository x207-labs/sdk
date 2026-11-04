import { decodePaymentRequiredHeader } from "@x402/core/http";
import { vi } from "vitest";
import { x207Middleware, type X207MiddlewareOptions } from "@x207/scheme";

export const A = "a.x207-circle.near";
export const B = "b.x207-circle.near";
export const NETWORK = "x207:agents-main";
export const URL_ = "https://summarizer.example/api/summarize";
export const EXTRA = { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42 };
export const REQ = { scheme: "batch-settlement", network: NETWORK, amount: "20000", asset: "USD", payTo: B, maxTimeoutSeconds: 60, extra: EXTRA };
export const REQ_EXACT = { scheme: "exact", network: "near:mainnet", amount: "20000", asset: "usdt.tether-token.near", payTo: B, maxTimeoutSeconds: 60, extra: {} };

export const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
export const payloadOf = (accepted: unknown = REQ, seq = 1) => ({
  x402Version: 2, resource: { url: URL_ }, accepted,
  payload: {
    voucher: { circle: "x207-circle.near", payer: A, payee: B, epoch: 42, seq, cumulativeAmount: String(seq * 20000), unit: "credit", resource: URL_ },
    signature: "ed25519:sig",
  },
});
export const SETTLED = {
  success: true, transaction: `${A}:${B}:42:1`, network: NETWORK, payer: A,
  extensions: { x207: { epoch: 42, seq: 1, cumulativeAmount: "20000", registration: "pending" } },
};

export type Mock = {
  verify?: (body: any) => unknown;
  settle?: (body: any) => unknown;
  pairState?: () => unknown;
  supportedFails?: boolean;
  hang?: string[];
  status?: Record<string, number>;
};

export function facilitator(mock: Mock = {}) {
  const calls: { path: string; body?: any }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (mock.hang?.includes(path)) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")));
      });
    }
    if (mock.status?.[path]) return new Response("{}", { status: mock.status[path] });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (path === "/supported") {
      if (mock.supportedFails) return new Response("{}", { status: 503 });
      return json({ kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK, extra: EXTRA }, { x402Version: 2, scheme: "exact", network: "near:mainnet" }], extensions: [], signers: {} });
    }
    if (path === "/verify") return json((mock.verify ?? (() => ({ isValid: true, payer: A })))(calls.at(-1)!.body));
    if (path === "/settle") return json((mock.settle ?? (() => SETTLED))(calls.at(-1)!.body));
    if (path === "/x207/pair-state") return json((mock.pairState ?? (() => ({ network: NETWORK, payer: A, payee: B, epoch: 42, lastSeq: 137, lastCumulativeAmount: "2740000", source: "pending" })))());
    return new Response("{}", { status: 404 });
  });
  return { fetchMock, calls };
}

export function setup(mock: Mock = {}, options: Partial<X207MiddlewareOptions> = {}) {
  const { fetchMock, calls } = facilitator(mock);
  const middleware = x207Middleware({
    routes: { "/api/summarize": { price: "$0.02", description: "Summarize text", mimeType: "application/json" } },
    facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B,
    fetch: fetchMock as unknown as typeof fetch, ...options,
  });
  const handler = vi.fn(async () => new Response(JSON.stringify({ summary: "ok" }), { status: 200, headers: { "content-type": "application/json" } }));
  const run = (headers: Record<string, string> = {}, path = "/api/summarize") =>
    middleware(new Request(`https://summarizer.example${path}`, { headers }), handler);
  return { run, handler, calls };
}
export const sign = (payload: unknown) => ({ "PAYMENT-SIGNATURE": b64(payload) });
export const required = (response: Response) => decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!) as any;
export const paymentResponse = (response: Response) => JSON.parse(Buffer.from(response.headers.get("PAYMENT-RESPONSE")!, "base64").toString("utf8"));

