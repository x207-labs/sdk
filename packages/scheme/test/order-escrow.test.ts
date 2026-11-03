import { describe, expect, it } from "vitest";
import { orderBundleTerms, orderBudget, type OrderDocument } from "@x207/core";
import { JobBudget } from "@x207/scheme";

describe("SD-069 the budget lock of an order is the one of SD-067", () => {
  it("TC-SD-069-13 for milestones of equal amounts the bundle terms of the order equal the terms of JobBudget, so one commit_bundle path serves both", () => {
    const order: OrderDocument = {
      circle: "x207-circle.near", kind: "audit", buyer: "buyer.x207-circle.near", seller: "seller.x207-circle.near", spec_hash: "a".repeat(64), nonce: "n1",
      milestones: [1, 2, 3, 4].map((i) => ({ amount: "1000000", due_at: 1_800_000_000 + i })),
    };
    const job = new JobBudget({ jobId: "j", unit: "job", chunkQuantity: "0.25", unitPrice: "$4", chunks: 4, circle: order.circle, buyer: order.buyer, seller: order.seller, epoch: 9 });
    expect(job.budget.toString()).toBe(orderBudget(order));
    expect(orderBundleTerms({ order, epoch: 9 })).toEqual(job.terms());
  });
});
