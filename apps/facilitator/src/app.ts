// Rute facilitator referensi (Spec Binding x402 bagian 8): /verify, /settle, /supported.
import { Hono } from "hono";
import type {
  SettleRequest,
  SettleResponse,
  SupportedResponse,
  VerifyRequest,
  VerifyResponse,
} from "@x402/core/types";
import { assertCircleId } from "@x207/scheme";
import { ChainUnavailableError } from "./rpc.js";

export type PairStateQuery = { network: string; payer: string; payee: string; epoch: number };

/** Respons `GET /x207/pair-state` (Spec Binding x402 8.5, K-29). */
export type PairStateResponse = PairStateQuery & {
  lastSeq: number;
  lastCumulativeAmount: string;
  source: "pending" | "onchain" | "none";
};

/** Logika bisnis di belakang rute; diisi SD-024 (`verify`), SD-026 (`settle`), SD-032 (`supported`, `pairState`). */
export type FacilitatorService = {
  verify(request: VerifyRequest): Promise<VerifyResponse>;
  settle(request: SettleRequest): Promise<SettleResponse>;
  supported(): Promise<SupportedResponse>;
  pairState?(query: PairStateQuery): Promise<PairStateResponse>;
};

export const RETRY_AFTER_SECONDS = 5;

export class InvalidRequestError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Body `/verify` dan `/settle`; network x207 wajib lolos regex CAIP-2. */
function parsePaymentRequest(body: unknown): VerifyRequest {
  if (!isRecord(body)) throw new InvalidRequestError("body harus objek JSON");
  if (typeof body.x402Version !== "number") throw new InvalidRequestError("x402Version wajib");
  if (!isRecord(body.paymentPayload)) throw new InvalidRequestError("paymentPayload wajib");
  const requirements = body.paymentRequirements;
  if (!isRecord(requirements)) throw new InvalidRequestError("paymentRequirements wajib");
  const { network } = requirements;
  if (typeof network !== "string") throw new InvalidRequestError("paymentRequirements.network wajib");
  if (network.startsWith("x207:")) {
    try {
      assertCircleId(network);
    } catch (error) {
      throw new InvalidRequestError((error as Error).message);
    }
  }
  return body as unknown as VerifyRequest;
}

/** Query `GET /x207/pair-state`; semua parameter wajib dan network lolos regex CAIP-2. */
function parsePairStateQuery(query: Record<string, string | undefined>): PairStateQuery {
  const { network, payer, payee, epoch } = query;
  if (!network || !payer || !payee || !epoch) throw new InvalidRequestError("network, payer, payee, dan epoch wajib");
  try {
    assertCircleId(network);
  } catch (error) {
    throw new InvalidRequestError((error as Error).message);
  }
  if (!/^[1-9]\d*$/.test(epoch) || !Number.isSafeInteger(Number(epoch))) {
    throw new InvalidRequestError(`epoch harus integer >= 1, dapat "${epoch}"`);
  }
  return { network, payer, payee, epoch: Number(epoch) };
}

export function createApp(service: FacilitatorService): Hono {
  const app = new Hono();

  const handlePayment = (run: (request: VerifyRequest) => Promise<unknown>) => async (c: import("hono").Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new InvalidRequestError("body bukan JSON");
    }
    return c.json(await run(parsePaymentRequest(body)) as object, 200);
  };

  app.post("/verify", handlePayment((request) => service.verify(request)));
  app.post("/settle", handlePayment((request) => service.settle(request)));
  app.get("/supported", async (c) => c.json(await service.supported(), 200));
  app.get("/x207/pair-state", async (c) => {
    if (!service.pairState) return c.json({ error: "not_found" }, 404);
    return c.json(await service.pairState(parsePairStateQuery(c.req.query())), 200);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((error, c) => {
    if (error instanceof InvalidRequestError) {
      return c.json({ error: "invalid_request", message: error.message }, 400);
    }
    if (error instanceof ChainUnavailableError) {
      c.header("Retry-After", String(RETRY_AFTER_SECONDS));
      return c.json({ error: "chain_unavailable", message: error.message }, 503);
    }
    console.error(error);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
