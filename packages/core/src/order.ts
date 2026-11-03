// Format pesanan jasa (SD-069, pipeline P6, ADR-45). Pesanan adalah kesepakatan pembeli dan penjual atas jasa kerja; yang ada di rantai hanya voucher biasa dengan
// `resource = "x207:order:<hash>"`. Kontrak tidak berubah. Tiga pola bayar:
//   - `milestone`: kiriman per tonggak `{amount, due_at}`, dibayar setelah pembeli mengonfirmasi atau otomatis setelah jendela sengketa (ADR-42, BE-047);
//   - `outcome`: bayar per hasil yang diterima pembeli (`lead`, `bug`); tiap tonggak adalah satu tempat hasil;
//   - `proof`: bayar per transaksi penyedia yang terlihat di rantai (`keeper`, `solver`), lewat `payForProofs`.
// Aturan pencegah salah pakai ada di dokumennya: contoh (`sample_hash`) wajib untuk `prompt` karena hasil yang mudah disalin tidak boleh bisa disengketakan setelah disalin, dan
// bukti kepemilikan `target` wajib untuk `loadtest` supaya x207 tidak menjadi pasar sewa DDoS (backend memeriksa target, BE-054). Anggaran dikunci sebagai bundle seperti SD-067
// (`orderBundleTerms`); bundle hanya hidup di satu epoch, jadi tonggak yang jatuh tempo di epoch berbeda memakai bundle berbeda (`epochForTime` di invoice.ts).
import { createHash } from "node:crypto";
import { CREDIT_UNIT } from "./constants.js";
import type { BundleTerms } from "./barter.js";
import type { AccountId, U128String, UnsignedVoucher, Voucher } from "./types.js";
import { signVoucher, type VoucherSecretKey } from "./voucher.js";
import type { InvoicePairState } from "./invoice.js";

export const ORDER_KINDS = ["prompt", "research", "translation", "annotation", "scraping", "audit", "loadtest", "freelance", "bug", "lead", "keeper", "solver"] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];
export type OrderPattern = "milestone" | "outcome" | "proof";
/** Pola bayar tiap jenis. Pemantauan (`day`) dan konsultasi (`minute`) tidak ada di sini: keduanya terukur seperti P5 dan memakai endpoint terukur. */
export const ORDER_PATTERN: Readonly<Record<OrderKind, OrderPattern>> = {
  prompt: "milestone", research: "milestone", translation: "milestone", annotation: "milestone", scraping: "milestone", audit: "milestone", loadtest: "milestone", freelance: "milestone",
  bug: "outcome", lead: "outcome", keeper: "proof", solver: "proof",
};
/** Nomor katalog barter tiap jenis. */
export const ORDER_CATALOG_NO: Readonly<Record<OrderKind, number>> = {
  prompt: 39, research: 40, translation: 41, annotation: 42, scraping: 43, audit: 52, loadtest: 53, freelance: 83, bug: 88, lead: 51, keeper: 46, solver: 48,
};
/** Method kontrak yang dihitung sebagai bukti, per jenis. */
export const PROOF_METHODS: Readonly<Record<"keeper" | "solver", readonly string[]>> = { keeper: ["close_epoch", "finalize_epoch"], solver: ["submit_clearing"] };
export const ORDER_RESOURCE_PREFIX = "x207:order:";
export const MAX_MILESTONES = 24;

export type OrderErrorCode =
  | "order_bad_kind" | "order_bad_account" | "order_same_party" | "order_bad_hash" | "order_sample_required" | "order_target_required" | "order_target_forbidden" | "order_bad_target"
  | "order_bad_milestones" | "order_bad_amount" | "order_bad_proof" | "order_bad_nonce" | "order_bad_resource" | "order_not_proof_kind" | "order_bad_state";

export class OrderError extends Error {
  constructor(readonly code: OrderErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "OrderError";
  }
}

