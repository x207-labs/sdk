import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DELEGATE_VOTE_ACTIONS, MAX_MILESTONES, OrderLedger, mandateHash, normalizeMandate, orderClaimNotice, serializeMandate, signOrderClaim, type DelegateMandate, ORDER_KINDS, ORDER_PATTERN, OrderError, generateVoucherKeypair, milestoneVoucher, normalizeOrder, orderBudget, orderBundleTerms, orderHash, orderResource,
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

  it("TC-SD-069-02 thirteen kinds (SD-072 added delegate), each with one payment pattern; the catalog numbers are the ones of P6 (monitoring and consulting are metered like P5, not orders)", () => {
    expect(ORDER_KINDS).toHaveLength(13);
    expect(Object.values(ORDER_PATTERN).filter((p) => p === "milestone")).toHaveLength(8);
    expect(ORDER_PATTERN).toMatchObject({ bug: "outcome", lead: "outcome", keeper: "proof", solver: "proof", delegate: "proof" });
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

  // ---- SD-072 delegate order ----
  const DAO = "gauge.dao.near";
  const mandate: DelegateMandate = { circle: CIRCLE, dao: DAO, kinds: ["transfer", "function_call"], rules_hash: H("c") };
  const delegate: OrderDocument = { ...base, kind: "delegate", seller: "delegate.x207-circle.near", proof: { method: "act_proposal", amount_per_tx: "500000" }, mandate_hash: mandateHash(mandate), milestones: [{ amount: "2000000", due_at: 1_800_000_000 }] };
  const vote = (id: number, over: Partial<{ txHash: string; method: string; signer: string; receiver: string; action: string; proposal_kind: string }> = {}) => ({
    txHash: `tx${id}`.padEnd(8, "x"), method: "act_proposal", signer: delegate.seller, receiver: DAO, proposal_id: id, action: "VoteApprove", proposal_kind: "transfer", ...over,
  });

  it("TC-SD-072-01 the mandate has fixed keys and sorted kinds, its hash is sha256 of the JSON, and a bad mandate is order_bad_mandate", () => {
    const text = serializeMandate({ ...mandate, kinds: ["transfer", "function_call"] });
    expect(text).toBe(`{"circle":"${CIRCLE}","dao":"${DAO}","kinds":["function_call","transfer"],"rules_hash":"${H("c")}"}`);
    expect(mandateHash(mandate)).toBe(createHash("sha256").update(text).digest("hex"));
    expect(mandateHash({ ...mandate, kinds: ["function_call", "transfer"] })).toBe(mandateHash(mandate)); // the order of kinds does not matter
    expect(mandateHash({ ...mandate, rules_hash: H("d") })).not.toBe(mandateHash(mandate));
    for (const bad of [{ kinds: [] }, { kinds: ["Transfer"] }, { kinds: ["transfer", "transfer"] }, { rules_hash: "xyz" }, { dao: "NOT AN ACCOUNT" }, { kinds: Array.from({ length: 17 }, (_, i) => `kind_${i}`) }]) {
      expect(code(() => normalizeMandate({ ...mandate, ...bad })), JSON.stringify(bad)).toBe("order_bad_mandate");
    }
  });

  it("TC-SD-072-02 a delegate order needs mandate_hash, other kinds must not have one, and only a delegate order carries it in the JSON (the hash of every other order is unchanged)", () => {
    expect(code(() => orderHash({ ...delegate, mandate_hash: null }))).toBe("order_mandate_required");
    expect(code(() => orderHash({ ...delegate, mandate_hash: "zz" }))).toBe("order_bad_mandate");
    expect(code(() => orderHash({ ...base, mandate_hash: H("c") }))).toBe("order_mandate_forbidden");
    expect(code(() => orderHash({ ...keeper, mandate_hash: H("c") }))).toBe("order_mandate_forbidden");
    expect(code(() => orderHash({ ...delegate, proof: null }))).toBe("order_bad_proof");
    expect(code(() => orderHash({ ...delegate, proof: { method: "vote", amount_per_tx: "500000" } }))).toBe("order_bad_proof"); // not in the default list
    expect(orderHash({ ...delegate, proof: { method: "vote", amount_per_tx: "500000" } }, { delegateMethods: ["act_proposal", "vote"] })).toMatch(/^[0-9a-f]{64}$/); // a DAO names its own method
    const json = serializeOrder(delegate);
    expect(json.indexOf('"proof"')).toBeLessThan(json.indexOf('"mandate_hash"'));
    expect(json.indexOf('"mandate_hash"')).toBeLessThan(json.indexOf('"nonce"'));
    expect(serializeOrder(base)).not.toContain("mandate_hash");
    expect(serializeOrder({ ...base, mandate_hash: null })).toBe(serializeOrder(base));
    expect(serializeOrder(keeper)).not.toContain("mandate_hash");
  });

  it("TC-SD-072-03 a delegate is paid once per proposal for a vote that is on the mandate: other actions, other contracts, other kinds, a second vote on the same proposal, and a stranger are not paid", () => {
    const common = { order: delegate, epoch: 42, state: { seq: 0, cumulativeAmount: "0" }, alreadyPaid: [], alreadySpent: "0", mandate, secretKey: key.secretKey };
    const result = payForProofs({
      ...common,
      proofs: [
        vote(1), // paid
        vote(1, { txHash: "tx1again" }), // the same proposal again
        vote(2, { action: "Finalize" }), // act_proposal is not only a vote
        vote(3, { action: "VoteRemove" }),
        vote(4, { receiver: "other.dao.near" }), // another contract
        vote(5, { proposal_kind: "upgrade_self" }), // not in the mandate
        vote(6, { signer: "stranger.x207-circle.near" }),
        vote(7, { method: "vote" }),
        vote(8, { action: "VoteReject", proposal_kind: "function_call" }), // paid
      ],
    });
    expect(result.paid).toEqual([vote(1).txHash, vote(8).txHash]);
    expect(result.keys).toEqual(["proposal:1", "proposal:8"]);
    expect(Object.fromEntries(result.refused.map((r) => [r.txHash, r.reason]))).toEqual({
      tx1again: "already_paid", [vote(2).txHash]: "not_a_vote", [vote(3).txHash]: "not_a_vote", [vote(4).txHash]: "wrong_receiver", [vote(5).txHash]: "kind_not_in_mandate",
      [vote(6).txHash]: "wrong_signer", [vote(7).txHash]: "wrong_method",
    });
    expect(result.vouchers.map((v) => [v.seq, v.cumulativeAmount, v.resource])).toEqual([[1, "500000", `x207:order:${orderHash(delegate)}`], [2, "1000000", `x207:order:${orderHash(delegate)}`]]);
    expect(DELEGATE_VOTE_ACTIONS).toEqual(["VoteApprove", "VoteReject"]);
    // missing fields of the proof are refused, not paid
    const bare = payForProofs({ ...common, proofs: [{ txHash: "bare0000", method: "act_proposal", signer: delegate.seller }] });
    expect(bare.refused).toEqual([{ txHash: "bare0000", reason: "wrong_receiver" }]);
    // the budget of the order (2 credit = 4 votes) stops the rest
    const many = payForProofs({ ...common, proofs: [1, 2, 3, 4, 5, 6].map((i) => vote(i)) });
    expect(many.paid).toHaveLength(4);
    expect(many.refused.map((r) => r.reason)).toEqual(["over_budget", "over_budget"]);
  });

  it("TC-SD-072-04 the mandate is required and must be the one in the order; the ledger remembers proposals across a restart, so a vote is not paid twice", () => {
    const base2 = { order: delegate, epoch: 42, state: { seq: 0, cumulativeAmount: "0" }, proofs: [vote(1)], alreadyPaid: [], alreadySpent: "0", secretKey: key.secretKey };
    expect(code(() => payForProofs(base2))).toBe("order_mandate_required");
    expect(code(() => payForProofs({ ...base2, mandate: { ...mandate, kinds: ["transfer"] } }))).toBe("order_bad_mandate");
    expect(code(() => payForProofs({ ...base2, mandate: { ...mandate, circle: "other.near" } }))).toBe("order_bad_mandate");
    const ledger = new OrderLedger(delegate);
    expect(ledger.payProofs({ epoch: 42, state: { seq: 0, cumulativeAmount: "0" }, proofs: [vote(1)], mandate, secretKey: key.secretKey }).paid).toHaveLength(1);
    const restored = OrderLedger.restore(delegate, ledger.snapshot());
    const again = restored.payProofs({ epoch: 42, state: { seq: 1, cumulativeAmount: "500000" }, proofs: [vote(1, { txHash: "second00" })], mandate, secretKey: key.secretKey });
    expect(again.paid).toEqual([]);
    expect(again.refused).toEqual([{ txHash: "second00", reason: "already_paid" }]);
    expect(restored.spent).toBe("500000");
    // the milestone voucher and the budget work for a delegate order with the method of the DAO too
    const custom: OrderDocument = { ...delegate, proof: { method: "vote", amount_per_tx: "500000" } };
    expect(orderBudget(custom)).toBe("2000000");
    expect(new OrderLedger(custom).payMilestone({ index: 1, epoch: 42, state: { seq: 0, cumulativeAmount: "0" }, secretKey: key.secretKey }).resource).toBe(`x207:order:${orderHash(custom, { delegateMethods: ["vote"] })}`);
  });

  it("TC-SD-072-05 the claim notice of a delegate has the keys circle, order_hash, actor, action, at, tx_hash in that order, is signed with NEP-413 like the other notices, and bad fields are refused", () => {
    const hash = orderHash(delegate);
    const txHash = "8AXdP1c3JTqDyhsVSpfwLnPL1n9FnVZqkbtRMbLAA9ct";
    const notice = orderClaimNotice({ circle: CIRCLE, orderHash: hash, actor: delegate.seller, at: 1_800_000_100, txHash });
    expect(JSON.stringify(notice)).toBe(`{"circle":"${CIRCLE}","order_hash":"${hash}","actor":"${delegate.seller}","action":"claim","at":1800000100,"tx_hash":"${txHash}"}`);
    const signature = signOrderClaim(notice, key.secretKey);
    expect(signature).toMatch(/^ed25519:/);
    expect(signOrderClaim(notice, key.secretKey)).toBe(signature); // deterministic
    expect(signOrderClaim({ ...notice, tx_hash: "9AXdP1c3JTqDyhsVSpfwLnPL1n9FnVZqkbtRMbLAA9ct" }, key.secretKey)).not.toBe(signature);
    expect(code(() => orderClaimNotice({ circle: CIRCLE, orderHash: "zz", actor: delegate.seller, at: 1, txHash }))).toBe("order_bad_hash");
    expect(code(() => orderClaimNotice({ circle: CIRCLE, orderHash: hash, actor: delegate.seller, at: 1, txHash: "not a hash!" }))).toBe("order_bad_hash");
    expect(code(() => orderClaimNotice({ circle: CIRCLE, orderHash: hash, actor: "BAD ACCOUNT", at: 1, txHash }))).toBe("order_bad_account");
    expect(code(() => orderClaimNotice({ circle: CIRCLE, orderHash: hash, actor: delegate.seller, at: 0, txHash }))).toBe("order_bad_state");
  });
});
