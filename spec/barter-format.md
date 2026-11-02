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

### Leg pencari `search_leg` (interface 0.0.5)
6. **`search_leg`** opsional: `{"payer":…,"payee":…}`, menandai leg bundle yang membayar pencari (F9). Bila ada, kuncinya **terakhir** di `message`, sesudah `legs`: `{"circle":…,"epoch":…,"legs":[…],"search_leg":{"payer":…,"payee":…}}`, tanpa spasi, urutan kunci `payer` lalu `payee`. Bila tidak ada (atau `null` di SDK), `message` dan `terms_hash` sama persis dengan format sebelum 0.0.5; `bundle_abca.json` tetap sah dan tidak berubah.
7. Aturan: pasangan `(payer, payee)` harus salah satu leg bundle (SDK melempar `BarterFormatError`; kontrak `ERR_BAD_BUNDLE`). Kontrak membatasi `max_amount` leg itu sampai `max_search_share_bps` (bawaan 500 = 5%) dari jumlah `max_amount` semua leg; lebih dari itu `ERR_SEARCH_SHARE_EXCEEDED`. `search_leg` ikut di bytes yang ditandatangani, jadi peserta yang menandatangani syarat tanpa `search_leg` tidak sah untuk bundle dengan `search_leg` (`ERR_BUNDLE_SIGNATURES`).
8. Argumen `commit_bundle`: `bundle: { epoch, legs, search_leg? }`.

Contoh dengan leg pencari (55, 40, 5 credit; leg 5 dari 100 = 500 bps): [`test-vectors/barter/bundle_search.json`](./test-vectors/barter/bundle_search.json). Byte JSON dan `terms_hash`-nya dicocokkan dengan kontrak 0.0.5 di near-sandbox (`packages/core/test/sandbox/search-leg.sandbox.test.ts`: `get_bundle.terms_hash` kontrak sama dengan `termsHash` SDK) dan dengan fungsi `terms_message` di `contracts/x207-circle/src/bundle.rs`. Sisi kontrak menyalin vector ke `contracts/tests/vectors/barter/` bila ingin test unit.

## Aturan kontrak yang berlaku untuk bundle
- **`terms_hash` unik.** `commit_bundle` menolak `terms_hash` yang sudah tercatat dengan `ERR_BUNDLE_EXISTS`. Syarat bundle yang identik (hash sama) tidak bisa dipakai dua kali; bundle berikutnya dengan leg yang sama harus berbeda di salah satu field kanonik, yaitu `epoch` atau nilai `max_amount`. Hash sama berarti `circle`, `epoch`, dan seluruh leg sama.
- **Epoch berjalan.** `bundle.epoch` harus epoch berjalan dengan fase `open`. Bundle untuk epoch lain atau yang sudah ditutup ditolak.
- **Error muncul apa adanya.** SDK tidak menerjemahkan atau membungkus kode kontrak: pesan panic `ERR_*` (mis. `ERR_BUNDLE_EXISTS`, `ERR_BUNDLE_SIGNATURES`, `ERR_BUNDLE_HEADROOM`) sampai ke pemanggil, dan `contractErrorCode(error)` mengembalikan kodenya. Penyebab umum `ERR_BUNDLE_EXISTS`: pemanggil mengirim ulang usulan yang sama dalam satu epoch.

## Voucher leg bundle (SD-048, interface 0.0.4)
Bytes voucher tidak berubah. Pembayaran F2 ke penyedia yang merupakan leg bundle membawa `bundleId` (integer >= 0) di `payload` x402 di samping `voucher` dan `signature`:

| Peran | Perilaku |
| --- | --- |
| Klien (`X207SchemeClient`, `X207PaymentClient`) | Opsi `bundleFor(payee, epoch)` mengembalikan `bundle_id` untuk pasangan yang merupakan leg. Payload memuat `bundleId`; entri x207 dipilih walau headroom bebas habis dan estimasi headroom tidak dikurangi |
| Facilitator `verify` | Untuk `bundleId`: `get_bundle` harus ada, `status` `active`, `epoch` sama dengan voucher, pasangan (payer, payee) adalah leg, dan `cumulativeAmount` <= `max_amount` leg. Cek headroom bebas dilewati. Penolakan: `bundle_unknown`, `bundle_epoch_mismatch`, `not_a_bundle_leg`, `bundle_leg_exceeded` |
| Facilitator `settle` dan D3 | `pending_vouchers.bundle_id` menyimpan `bundleId`; baris leg bundle tidak mengurangi headroom bebas di `computeHeadroom` |
| Scheduler | Baris dengan `bundle_id` didaftarkan lewat `register_in_bundle(bundle_id, voucher, signature)`; `ERR_BUNDLE_LEG_EXCEEDED`, `ERR_BUNDLE_LEG`, `ERR_UNKNOWN_BUNDLE` menggugurkan baris (`bundle_leg_exceeded`, `not_a_bundle_leg`, `bundle_unknown`) |

`verify` membaca blok final: bundle yang baru di-commit baru terlihat setelah finalitas, sebelum itu voucher leg ditolak `bundle_unknown` dan klien dapat mengulang.

## Endpoint grant F8 (SD-053, interface 0.0.6)
Endpoint yang melayani grant (broker M10) memakai alur F2 apa adanya dengan tiga aturan:
- Server menaruh `grantId` (integer >= 1) di `extra` entri `batch-settlement` dan memakai `payTo` = **pemberi grant**, bukan akun broker (`x207Middleware`: `routes[...].grant(request)` mengembalikan `{ grantId, payTo }`, atau `undefined` untuk 404 `grant_not_found`). Entri `exact` tidak memuat `grantId`.
- Klien menyusun voucher dengan `payee` = `payTo` dan `resource` = `x207:grant:<grantId>` (`grantResource`), bukan URL endpoint. Pasangan voucher tetap `(payer, payee, epoch)`, jadi headroom dan kliring tidak berubah.
- Facilitator `verify`: `voucher.payee` != `payTo` tetap `payee_mismatch` (voucher ber-payee akun broker ditolak) dan `voucher.resource` != `x207:grant:<grantId>` ditolak `grant_resource_mismatch`.

Vektor: [`test-vectors/grant/voucher_grant.json`](./test-vectors/grant/voucher_grant.json) (voucher sah, payee broker, resource URL, resource grant lain).