export type OrderMilestone = { amount: U128String; due_at: number };
export type OrderProof = { method: string; amount_per_tx: U128String };
export type OrderDocument = {
  circle: AccountId;
  kind: OrderKind;
  buyer: AccountId;
  seller: AccountId;
  /** sha256 heks dari spesifikasi kerja (isi tetap di luar rantai). */
  spec_hash: string;
  milestones: OrderMilestone[];
  /** Contoh hasil: wajib untuk `prompt`; hash dikunci saat pesanan dibuat. */
  sample_hash?: string | null;
  /** Nama host target uji beban: wajib untuk `loadtest`, dilarang untuk jenis lain. */
  target?: string | null;
  /** Wajib untuk `keeper` dan `solver`, dilarang untuk jenis lain. */
  proof?: OrderProof | null;
  nonce: string;
};

const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const AMOUNT = /^[1-9]\d*$/;
const HASH = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9._-]{1,32}$/;
const HOST = /^(?=.{3,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z][a-z\d-]{0,61}[a-z\d]$/;
const U128_MAX = 340282366920938463463374607431768211455n;
const fail = (code: OrderErrorCode, message: string): never => {
  throw new OrderError(code, message);
};
const isAccount = (v: unknown): v is string => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT.test(v);
const isAmount = (v: unknown): v is string => typeof v === "string" && AMOUNT.test(v) && BigInt(v) <= U128_MAX;

/** Memeriksa dokumen dan mengembalikan bentuk kanonik (kunci tetap, `null` untuk yang kosong). */
export function normalizeOrder(order: OrderDocument): Required<OrderDocument> {
  if (!ORDER_KINDS.includes(order.kind)) fail("order_bad_kind", `jenis pesanan tidak dikenal: ${JSON.stringify(order.kind)}; pilih ${ORDER_KINDS.join(", ")}`);
  for (const [name, value] of [["circle", order.circle], ["buyer", order.buyer], ["seller", order.seller]] as const) if (!isAccount(value)) fail("order_bad_account", `${name} bukan akun NEAR: ${JSON.stringify(value)}`);
  if (order.buyer === order.seller) fail("order_same_party", "pembeli dan penjual harus akun yang berbeda");
  if (!HASH.test(order.spec_hash)) fail("order_bad_hash", "spec_hash harus 64 heksadesimal huruf kecil");
  const sample = order.sample_hash ?? null;
  if (sample !== null && !HASH.test(sample)) fail("order_bad_hash", "sample_hash harus 64 heksadesimal huruf kecil");
  if (order.kind === "prompt" && sample === null) fail("order_sample_required", "pesanan prompt wajib memuat sample_hash: hasil yang mudah disalin harus punya contoh yang dikunci");
  const target = order.target ?? null;
  if (order.kind === "loadtest" && target === null) fail("order_target_required", "pesanan uji beban wajib memuat target");
  if (order.kind !== "loadtest" && target !== null) fail("order_target_forbidden", "target hanya untuk pesanan uji beban");
  if (target !== null && (!HOST.test(target) || /^\d+(\.\d+){3}$/.test(target) || target === "localhost" || target.endsWith(".localhost") || target.endsWith(".local") || target.endsWith(".internal"))) {
    fail("order_bad_target", "target harus nama host publik, bukan alamat IP, localhost, .local, atau .internal");
  }
  if (!Array.isArray(order.milestones) || order.milestones.length < 1 || order.milestones.length > MAX_MILESTONES) fail("order_bad_milestones", `tonggak harus 1 sampai ${MAX_MILESTONES}`);
  let previous = 0;
  for (const m of order.milestones) {
    if (!isAmount(m.amount)) fail("order_bad_amount", `amount tonggak harus bilangan bulat desimal > 0 (satuan terkecil), dapat ${JSON.stringify(m.amount)}`);
    if (!Number.isSafeInteger(m.due_at) || m.due_at <= previous) fail("order_bad_milestones", "due_at harus detik unix dan naik dari tonggak ke tonggak");
    previous = m.due_at;
  }
  const pattern = ORDER_PATTERN[order.kind];
  const proof = order.proof ?? null;
  if (pattern === "proof") {
    const methods = PROOF_METHODS[order.kind as "keeper" | "solver"];
    if (proof === null || !methods.includes(proof.method)) fail("order_bad_proof", `pesanan ${order.kind} wajib memuat proof.method salah satu dari ${methods.join(", ")}`);
    if (!isAmount(proof!.amount_per_tx)) fail("order_bad_amount", `proof.amount_per_tx harus bilangan bulat desimal > 0, dapat ${JSON.stringify(proof!.amount_per_tx)}`);
  } else if (proof !== null) {
    fail("order_bad_proof", "proof hanya untuk pesanan keeper dan solver");
  }
  if (typeof order.nonce !== "string" || !NONCE.test(order.nonce)) fail("order_bad_nonce", "nonce harus 1 sampai 32 karakter [A-Za-z0-9._-]");
  return {
    circle: order.circle, kind: order.kind, buyer: order.buyer, seller: order.seller, spec_hash: order.spec_hash,
    milestones: order.milestones.map((m) => ({ amount: m.amount, due_at: m.due_at })), sample_hash: sample, target,
    proof: proof === null ? null : { method: proof.method, amount_per_tx: proof.amount_per_tx }, nonce: order.nonce,
  };
}

/** JSON kanonik pesanan: kunci `circle, kind, buyer, seller, spec_hash, milestones, sample_hash, target, proof, nonce`, tanpa spasi. */
export const serializeOrder = (order: OrderDocument): string => JSON.stringify(normalizeOrder(order));
export const orderHash = (order: OrderDocument): string => createHash("sha256").update(serializeOrder(order)).digest("hex");

export function orderResource(hash: string): string {
  if (!HASH.test(hash)) fail("order_bad_resource", "hash pesanan harus 64 heksadesimal huruf kecil");
  return `${ORDER_RESOURCE_PREFIX}${hash}`;
}
export function parseOrderResource(resource: string): string | null {
  if (!resource.startsWith(ORDER_RESOURCE_PREFIX)) return null;
  const hash = resource.slice(ORDER_RESOURCE_PREFIX.length);
  return HASH.test(hash) ? hash : null;
}

/** Jumlah semua tonggak: anggaran pesanan (batas atas yang bisa dibayar). */
export function orderBudget(order: OrderDocument): U128String {
  return normalizeOrder(order).milestones.reduce((n, m) => n + BigInt(m.amount), 0n).toString();
}

/**
 * Syarat bundle yang mengunci anggaran pesanan di `epoch`, seperti SD-067: leg pembeli ke penjual sebesar `amount` (bawaan: seluruh anggaran) ditambah leg pendamping penjual ke
 * pembeli sebesar 1 satuan terkecil, karena kontrak menuntut dua leg. Bundle hanya hidup di epoch itu.
 */
export function orderBundleTerms(args: { order: OrderDocument; epoch: number; amount?: U128String }): BundleTerms {
  const o = normalizeOrder(args.order);
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 1) fail("order_bad_state", `epoch harus bilangan bulat >= 1, dapat ${args.epoch}`);
  const amount = args.amount ?? orderBudget(o);
  if (!isAmount(amount)) fail("order_bad_amount", `amount bundle tidak sah: ${JSON.stringify(amount)}`);
  return {
    circle: o.circle, epoch: args.epoch,
    legs: [{ payer: o.buyer, payee: o.seller, max_amount: amount }, { payer: o.seller, payee: o.buyer, max_amount: "1" }],
  };
}

