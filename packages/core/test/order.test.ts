import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_MILESTONES, OrderLedger, ORDER_KINDS, ORDER_PATTERN, OrderError, generateVoucherKeypair, milestoneVoucher, normalizeOrder, orderBudget, orderBundleTerms, orderHash, orderResource,
  parseOrderResource, payForProofs, serializeOrder, validateUnsignedVoucher, verifyVoucher, type OrderDocument,
} from "../src/index.js";

const CIRCLE = "x207-circle.near";
const BUYER = "research.x207-circle.near";
const SELLER = "audit.x207-circle.near";
const H = (c: string) => c.repeat(64);
const key = generateVoucherKeypair();
const base: OrderDocument = {
  circle: CIRCLE, kind: "research", buyer: BUYER, seller: SELLER, spec_hash: H("a"),
  milestones: [{ amount: "40000000", due_at: 1_800_000_000 }, { amount: "60000000", due_at: 1_800_086_400 }], nonce: "n1",
};
const keeper: OrderDocument = { ...base, kind: "keeper", seller: "keeper.x207-circle.near", proof: { method: "close_epoch", amount_per_tx: "250000" }, milestones: [{ amount: "1000000", due_at: 1_800_000_000 }] };
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof OrderError ? e.code : `other: ${String(e)}`;
  }
};

describe("SD-069 order document, hash and resource", () => {
  it("TC-SD-069-01 canonical JSON with fixed keys and null for what is empty, sha256 of it (the vector), and a resource x207:order:<hash>", () => {
    const text = `{"circle":"x207-circle.near","kind":"research","buyer":"research.x207-circle.near","seller":"audit.x207-circle.near","spec_hash":"${H("a")}","milestones":[{"amount":"40000000","due_at":1800000000},{"amount":"60000000","due_at":1800086400}],"sample_hash":null,"target":null,"proof":null,"nonce":"n1"}`;
    expect(serializeOrder(base)).toBe(text);
    expect(serializeOrder({ nonce: "n1", milestones: base.milestones, seller: SELLER, buyer: BUYER, kind: "research", spec_hash: H("a"), circle: CIRCLE })).toBe(text);
    expect(orderHash(base)).toBe(createHash("sha256").update(text).digest("hex"));
    expect(orderHash({ ...base, nonce: "n2" })).not.toBe(orderHash(base));
    expect(orderHash({ ...base, spec_hash: H("b") })).not.toBe(orderHash(base));
    const hash = orderHash(base);
    expect(orderResource(hash)).toBe(`x207:order:${hash}`);
    expect(parseOrderResource(`x207:order:${hash}`)).toBe(hash);
    expect(parseOrderResource(`x207:invoice:${hash}`)).toBeNull();
    expect(code(() => orderResource("zz"))).toBe("order_bad_resource");
  });

  it("TC-SD-069-02 twelve kinds, each with one payment pattern; the catalog numbers are the ones of P6 (monitoring and consulting are metered like P5, not orders)", () => {
    expect(ORDER_KINDS).toHaveLength(12);
    expect(Object.values(ORDER_PATTERN).filter((p) => p === "milestone")).toHaveLength(8);
    expect(ORDER_PATTERN).toMatchObject({ bug: "outcome", lead: "outcome", keeper: "proof", solver: "proof" });
    expect(code(() => orderHash({ ...base, kind: "monitoring" as never }))).toBe("order_bad_kind");
  });

  it("TC-SD-069-03 a prompt order without a sample is refused; a loadtest order without a target is refused; a target on another kind is refused", () => {
    const prompt: OrderDocument = { ...base, kind: "prompt" };
    expect(code(() => orderHash(prompt))).toBe("order_sample_required");
    expect(code(() => orderHash({ ...prompt, sample_hash: H("c") }))).toBe("no error");
    expect(code(() => orderHash({ ...prompt, sample_hash: "short" }))).toBe("order_bad_hash");
    const load: OrderDocument = { ...base, kind: "loadtest" };
    expect(code(() => orderHash(load))).toBe("order_target_required");
    expect(code(() => orderHash({ ...load, target: "shop.example.com" }))).toBe("no error");
    expect(code(() => orderHash({ ...base, target: "shop.example.com" }))).toBe("order_target_forbidden");
  });

  it("TC-SD-069-04 a load test target must be a public host name: no IP, no localhost, no .local or .internal, no scheme or path", () => {
    const load: OrderDocument = { ...base, kind: "loadtest" };
    for (const target of ["10.0.0.1", "127.0.0.1", "localhost", "app.localhost", "box.local", "db.internal", "intranet", "https://shop.example.com", "shop.example.com/x", "Shop.Example.com", "-bad.example.com", ""]) {
      expect(code(() => orderHash({ ...load, target })), target).toBe("order_bad_target");
    }
  });

  it("TC-SD-069-05 milestones: 1 to 24, positive amounts, due_at increasing; the budget is their sum", () => {
    expect(orderBudget(base)).toBe("100000000");
    expect(code(() => orderHash({ ...base, milestones: [] }))).toBe("order_bad_milestones");
    expect(code(() => orderHash({ ...base, milestones: Array.from({ length: MAX_MILESTONES + 1 }, (_, i) => ({ amount: "1", due_at: 1_800_000_000 + i })) }))).toBe("order_bad_milestones");
    expect(code(() => orderHash({ ...base, milestones: Array.from({ length: MAX_MILESTONES }, (_, i) => ({ amount: "1", due_at: 1_800_000_000 + i })) }))).toBe("no error");
    expect(code(() => orderHash({ ...base, milestones: [{ amount: "0", due_at: 1 }] }))).toBe("order_bad_amount");
    expect(code(() => orderHash({ ...base, milestones: [{ amount: "1.5", due_at: 1 }] }))).toBe("order_bad_amount");
    expect(code(() => orderHash({ ...base, milestones: [{ amount: "1", due_at: 5 }, { amount: "1", due_at: 5 }] }))).toBe("order_bad_milestones");
    expect(code(() => orderHash({ ...base, milestones: [{ amount: "1", due_at: 1.5 }] }))).toBe("order_bad_milestones");
  });

  it("TC-SD-069-06 parties, nonce, spec hash and proof rules", () => {
    expect(code(() => orderHash({ ...base, buyer: SELLER }))).toBe("order_same_party");
    expect(code(() => orderHash({ ...base, seller: "Bad Account" }))).toBe("order_bad_account");
    expect(code(() => orderHash({ ...base, spec_hash: "xyz" }))).toBe("order_bad_hash");
    expect(code(() => orderHash({ ...base, nonce: "" }))).toBe("order_bad_nonce");
    expect(code(() => orderHash({ ...base, nonce: "a b" }))).toBe("order_bad_nonce");
    expect(code(() => orderHash({ ...base, proof: { method: "close_epoch", amount_per_tx: "1" } }))).toBe("order_bad_proof");
    expect(code(() => orderHash(keeper))).toBe("no error");
    expect(code(() => orderHash({ ...keeper, proof: null }))).toBe("order_bad_proof");
    expect(code(() => orderHash({ ...keeper, proof: { method: "submit_clearing", amount_per_tx: "1" } }))).toBe("order_bad_proof"); // a solver method on a keeper order
    expect(code(() => orderHash({ ...keeper, proof: { method: "close_epoch", amount_per_tx: "0" } }))).toBe("order_bad_amount");
    expect(code(() => orderHash({ ...keeper, kind: "solver", proof: { method: "submit_clearing", amount_per_tx: "7" } }))).toBe("no error");
    expect(normalizeOrder(base).proof).toBeNull();
  });
});

