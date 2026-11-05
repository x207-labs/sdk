// Voucher signer abstraction (SD-088). `signVoucher` (sync, ed25519) stays as it is; a `VoucherSigner` is the async way that also covers EVM agents (`@x207/core/evm`).
import { signVoucher, voucherPublicKey, type VoucherSecretKey } from "./voucher.js";
import type { UnsignedVoucher, Voucher } from "./types.js";

export interface VoucherSigner {
  readonly scheme: "ed25519" | "eip712";
  /** ed25519: the voucher public key `ed25519:<base58>`. eip712: the lower-case `0x` address, which is the member id. */
  readonly id: string;
  signVoucher(voucher: UnsignedVoucher): Promise<Voucher>;
}

/** The existing behaviour as a signer: ed25519 over the NEP-413 hash. */
export function ed25519Signer(secretKey: VoucherSecretKey): VoucherSigner {
  return {
    scheme: "ed25519",
    id: voucherPublicKey(secretKey),
    signVoucher: async (voucher) => signVoucher(voucher, secretKey),
  };
}

/** Sign with any signer. */
export const signVoucherWith = (voucher: UnsignedVoucher, signer: VoucherSigner): Promise<Voucher> => signer.signVoucher(voucher);