/**
 * Voucher untuk tonggak `index` (mulai 1) sesudah tonggak itu terkonfirmasi, melanjutkan keadaan pasangan di `epoch`. Tonggak yang disengketakan tidak dibayar dan tidak mengubah
 * keadaan, jadi voucher tonggak berikutnya dibuat dari keadaan pasangan yang sebenarnya (`state`), bukan dari rantai voucher yang dihitung di depan.
 * `paid` wajib: indeks tonggak yang sudah dibayar pemanggil (`OrderLedger` mencatatnya); tonggak yang sudah dibayar ditolak, jadi satu tonggak tidak dibayar dua kali.
 */
export function milestoneVoucher(args: { order: OrderDocument; index: number; epoch: number; state: InvoicePairState; paid: readonly number[] }): UnsignedVoucher {
  const o = normalizeOrder(args.order);
  // F5 (review BE-062): the library has no memory, so the caller must say which milestones it paid; a milestone is paid once
  if (!Array.isArray(args.paid)) fail("order_bad_state", "paid (tonggak yang sudah dibayar) wajib diberikan");
  if (args.paid.includes(args.index)) fail("order_bad_state", `tonggak ${args.index} sudah dibayar`);
  const item = o.milestones[args.index - 1];
  if (!Number.isInteger(args.index) || item === undefined) fail("order_bad_milestones", `tonggak ${args.index} tidak ada; pesanan ini punya ${o.milestones.length}`);
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 1) fail("order_bad_state", `epoch harus bilangan bulat >= 1, dapat ${args.epoch}`);
  if (!Number.isSafeInteger(args.state.seq) || args.state.seq < 0 || !/^(0|[1-9]\d*)$/.test(args.state.cumulativeAmount)) fail("order_bad_state", `keadaan pasangan tidak sah: ${JSON.stringify(args.state)}`);
  return {
    circle: o.circle, payer: o.buyer, payee: o.seller, epoch: args.epoch, seq: args.state.seq + 1,
    cumulativeAmount: (BigInt(args.state.cumulativeAmount) + BigInt(item!.amount)).toString(), unit: CREDIT_UNIT,
    resource: orderResource(orderHash(o)),
  };
}

