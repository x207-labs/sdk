# x207 voucher byte format

Source: SD-005. The `x207-circle` contract (Rust) builds the same bytes; test vectors are in [`test-vectors/voucher/`](./test-vectors/voucher/).

A voucher without `signature` (`UnsignedVoucher`) is signed with the ed25519 voucher key (`pubkey_voucher` in D1). This key is separate from the access key of the NEAR account (ADR-06).

1. **`message`** = canonical JSON: keys `circle, payer, payee, epoch, seq, cumulativeAmount, unit, resource` in that order, no spaces. `epoch` and `seq` are JSON integers; `cumulativeAmount` is a decimal string with no leading zero, ≤ U128; `unit` is `"credit"`; `resource` is ASCII. String escaping follows standard JSON (`"` `\\` and control characters; `/` and DEL are not escaped), the same as `JSON.stringify` and `serde_json`.
2. **`nonce`** = `sha256(UTF-8 "x207:" + payer + ":" + payee + ":" + epoch + ":" + seq)`, 32 bytes.
3. **`recipient`** = `circle`. `callback_url` = `None`.
4. **`payload`** = `u32 LE 2147484061` (NEP-413 tag = 2^31 + 413; bytes `9d 01 00 80`), then borsh of `{ message: String, nonce: [u8; 32], recipient: String, callback_url: Option<String> }`. A borsh string = `u32 LE` UTF-8 byte length + the bytes; `Option::None` = one byte `00`.
5. **What is signed** = `sha256(payload)` (32 bytes). The signature is ed25519 (RFC 8032, deterministic), written `ed25519:<base58 64 bytes>`. The public key is written `ed25519:<base58 32 bytes>`.

Refused at serialization: `cumulativeAmount` with a leading zero or above U128, non-ASCII `resource`, `unit` other than `credit`, `epoch`/`seq` that is not an integer ≥ 1. Values are not normalized (K-30).