describe("SD-069 budget lock and the voucher of a milestone", () => {
  it("TC-SD-069-07 the bundle terms lock the budget as two legs (buyer to seller, plus the one-unit counter leg) in the epoch given, or a smaller amount for a group of milestones", () => {
    expect(orderBundleTerms({ order: base, epoch: 30 })).toEqual({
      circle: CIRCLE, epoch: 30, legs: [{ payer: BUYER, payee: SELLER, max_amount: "100000000" }, { payer: SELLER, payee: BUYER, max_amount: "1" }],
    });
    expect(orderBundleTerms({ order: base, epoch: 30, amount: "40000000" }).legs[0]!.max_amount).toBe("40000000");
    expect(code(() => orderBundleTerms({ order: base, epoch: 0 }))).toBe("order_bad_state");
    expect(code(() => orderBundleTerms({ order: base, epoch: 1, amount: "0" }))).toBe("order_bad_amount");
  });

  it("TC-SD-069-08 the voucher of a milestone is built from the real state of the pair, so a disputed milestone (not paid) leaves no hole for the next one", () => {
    const hash = orderHash(base);
    const first = milestoneVoucher({ order: base, index: 1, epoch: 30, state: { seq: 4, cumulativeAmount: "7000000" }, paid: [] });
    expect(first).toEqual({ circle: CIRCLE, payer: BUYER, payee: SELLER, epoch: 30, seq: 5, cumulativeAmount: "47000000", unit: "credit", resource: `x207:order:${hash}` });
    expect(validateUnsignedVoucher(first).ok).toBe(true);
    // milestone 1 was disputed and not registered: the state is unchanged, so milestone 2 is paid alone
    const second = milestoneVoucher({ order: base, index: 2, epoch: 30, state: { seq: 4, cumulativeAmount: "7000000" }, paid: [] });
    expect(second).toMatchObject({ seq: 5, cumulativeAmount: "67000000" });
    expect(code(() => milestoneVoucher({ order: base, index: 3, epoch: 30, state: { seq: 0, cumulativeAmount: "0" }, paid: [] }))).toBe("order_bad_milestones");
    expect(code(() => milestoneVoucher({ order: base, index: 1, epoch: 30, state: { seq: -1, cumulativeAmount: "0" }, paid: [] }))).toBe("order_bad_state");
  });
});