/** Bukti on-chain dari backend (`GET orders/{hash}/onchain-proofs`, BE-055): satu transaksi penyedia. */
export type OnchainProof = { txHash: string; method: string; signer: AccountId };
export type ProofRefusal = { txHash: string; reason: "wrong_signer" | "wrong_method" | "already_paid" | "over_budget" | "unverified" };
export type PayForProofsResult = { vouchers: Voucher[]; paid: string[]; refused: ProofRefusal[]; state: InvoicePairState; spent: U128String };

/**
 * Helper pembeli untuk pesanan `keeper` dan `solver`: satu voucher per bukti yang cocok, masing-masing sebesar `proof.amount_per_tx`, berurutan di epoch `epoch` mulai dari keadaan
 * pasangan `state`. Bukti ditolak (bukan dibayar) bila ditandatangani akun lain, memakai method lain, sudah dibayar (`alreadyPaid`, juga bila muncul dua kali), atau akan melewati
 * anggaran pesanan (`alreadySpent` + yang dibayar di sini tidak boleh melebihi `orderBudget`). Tidak ada yang dibayar untuk pesanan dengan pola lain.
 */
export function payForProofs(args: {
  order: OrderDocument;
  epoch: number;
  state: InvoicePairState;
  proofs: readonly OnchainProof[];
  /** Wajib (F4): hash transaksi yang sudah dibayar; `[]` ditulis eksplisit pada panggilan pertama. */
  alreadyPaid: readonly string[];
  /** Wajib (F4): yang sudah dibayar untuk pesanan ini, satuan credit terkecil (`"0"` pada panggilan pertama). */
  alreadySpent: U128String;
  /** Opsional (F12): tanya rantai apakah transaksi itu nyata, dari penyedia itu, dengan method itu; `false` menolaknya (`unverified`). Tanpa ini bukti dipercaya dari backend apa adanya. */
  verifyTx?: (proof: OnchainProof) => boolean;
  secretKey: VoucherSecretKey;
}): PayForProofsResult {
  const o = normalizeOrder(args.order);
  if (ORDER_PATTERN[o.kind] !== "proof" || o.proof === null) fail("order_not_proof_kind", `pesanan ${o.kind} tidak dibayar per bukti on-chain`);
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 1) fail("order_bad_state", `epoch harus bilangan bulat >= 1, dapat ${args.epoch}`);
  const budget = BigInt(orderBudget(o));
  const each = BigInt(o.proof!.amount_per_tx);
  if (!Array.isArray(args.alreadyPaid) || typeof args.alreadySpent !== "string" || !/^(0|[1-9]\d*)$/.test(args.alreadySpent)) {
    fail("order_bad_state", "alreadyPaid dan alreadySpent wajib diberikan (dari panggilan sebelumnya)");
  }
  const seen = new Set(args.alreadyPaid);
  let spent = BigInt(args.alreadySpent);
  let seq = args.state.seq;
  let cumulative = BigInt(args.state.cumulativeAmount);
  const resource = orderResource(orderHash(o));
  const vouchers: Voucher[] = [];
  const paid: string[] = [];
  const refused: ProofRefusal[] = [];
  for (const proof of args.proofs) {
    const reason: ProofRefusal["reason"] | null =
      proof.signer !== o.seller ? "wrong_signer" : proof.method !== o.proof!.method ? "wrong_method" : seen.has(proof.txHash) ? "already_paid" : spent + each > budget ? "over_budget" : args.verifyTx !== undefined && !args.verifyTx(proof) ? "unverified" : null;
    if (reason !== null) {
      refused.push({ txHash: proof.txHash, reason });
      continue;
    }
    seq += 1;
    cumulative += each;
    spent += each;
    seen.add(proof.txHash);
    vouchers.push(signVoucher({ circle: o.circle, payer: o.buyer, payee: o.seller, epoch: args.epoch, seq, cumulativeAmount: cumulative.toString(), unit: CREDIT_UNIT, resource }, args.secretKey));
    paid.push(proof.txHash);
  }
  return { vouchers, paid, refused, state: { seq, cumulativeAmount: cumulative.toString() }, spent: spent.toString() };
}

