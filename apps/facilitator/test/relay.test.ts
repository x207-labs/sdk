import { describe, expect, it } from "vitest";
import { contractErrorCode } from "@x207/core";
import { transactionFailure } from "../src/relay.js";

describe("SD-028 relay", () => {
  it("transactionFailure returns the contract panic message from a failed receipt", () => {
    const failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_PAST_CUTOFF: epoch 42" } } } };
    const message = transactionFailure({
      status: { SuccessValue: "" },
      transaction_outcome: { outcome: { status: { SuccessReceiptId: "x" } } },
      receipts_outcome: [{ outcome: { status: { Failure: failure } } }],
    });
    expect(message).not.toBeNull();
    expect(contractErrorCode(new Error(message!))).toBe("ERR_PAST_CUTOFF");
  });

  it("transactionFailure null when every outcome succeeds", () => {
    expect(
      transactionFailure({
        status: { SuccessValue: "IjEwMDAwMDAi" },
        transaction_outcome: { outcome: { status: { SuccessReceiptId: "x" } } },
        receipts_outcome: [{ outcome: { status: { SuccessValue: "IjEwMDAwMDAi" } } }],
      }),
    ).toBeNull();
  });
});