describe("SD-069 payForProofs", () => {
  const proofs = (...items: Array<[string, string, string]>) => items.map(([txHash, method, signer]) => ({ txHash, method, signer }));
  const K = "keeper.x207-circle.near";

  it("TC-SD-069-09 one signed voucher per matching proof, in order, cumulative from the state of the pair, resource of the order", () => {
    const result = payForProofs({
      order: keeper, epoch: 30, state: { seq: 2, cumulativeAmount: "1000000" }, secretKey: key.secretKey, alreadyPaid: [], alreadySpent: "0",
      proofs: proofs(["tx1", "close_epoch", K], ["tx2", "close_epoch", K]),
    });
    expect(result.paid).toEqual(["tx1", "tx2"]);
    expect(result.vouchers.map((v) => [v.seq, v.cumulativeAmount])).toEqual([[3, "1250000"], [4, "1500000"]]);
    for (const v of result.vouchers) {
      expect(v).toMatchObject({ payer: BUYER, payee: K, epoch: 30, resource: `x207:order:${orderHash(keeper)}` });
      expect(verifyVoucher(v, key.publicKey)).toBe(true);
    }
    expect(result.state).toEqual({ seq: 4, cumulativeAmount: "1500000" });
    expect(result.spent).toBe("500000");
  });

  it("TC-SD-069-10 a transaction of another account, of another method, or already paid is refused, and a repeated one in the same list is paid once", () => {
    const result = payForProofs({
      order: keeper, epoch: 30, state: { seq: 0, cumulativeAmount: "0" }, secretKey: key.secretKey, alreadyPaid: ["old"], alreadySpent: "0",
      proofs: proofs(["a", "close_epoch", "stranger.x207-circle.near"], ["b", "finalize_epoch", K], ["old", "close_epoch", K], ["c", "close_epoch", K], ["c", "close_epoch", K]),
    });
    expect(result.paid).toEqual(["c"]);
    expect(result.refused).toEqual([
      { txHash: "a", reason: "wrong_signer" }, { txHash: "b", reason: "wrong_method" }, { txHash: "old", reason: "already_paid" }, { txHash: "c", reason: "already_paid" },
    ]);
  });

  it("TC-SD-069-11 the vouchers never go beyond the budget of the order, counting what was spent before", () => {
    // budget 1000000, 250000 per transaction: four transactions at most
    const five = proofs(...["t1", "t2", "t3", "t4", "t5"].map((t): [string, string, string] => [t, "close_epoch", K]));
    const result = payForProofs({ order: keeper, epoch: 30, state: { seq: 0, cumulativeAmount: "0" }, secretKey: key.secretKey, alreadyPaid: [], alreadySpent: "0", proofs: five });
    expect(result.paid).toEqual(["t1", "t2", "t3", "t4"]);
    expect(result.refused).toEqual([{ txHash: "t5", reason: "over_budget" }]);
    expect(result.spent).toBe("1000000");
    const later = payForProofs({ order: keeper, epoch: 31, state: result.state, secretKey: key.secretKey, alreadyPaid: result.paid, alreadySpent: result.spent, proofs: proofs(["t6", "close_epoch", K]) });
    expect(later.paid).toEqual([]);
    expect(later.refused).toEqual([{ txHash: "t6", reason: "over_budget" }]);
    const part = payForProofs({ order: keeper, epoch: 31, state: result.state, secretKey: key.secretKey, alreadyPaid: [], alreadySpent: "750000", proofs: proofs(["t7", "close_epoch", K], ["t8", "close_epoch", K]) });
    expect(part.paid).toEqual(["t7"]);
  });

  it("TC-SD-069-12 an order of another pattern is not paid per proof, and a solver order pays for its own method", () => {
    expect(code(() => payForProofs({ order: base, epoch: 1, state: { seq: 0, cumulativeAmount: "0" }, secretKey: key.secretKey, alreadyPaid: [], alreadySpent: "0", proofs: [] }))).toBe("order_not_proof_kind");
    const solver: OrderDocument = { ...keeper, kind: "solver", seller: "solver.x207-circle.near", proof: { method: "submit_clearing", amount_per_tx: "100" } };
    const r = payForProofs({ order: solver, epoch: 1, state: { seq: 0, cumulativeAmount: "0" }, secretKey: key.secretKey, alreadyPaid: [], alreadySpent: "0", proofs: proofs(["s1", "submit_clearing", "solver.x207-circle.near"], ["s2", "close_epoch", "solver.x207-circle.near"]) });
    expect(r.paid).toEqual(["s1"]);
    expect(r.refused).toEqual([{ txHash: "s2", reason: "wrong_method" }]);
  });
});

