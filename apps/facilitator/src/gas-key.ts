// Gas keys (NEP-611, ADR-11b) untuk relayer facilitator (SD-031): satu kunci punya banyak jalur nonce (0..1023), jadi beberapa transaksi
// registrasi bisa dikirim paralel tanpa bentrok nonce. Transaksi memakai `Transaction::V1` (awalan 0x01, `GasKeyNonce { nonce, nonce_index }`,
// `NonceMode::Monotonic`), dan gas dibayar dari saldo kunci. `@near-js/transactions` 2.5.1 belum bisa mengodekan V1, jadi byte ditulis di sini
// dan dicocokkan dengan referensi near-api-js 7.4.0 di test.
import { createHash } from "node:crypto";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { base58Decode, base58Encode } from "@x207/core";

const ED25519_KEY_TYPE = 0;
const FUNCTION_CALL_ACTION = 2;
const TRANSACTION_V1_PREFIX = 1;
const NONCE_GAS_KEY = 1;
const NONCE_MODE_MONOTONIC = 0;
export const MAX_GAS_KEY_LANES = 1024;
/** Longest time one use of a lane may take, for the nonce read and for the work together (security review 3, L1). */
export const GAS_KEY_LANE_TIMEOUT_MS = 60_000;

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gas key lane: ${what} took longer than ${ms} ms`)), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error)),
    );
  });

class Writer {
  readonly chunks: Buffer[] = [];
  u8(value: number) {
    this.chunks.push(Buffer.from([value]));
  }
  u16(value: number) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(value);
    this.chunks.push(b);
  }
  u32(value: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value);
    this.chunks.push(b);
  }
  u64(value: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value);
    this.chunks.push(b);
  }
  u128(value: bigint) {
    this.u64(value & 0xffffffffffffffffn);
    this.u64(value >> 64n);
  }
  bytes(value: Uint8Array) {
    this.chunks.push(Buffer.from(value));
  }
  string(value: string) {
    const b = Buffer.from(value, "utf8");
    this.u32(b.length);
    this.chunks.push(b);
  }
  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export type GasKeyCall = {
  signerId: string;
  receiverId: string;
  nonce: bigint;
  /** Jalur nonce 0..1023. */
  nonceIndex: number;
  blockHash: Uint8Array;
  methodName: string;
  args: unknown;
  gas: bigint;
  deposit: bigint;
};

/** Byte borsh `Transaction::V1` dengan satu aksi FunctionCall. */
export function encodeGasKeyTransaction(tx: GasKeyCall, publicKey: Uint8Array): Buffer {
  if (!Number.isInteger(tx.nonceIndex) || tx.nonceIndex < 0 || tx.nonceIndex >= MAX_GAS_KEY_LANES) throw new Error("nonceIndex must be an integer 0..1023");
  const w = new Writer();
  w.u8(TRANSACTION_V1_PREFIX);
  w.string(tx.signerId);
  w.u8(ED25519_KEY_TYPE);
  w.bytes(publicKey);
  w.u8(NONCE_GAS_KEY);
  w.u64(tx.nonce);
  w.u16(tx.nonceIndex);
  w.string(tx.receiverId);
  w.bytes(tx.blockHash);
  w.u32(1);
  w.u8(FUNCTION_CALL_ACTION);
  w.string(tx.methodName);
  const args = Buffer.from(JSON.stringify(tx.args), "utf8");
  w.u32(args.length);
  w.bytes(args);
  w.u64(tx.gas);
  w.u128(tx.deposit);
  w.u8(NONCE_MODE_MONOTONIC);
  return w.finish();
}

export type SignedGasKeyTx = { bytes: Buffer; hash: string };

export function signGasKeyTransaction(tx: GasKeyCall, privateKey: string): SignedGasKeyTx {
  const key = KeyPair.fromString(privateKey as KeyPairString);
  const publicKey = base58Decode(key.getPublicKey().toString().replace(/^ed25519:/, ""));
  const body = encodeGasKeyTransaction(tx, publicKey);
  const digest = createHash("sha256").update(body).digest();
  const signature = key.sign(digest).signature;
  return { bytes: Buffer.concat([body, Buffer.from([ED25519_KEY_TYPE]), Buffer.from(signature)]), hash: base58Encode(digest) };
}

/**
 * Pembagi jalur nonce: tiap transaksi memegang satu jalur sampai selesai, jadi dua transaksi paralel tidak pernah memakai nonce yang sama.
 * Nonce tiap jalur dibaca dari chain pada pemakaian pertama dan setelah kegagalan jaringan, selebihnya dihitung lokal.
 */
export class GasKeyLanes {
  readonly #busy: boolean[];
  readonly #nonce: Array<bigint | undefined>;
  readonly #waiting: Array<() => void> = [];
  #next = 0;

  /** `timeoutMs`: a read of the nonce or a `work` that takes longer fails and gives the lane back (the nonce of the lane is then read again). */
  constructor(readonly count: number, readonly timeoutMs: number = GAS_KEY_LANE_TIMEOUT_MS) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("gas key lane timeout must be a positive integer");
    if (!Number.isInteger(count) || count < 1 || count > MAX_GAS_KEY_LANES) throw new Error(`gas key lane count must be 1..${MAX_GAS_KEY_LANES}`);
    this.#busy = new Array<boolean>(count).fill(false);
    this.#nonce = new Array<bigint | undefined>(count).fill(undefined);
  }

  /** Jalankan `work(lane, nonceTerakhir)` di jalur bebas (menunggu bila semua sibuk). `work` mengembalikan nonce yang terpakai atau melempar. */
  async run<T>(readNonce: (lane: number) => Promise<bigint>, work: (lane: number, nonce: bigint) => Promise<T>): Promise<T> {
    const lane = await this.#acquire();
    try {
      try {
        let last = this.#nonce[lane];
        if (last === undefined) last = await withTimeout(readNonce(lane), this.timeoutMs, "reading the nonce");
        const result = await withTimeout(work(lane, last + 1n), this.timeoutMs, "the work");
        this.#nonce[lane] = last + 1n;
        return result;
      } catch (error) {
        // transaksi mungkin tidak sampai ke blok: baca ulang nonce jalur ini dari chain pada pemakaian berikutnya
        this.#nonce[lane] = undefined;
        throw error;
      }
    } finally {
      this.#release(lane);
    }
  }

  async #acquire(): Promise<number> {
    for (;;) {
      for (let i = 0; i < this.count; i += 1) {
        const lane = (this.#next + i) % this.count;
        if (!this.#busy[lane]) {
          this.#busy[lane] = true;
          this.#next = (lane + 1) % this.count;
          return lane;
        }
      }
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
  }

  #release(lane: number) {
    this.#busy[lane] = false;
    this.#waiting.shift()?.();
  }
}
