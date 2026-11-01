# Format byte voucher x207

Sumber: SD-005. Kontrak `x207-circle` (Rust) membangun byte yang sama; test vector ada di [`test-vectors/voucher/`](./test-vectors/voucher/).

Voucher tanpa `signature` (`UnsignedVoucher`) ditandatangani dengan kunci voucher ed25519 (`pubkey_voucher` di D1). Kunci ini terpisah dari access key akun NEAR (ADR-06).

1. **`message`** = JSON kanonik: key `circle, payer, payee, epoch, seq, cumulativeAmount, unit, resource` dalam urutan itu, tanpa spasi. `epoch` dan `seq` integer JSON; `cumulativeAmount` string desimal tanpa nol di depan, ≤ U128; `unit` `"credit"`; `resource` ASCII. Escape string mengikuti JSON standar (`"` `\\` dan karakter kontrol; `/` dan DEL tidak di-escape), sama dengan `JSON.stringify` dan `serde_json`.
2. **`nonce`** = `sha256(UTF-8 "x207:" + payer + ":" + payee + ":" + epoch + ":" + seq)`, 32 byte.
3. **`recipient`** = `circle`. `callback_url` = `None`.
4. **`payload`** = `u32 LE 2147484061` (tag NEP-413 = 2^31 + 413; byte `9d 01 00 80`), lalu borsh dari `{ message: String, nonce: [u8; 32], recipient: String, callback_url: Option<String> }`. String borsh = `u32 LE` panjang byte UTF-8 + byte; `Option::None` = satu byte `00`.
5. **Yang ditandatangani** = `sha256(payload)` (32 byte). Tanda tangan ed25519 (RFC 8032, deterministik), ditulis `ed25519:<base58 64 byte>`. Kunci publik ditulis `ed25519:<base58 32 byte>`.

Penolakan saat serialisasi: `cumulativeAmount` dengan nol di depan atau di atas U128, `resource` non-ASCII, `unit` bukan `credit`, `epoch`/`seq` bukan integer ≥ 1. Nilai tidak dinormalisasi (K-30).