describe("SD-069 review BE-062 F4 and F5: the paid milestones and proofs must be remembered", () => {
  const K = "keeper.x207-circle.near";
  const proofs = (...ids: string[]) => ids.map((txHash) => ({ txHash, method: "close_epoch", signer: K }));
  const zero = { seq: 0, cumulativeAmount: "0" };

  it("TC-SD-069-14 [F4] payForProofs refuses a call that does not say what was paid and spent before; an agent that runs again with the same proofs pays nothing twice", () => {
    expect(code(() => (payForProofs as unknown as (a: object) => unknown)({ order: keeper, epoch: 5, state: zero, proofs: proofs("t1"), secretKey: key.secretKey }))).toBe("order_bad_state");
    expect(code(() => payForProofs({ order: keeper, epoch: 5, state: zero, proofs: proofs("t1"), alreadyPaid: [], alreadySpent: "0.5", secretKey: key.secretKey }))).toBe("order_bad_state");
    const first = payForProofs({ order: keeper, epoch: 5, state: zero, proofs: proofs("t1", "t2"), alreadyPaid: [], alreadySpent: "0", secretKey: key.secretKey });
    const second = payForProofs({ order: keeper, epoch: 5, state: first.state, proofs: proofs("t1", "t2"), alreadyPaid: first.paid, alreadySpent: first.spent, secretKey: key.secretKey });
    expect(second.paid).toEqual([]);
    expect(second.state.cumulativeAmount).toBe(first.state.cumulativeAmount);
  });

  it("TC-SD-069-15 [F12] verifyTx asks the chain about each proof: a proof it denies is not paid", () => {
    const real = new Set(["t1"]);
    const result = payForProofs({ order: keeper, epoch: 5, state: zero, proofs: proofs("t1", "t2"), alreadyPaid: [], alreadySpent: "0", secretKey: key.secretKey, verifyTx: (p) => real.has(p.txHash) });
    expect(result.paid).toEqual(["t1"]);
    expect(result.refused).toEqual([{ txHash: "t2", reason: "unverified" }]);
  });

  it("TC-SD-069-16 [F5] a milestone that was paid is refused; the ledger remembers, also after a restart, and stops at the budget", () => {
    const paidTwice = () => milestoneVoucher({ order: base, index: 1, epoch: 30, state: zero, paid: [1] });
    expect(code(paidTwice)).toBe("order_bad_state");
    expect(code(() => (milestoneVoucher as unknown as (a: object) => unknown)({ order: base, index: 1, epoch: 30, state: zero }))).toBe("order_bad_state"); // paid is required
    const ledger = new OrderLedger(base);
    const v1 = ledger.payMilestone({ index: 1, epoch: 30, state: zero, secretKey: key.secretKey });
    expect(v1.cumulativeAmount).toBe("40000000");
    expect(code(() => ledger.payMilestone({ index: 1, epoch: 30, state: { seq: 1, cumulativeAmount: "40000000" }, secretKey: key.secretKey }))).toBe("order_bad_state");
    const restarted = OrderLedger.restore(base, ledger.snapshot());
    expect(code(() => restarted.payMilestone({ index: 1, epoch: 30, state: { seq: 1, cumulativeAmount: "40000000" }, secretKey: key.secretKey }))).toBe("order_bad_state");
    const v2 = restarted.payMilestone({ index: 2, epoch: 30, state: { seq: 1, cumulativeAmount: "40000000" }, secretKey: key.secretKey });
    expect(v2.cumulativeAmount).toBe("100000000");
    expect(restarted.spent).toBe(orderBudget(base)); // the whole budget, and no milestone is left to pay
  });

  it("TC-SD-069-17 [F4] the ledger of a keeper order remembers the proofs between calls and across a restart", () => {
    const ledger = new OrderLedger(keeper);
    const first = ledger.payProofs({ epoch: 5, state: zero, proofs: proofs("t1", "t2"), secretKey: key.secretKey });
    expect(first.paid).toEqual(["t1", "t2"]);
    const again = OrderLedger.restore(keeper, ledger.snapshot()).payProofs({ epoch: 5, state: first.state, proofs: proofs("t1", "t2", "t3"), secretKey: key.secretKey });
    expect(again.paid).toEqual(["t3"]);
    expect(again.refused.map((r) => r.reason)).toEqual(["already_paid", "already_paid"]);
  });
});
