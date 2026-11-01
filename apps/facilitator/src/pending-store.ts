// Pending store D3 (bagian off-chain): voucher diterima yang belum diregistrasi on-chain.
// Satu baris per (circle_contract, payer, payee, epoch), hanya `seq` tertinggi (Spec Binding x402 6.2, ADR-17).
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { AccountId, Ed25519Signature, PendingRowState, U128String, UnsignedVoucher } from "@x207/core";

export type PendingKey = {
  circleContract: AccountId;
  payer: AccountId;
  payee: AccountId;
  epoch: number;
};

export type PendingRow = PendingKey & {
  seq: number;
  /** U128 desimal; bandingkan sebagai BigInt (K-31). */
  cumulativeAmount: U128String;
  voucher: UnsignedVoucher;
  signature: Ed25519Signature;
  registeredSeq: number;
  registeredCumulative: U128String;
  state: PendingRowState;
  /** Percobaan registrasi yang gagal. */
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  updatedAt: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_vouchers (
  circle_contract   TEXT    NOT NULL,
  payer             TEXT    NOT NULL,
  payee             TEXT    NOT NULL,
  epoch             INTEGER NOT NULL,
  seq               INTEGER NOT NULL,
  cumulative_amount TEXT    NOT NULL,
  voucher_json      TEXT    NOT NULL,
  signature         TEXT    NOT NULL,
  registered_seq    INTEGER NOT NULL DEFAULT 0,
  registered_cumulative TEXT NOT NULL DEFAULT '0',
  state             TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending','registered','retrying','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER,
  last_error        TEXT,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (circle_contract, payer, payee, epoch)
);
CREATE INDEX IF NOT EXISTS idx_pending_payer ON pending_vouchers (circle_contract, payer, epoch);
`;

type Raw = Record<string, string | number | null>;

function toRow(raw: Raw): PendingRow {
  return {
    circleContract: raw.circle_contract as string,
    payer: raw.payer as string,
    payee: raw.payee as string,
    epoch: raw.epoch as number,
    seq: raw.seq as number,
    cumulativeAmount: raw.cumulative_amount as string,
    voucher: JSON.parse(raw.voucher_json as string) as UnsignedVoucher,
    signature: raw.signature as Ed25519Signature,
    registeredSeq: raw.registered_seq as number,
    registeredCumulative: raw.registered_cumulative as string,
    state: raw.state as PendingRowState,
    attempts: raw.attempts as number,
    nextAttemptAt: raw.next_attempt_at as number | null,
    lastError: raw.last_error as string | null,
    updatedAt: raw.updated_at as number,
  };
}

export class PendingStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #upsert: StatementSync;
  readonly #get: StatementSync;
  readonly #byPayer: StatementSync;
  readonly #fail: StatementSync;
  readonly #ok: StatementSync;
  readonly #giveUp: StatementSync;

  /** `path` berkas SQLite, atau `":memory:"`. `now` mengembalikan unix ms. */
  constructor(path: string, now: () => number = Date.now) {
    this.#db = new DatabaseSync(path);
    this.#now = now;
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA);
    this.#upsert = this.#db.prepare(`
      INSERT INTO pending_vouchers
        (circle_contract, payer, payee, epoch, seq, cumulative_amount, voucher_json, signature, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (circle_contract, payer, payee, epoch) DO UPDATE SET
        seq = excluded.seq,
        cumulative_amount = excluded.cumulative_amount,
        voucher_json = excluded.voucher_json,
        signature = excluded.signature,
        state = CASE WHEN pending_vouchers.attempts >= 1 THEN 'retrying' ELSE 'pending' END,
        updated_at = excluded.updated_at
      WHERE excluded.seq > pending_vouchers.seq`);
    const where = "circle_contract = ? AND payer = ? AND payee = ? AND epoch = ?";
    this.#get = this.#db.prepare(`SELECT * FROM pending_vouchers WHERE ${where}`);
    this.#byPayer = this.#db.prepare(
      "SELECT * FROM pending_vouchers WHERE circle_contract = ? AND payer = ? AND epoch = ? ORDER BY payee",
    );
    this.#fail = this.#db.prepare(
      `UPDATE pending_vouchers SET attempts = attempts + 1, state = 'retrying', last_error = ?,
         next_attempt_at = ?, updated_at = ? WHERE ${where}`,
    );
    this.#ok = this.#db.prepare(
      `UPDATE pending_vouchers SET registered_seq = ?, registered_cumulative = ?, state = 'registered',
         attempts = 0, next_attempt_at = NULL, updated_at = ? WHERE ${where}`,
    );
    this.#giveUp = this.#db.prepare(
      `UPDATE pending_vouchers SET state = 'failed', last_error = ?, next_attempt_at = NULL, updated_at = ?
         WHERE ${where}`,
    );
  }

  /** Simpan voucher bila `seq` lebih besar dari yang tersimpan. `true` bila baris berubah. */
  upsert(circleContract: AccountId, voucher: UnsignedVoucher, signature: Ed25519Signature): boolean {
    const result = this.#upsert.run(
      circleContract, voucher.payer, voucher.payee, voucher.epoch, voucher.seq,
      voucher.cumulativeAmount, JSON.stringify(voucher), signature, this.#now(),
    );
    return Number(result.changes) > 0;
  }

  get(key: PendingKey): PendingRow | null {
    const raw = this.#get.get(key.circleContract, key.payer, key.payee, key.epoch) as Raw | undefined;
    return raw ? toRow(raw) : null;
  }

  /** Semua baris payer di satu epoch, urut menurut payee. */
  listByPayer(circleContract: AccountId, payer: AccountId, epoch: number): PendingRow[] {
    return (this.#byPayer.all(circleContract, payer, epoch) as Raw[]).map(toRow);
  }

  /** Registrasi gagal: `attempts + 1`, status `retrying`. */
  recordFailure(key: PendingKey, error: string, nextAttemptAt: number | null = null): void {
    this.#fail.run(error, nextAttemptAt, this.#now(), key.circleContract, key.payer, key.payee, key.epoch);
  }

  /** Registrasi sukses sampai `seq`/kumulatif itu; baris lunas bila `seq` sama dengan yang tersimpan. */
  recordRegistered(key: PendingKey, seq: number, cumulativeAmount: U128String): void {
    this.#ok.run(seq, cumulativeAmount, this.#now(), key.circleContract, key.payer, key.payee, key.epoch);
  }

  /** Tetap gagal sampai `cutoff` atau error permanen; status `failed` hanya internal (K-31). */
  markFailed(key: PendingKey, error: string): void {
    this.#giveUp.run(error, this.#now(), key.circleContract, key.payer, key.payee, key.epoch);
  }

  close(): void {
    this.#db.close();
  }
}
