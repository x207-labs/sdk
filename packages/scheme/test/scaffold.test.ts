import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  X207SchemeClient,
  X207SchemeFacilitator,
  X207SchemeServer,
  X207_NETWORK_FAMILY,
  X207_SCHEME,
  assertCircleId,
  defineCircleConfig,
} from "@x207/scheme";

const NETWORK = "x207:agents-main";
const CIRCLE_CONTRACT = "x207-circle.near";

const REQUIREMENTS = {
  scheme: X207_SCHEME,
  network: NETWORK,
  amount: "20000",
  asset: "USD",
  payTo: "summarizer.x207-circle.near",
  maxTimeoutSeconds: 60,
  extra: { circleContract: CIRCLE_CONTRACT, unit: "credit", decimals: 6, epoch: 42 },
} satisfies PaymentRequirements;

const PAYLOAD: PaymentPayload = {
  x402Version: 2,
  resource: { url: "https://seller.example/api" },
  accepted: REQUIREMENTS,
  payload: { marker: "from-test-impl" },
};

describe("SD-015 assertCircleId", () => {
  it("TC-SD-015-01 network sah", () => {
    expect(() => assertCircleId("x207:agents-main")).not.toThrow();
  });

  it("TC-SD-015-02 network dengan titik", () => {
    expect(() => assertCircleId("x207:x207-circle.near")).toThrow();
  });

  it("TC-SD-015-03 batas panjang reference", () => {
    expect(() => assertCircleId(`x207:${"a".repeat(32)}`)).not.toThrow();
    expect(() => assertCircleId(`x207:${"a".repeat(33)}`)).toThrow();
    expect(() => assertCircleId("x207:")).toThrow();
  });

  it("TC-SD-015-04 namespace huruf besar", () => {
    expect(() => assertCircleId("X207:agents-main")).toThrow();
  });

  it("menolak namespace selain x207 dan wildcard", () => {
    expect(() => assertCircleId("near:mainnet")).toThrow();
    expect(() => assertCircleId("x207:*")).toThrow();
  });
});

describe("SD-015 register x402 2.28.0", () => {
  it("TC-SD-015-05 register tiga peran", async () => {
    class ClientImpl extends X207SchemeClient {
      override async createPaymentPayload() {
        return { x402Version: 2, payload: { marker: "client-impl" } };
      }
    }
    const server = new X207SchemeServer();
    class FacilitatorImpl extends X207SchemeFacilitator {
      override async verify() {
        return { isValid: true, payer: "translator.x207-circle.near" };
      }
    }

    const client = new x402Client().register(X207_NETWORK_FAMILY, new ClientImpl());
    const created = await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: "https://seller.example/api" },
      accepts: [REQUIREMENTS],
    });
    expect(created.payload).toEqual({ marker: "client-impl" });

    const resourceServer = new x402ResourceServer().register(X207_NETWORK_FAMILY, server);
    expect(resourceServer.getRegisteredScheme(NETWORK, X207_SCHEME)).toBe(server);

    const facilitator = new x402Facilitator().register(
      X207_NETWORK_FAMILY,
      new FacilitatorImpl({ network: NETWORK, circleContract: CIRCLE_CONTRACT }),
    );
    await expect(facilitator.verify(PAYLOAD, REQUIREMENTS)).resolves.toEqual({
      isValid: true,
      payer: "translator.x207-circle.near",
    });
  });

  it("TC-SD-015-06 validasi saat konfigurasi", () => {
    const bad = { network: "x207:x207-circle.near", circleContract: CIRCLE_CONTRACT };
    expect(() => defineCircleConfig(bad)).toThrow();
    expect(() => new X207SchemeFacilitator(bad)).toThrow();
    expect(defineCircleConfig({ network: NETWORK, circleContract: CIRCLE_CONTRACT })).toEqual({
      network: NETWORK,
      circleContract: CIRCLE_CONTRACT,
    });
  });

  it("TC-SD-015-07 versi dipin exact", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@x402/core"]).toBe("2.28.0");
  });

  it("TC-SD-015-08 kerangka tiga peran", () => {
    const facilitator = new X207SchemeFacilitator({
      network: NETWORK,
      circleContract: CIRCLE_CONTRACT,
      signers: ["relayer.x207-circle.near"],
    });
    expect(facilitator.scheme).toBe("batch-settlement");
    expect(facilitator.caipFamily).toBe("x207:*");
    expect(typeof facilitator.verify).toBe("function");
    expect(typeof facilitator.settle).toBe("function");
    expect(typeof facilitator.getExtra).toBe("function");
    expect(facilitator.getSigners(NETWORK)).toEqual(["relayer.x207-circle.near"]);

    expect(new X207SchemeClient().scheme).toBe("batch-settlement");
    expect(typeof new X207SchemeClient().createPaymentPayload).toBe("function");
    expect(new X207SchemeServer().scheme).toBe("batch-settlement");
    expect(typeof new X207SchemeServer().parsePrice).toBe("function");
  });
});