/**
 * Buku bayar satu pesanan di sisi pembeli (F4 dan F5): mencatat tonggak dan transaksi yang sudah dibayar dan jumlahnya, jadi satu tonggak tidak dibayar dua kali dan satu bukti tidak
 * dibayar dua kali, juga setelah agen dijalankan lagi (simpan `snapshot()` dan buat lagi dengan `OrderLedger.restore`). Voucher tetap harus didaftarkan penjual; buku ini hanya mengingat
 * apa yang sudah ditandatangani.
 */
export class OrderLedger {
  readonly order: OrderDocument;
  readonly #milestones = new Set<number>();
  readonly #proofs = new Set<string>();
  #spent = 0n;

  constructor(order: OrderDocument, saved?: { milestones: readonly number[]; proofs: readonly string[]; spent: U128String }) {
    this.order = order;
    normalizeOrder(order);
    if (saved) {
      for (const m of saved.milestones) this.#milestones.add(m);
      for (const t of saved.proofs) this.#proofs.add(t);
      this.#spent = BigInt(saved.spent);
    }
  }
  static restore(order: OrderDocument, saved: { milestones: readonly number[]; proofs: readonly string[]; spent: U128String }): OrderLedger {
    return new OrderLedger(order, saved);
  }
  snapshot(): { milestones: number[]; proofs: string[]; spent: U128String } {
    return { milestones: [...this.#milestones], proofs: [...this.#proofs], spent: this.#spent.toString() };
  }
  get spent(): U128String {
    return this.#spent.toString();
  }

  /** Voucher untuk tonggak yang terkonfirmasi, dicatat sebagai dibayar; tonggak yang sama dua kali ditolak. */
  payMilestone(args: { index: number; epoch: number; state: InvoicePairState; secretKey: VoucherSecretKey }): Voucher {
    const unsigned = milestoneVoucher({ order: this.order, index: args.index, epoch: args.epoch, state: args.state, paid: [...this.#milestones] });
    const amount = BigInt(unsigned.cumulativeAmount) - BigInt(args.state.cumulativeAmount);
    if (this.#spent + amount > BigInt(orderBudget(this.order))) fail("order_bad_state", "melewati anggaran pesanan");
    const signed = signVoucher(unsigned, args.secretKey);
    this.#milestones.add(args.index);
    this.#spent += amount;
    return signed;
  }

  /** Bayar per bukti on-chain dengan catatan buku ini. */
  payProofs(args: { epoch: number; state: InvoicePairState; proofs: readonly OnchainProof[]; secretKey: VoucherSecretKey; verifyTx?: (proof: OnchainProof) => boolean }): PayForProofsResult {
    const result = payForProofs({
      order: this.order, epoch: args.epoch, state: args.state, proofs: args.proofs, alreadyPaid: [...this.#proofs], alreadySpent: this.#spent.toString(), secretKey: args.secretKey,
      ...(args.verifyTx ? { verifyTx: args.verifyTx } : {}),
    });
    for (const t of result.paid) this.#proofs.add(t);
    this.#spent = BigInt(result.spent);
    return result;
  }
}
