# Format intent barter dan bundle x207

Sumber: SD-047 (F5, F9). Kontrak `x207-circle` (`post_intent`, `commit_bundle`) membangun byte yang sama. Test vector: [`test-vectors/barter/`](./test-vectors/barter/). Kode: `packages/core/src/barter.ts`.

## Intent barter
Akun menawarkan `offer` dan membutuhkan `need`. Nilai dalam credit satuan terkecil (6 desimal).

1. **`message`** = JSON kanonik, key dalam urutan `circle, account, offer, need, expiresAt, nonce`, tanpa spasi. `offer` dan `need` berbentuk `{service, calls, value}` dengan urutan key itu.
2. Aturan nilai: `service` = ASCII `[a-z0-9][a-z0-9._:-]{0,63}`; `calls` integer ≥ 1; `value` string desimal > 0 tanpa nol di depan dan ≤ U128; `expiresAt` integer detik unix ≥ 1; `nonce` = 1 sampai 64 karakter `[A-Za-z0-9_-]`; `circle` dan `account` akun NEAR sah. Nilai tidak dinormalisasi.
3. **`intent_hash`** = `sha256(UTF-8 message)`, 32 byte. Argumen `post_intent(intent_hash)` memakai `Base58CryptoHash` (base58 dari 32 byte itu); heks huruf kecil dipakai di API dan log.
4. **Tanda tangan intent** (opsional di luar kontrak) = ed25519 kunci voucher atas `sha256(payload NEP-413)` dengan `message` di atas, `nonce` = `intent_hash` (32 byte), `recipient` = `circle`, `callback_url` = `None`. Payload: `u32 LE 2147484061` lalu borsh `{ message, nonce[32], recipient, callback_url }`, persis seperti [`voucher-format.md`](./voucher-format.md).

## Syarat bundle
1. **`message`** = JSON kanonik `{"circle":…,"epoch":…,"legs":[{"payer":…,"payee":…,"max_amount":…},…]}`, tanpa spasi. Leg diurutkan menurut `(payer, payee)` (perbandingan string UTF-8 per byte), sehingga urutan input tidak memengaruhi hash. Nama `max_amount` sama dengan field `BundleLeg` kontrak dan event `bundle_committed`.
2. Aturan: minimal dua leg; `payer` ≠ `payee`; pasangan `(payer, payee)` unik; `max_amount` string desimal > 0 tanpa nol di depan dan ≤ U128; `epoch` integer ≥ 1.
3. **`terms_hash`** = `sha256(UTF-8 message)`, ditulis heks huruf kecil 64 karakter.
4. **Yang ditandatangani tiap peserta** = `sha256(payload NEP-413)` dengan `message` di atas, `nonce` = `terms_hash` (32 byte), `recipient` = `circle`, `callback_url` = `None`. Tanda tangan ed25519 dengan kunci voucher akun itu (`pubkey_voucher` di D1), ditulis `ed25519:<base58 64 byte>`.
5. **Peserta** = semua akun yang muncul sebagai `payer` atau `payee`. Bundle sah bila setiap peserta punya tepat satu tanda tangan sah atas `terms_hash` yang sama.

Contoh A→B→C→A (10, 8, 6 credit): [`test-vectors/barter/bundle_abca.json`](./test-vectors/barter/bundle_abca.json).

## Aturan kontrak yang berlaku untuk bundle
- **`terms_hash` unik.** `commit_bundle` menolak `terms_hash` yang sudah tercatat dengan `ERR_BUNDLE_EXISTS`. Syarat bundle yang identik (hash sama) tidak bisa dipakai dua kali; bundle berikutnya dengan leg yang sama harus berbeda di salah satu field kanonik, yaitu `epoch` atau nilai `max_amount`. Hash sama berarti `circle`, `epoch`, dan seluruh leg sama.
- **Epoch berjalan.** `bundle.epoch` harus epoch berjalan dengan fase `open`. Bundle untuk epoch lain atau yang sudah ditutup ditolak.
- **Error muncul apa adanya.** SDK tidak menerjemahkan atau membungkus kode kontrak: pesan panic `ERR_*` (mis. `ERR_BUNDLE_EXISTS`, `ERR_BUNDLE_SIGNATURES`, `ERR_BUNDLE_HEADROOM`) sampai ke pemanggil, dan `contractErrorCode(error)` mengembalikan kodenya. Penyebab umum `ERR_BUNDLE_EXISTS`: pemanggil mengirim ulang usulan yang sama dalam satu epoch.
