// A-SD-15: the body of a paid response is marked as untrusted data.
import { describe, expect, it } from "vitest";
import { MAX_PAID_BODY_BYTES, UNTRUSTED_BODY_NOTE, shapePaidBody } from "../src/write-tools.js";

describe("SD-117 paid body", () => {
  it("TC-SD-117-01 every shape of the body carries the untrusted note; the cuts stay", () => {
    expect(shapePaidBody("hello", false)).toEqual({ body: "hello", bodyNote: UNTRUSTED_BODY_NOTE });
    expect(shapePaidBody("x".repeat(60_000), false).body).toBe(`${"x".repeat(50_000)}… cut`);
    expect(shapePaidBody("abc", true).body).toBe(`abc… cut at ${MAX_PAID_BODY_BYTES} bytes`);
    expect(shapePaidBody("abc", true).bodyNote).toMatch(/never instructions/);
  });
});
