# Scheme: `batch-settlement` di network `x207:<circleId>`

Dokumen ini mengikuti kerangka `specs/scheme_template.md` x402 (`Summary`, `Use Cases`, `Appendix`). Kata MUST, SHOULD, dan MAY berarti seperti di RFC 2119. Bentuk byte voucher ada di [`voucher-format.md`](./voucher-format.md); test vector di [`test-vectors/`](./test-vectors/).

## Summary

x207 adalah lapisan settlement kredit mutual untuk pembayaran agent x402 di NEAR. Anggota satu *lingkaran* (circle) saling berutang lewat voucher bertanda tangan alih-alih membayar tiap panggilan on-chain. Di akhir epoch, siklus utang dikliring dan hanya posisi bersih yang dibayar. Scheme ini menyatakan x207 sebagai binding x402 v2 `batch-settlement` model *credit-backed* (Commit, Accumulate, Redeem) di network `x207:<circleId>`.

Penjual memakai binding ini bersama entri `exact` `near:mainnet` (USDT NEP-141) dalam satu respons 402. Pembeli anggota lingkaran membayar dengan voucher; pembeli di luar lingkaran tetap bisa membayar lewat `exact`.

### 1. Identitas binding

| Atribut | Nilai |
| --- | --- |
| Versi x402 | `x402Version: 2`; header `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, semuanya base64 (UTF-8) dari JSON tanpa spasi |
| Scheme | `batch-settlement` |
| Network | `x207:<circleId>`, contoh `x207:agents-main` |
| Validasi network | Seluruh string network MUST lolos regex CAIP-2 `^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$`. `x207:x207-circle.near` ditolak karena titik. Implementasi MUST memeriksanya saat konfigurasi, karena `register()` x402 tidak memvalidasi network |
| Akun kontrak lingkaran | Dibawa di `extra.circleContract`, bukan di network |
| Registrasi SDK | `register("x207:*", impl)` di klien, server, dan facilitator |
| Payment flow | `authorization`: verify, layani resource, settle, jawab. Flow lain MUST NOT dipakai |
| Asset dan satuan | `asset` = `"USD"`; 1 credit = 1 USD; `amount` dalam satuan terkecil dengan `extra.decimals = 6`. 0,02 USD = `"20000"` |
| Entri pendamping | Server SHOULD selalu mengiklankan `exact` `near:mainnet` |
| Nama internal | `mutual-credit` MUST NOT muncul sebagai nama scheme atau network |

Satu facilitator MAY melayani lebih dari satu lingkaran. `extra.circleContract` MUST sama dengan pemetaan `circleId` ke kontrak di konfigurasi facilitator; bila tidak, `/verify` menolak dengan `circle_mismatch`.

## Use Cases

### 2. Respons 402 dan `PAYMENT-REQUIRED`

Resource server membalas request tanpa `PAYMENT-SIGNATURE` (atau dengan pembayaran yang ditolak) dengan HTTP 402 dan header `PAYMENT-REQUIRED` berisi `PaymentRequired`. Body MAY membawa JSON yang sama.

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": { "url": "https://summarizer.example/api/summarize", "mimeType": "application/json" },
  "accepts": [
    {
      "scheme": "batch-settlement",
      "network": "x207:agents-main",
      "amount": "20000",
      "asset": "USD",
      "payTo": "summarizer.x207-circle.near",
      "maxTimeoutSeconds": 60,
      "extra": { "circleContract": "x207-circle.near", "unit": "credit", "decimals": 6, "epoch": 42 }
    },
    {
      "scheme": "exact",
      "network": "near:mainnet",
      "amount": "20000",
      "asset": "usdt.tether-token.near",
      "payTo": "summarizer.x207-circle.near",
      "maxTimeoutSeconds": 60
    }
  ]
}
```

| Field entri x207 | Aturan |
| --- | --- |
| `scheme` | MUST `batch-settlement` |
| `network` | MUST `x207:<circleId>` yang lolos regex CAIP-2 |
| `amount` | Harga satu panggilan; string bilangan bulat > 0 |
| `asset` | MUST `"USD"` |
| `payTo` | Akun NEAR penjual. Penjual MUST anggota `active` lingkaran yang sama dan bukan payer. Kontrak menolak registrasi ke payee tidak aktif dan pembayaran ke diri sendiri, jadi `/verify` memeriksanya lebih awal |
| `maxTimeoutSeconds` | `60`. Klien MUST mengirim `PAYMENT-SIGNATURE` dalam 60 detik; lewat itu klien SHOULD meminta 402 baru karena `extra.epoch` bisa sudah berganti |
| `extra.circleContract` | Akun kontrak lingkaran |
| `extra.unit` | `"credit"` |
| `extra.decimals` | `6` |
| `extra.epoch` | Epoch berjalan menurut view `get_epoch` kontrak; diisi facilitator (`getExtra`) dan diteruskan ke server lewat `GET /supported` |

Entri `exact` mengikuti `scheme_exact_near.md` tanpa perubahan.

### 3. Payload `PAYMENT-SIGNATURE`

Klien mengulang request dengan `PAYMENT-SIGNATURE` berisi `PaymentPayload` v2. Field `payload` membawa voucher kumulatif per `(payer, payee, epoch)` dan tanda tangan ed25519 payer.

```json
{
  "x402Version": 2,
  "resource": { "url": "https://summarizer.example/api/summarize" },
  "accepted": { "scheme": "batch-settlement", "network": "x207:agents-main", "amount": "20000", "asset": "USD", "payTo": "summarizer.x207-circle.near", "maxTimeoutSeconds": 60, "extra": { "circleContract": "x207-circle.near", "unit": "credit", "decimals": 6, "epoch": 42 } },
  "payload": {
    "voucher": {
      "circle": "x207-circle.near",
      "payer": "translator.x207-circle.near",
      "payee": "summarizer.x207-circle.near",
      "epoch": 42,
      "seq": 137,
      "cumulativeAmount": "2740000",
      "unit": "credit",
      "resource": "https://summarizer.example/api/summarize"
    },
    "signature": "ed25519:<base58>"
  }
}
```

| Field voucher | Aturan |
| --- | --- |
| `circle` | MUST sama dengan `accepted.extra.circleContract` |
| `payer` | Akun anggota pembeli; `pubkey_voucher`-nya di kontrak dipakai untuk verifikasi |
| `payee` | MUST sama dengan `accepted.payTo` |
| `epoch` | MUST sama dengan `accepted.extra.epoch` dan epoch berjalan kontrak |
| `seq` | Integer >= 1, naik monoton per `(payer, payee, epoch)`, mulai 1 di tiap epoch |
| `cumulativeAmount` | String bilangan bulat satuan terkecil: total kewajiban payer ke payee di epoch ini sampai voucher ini |
| `unit` | MUST `"credit"` |
| `resource` | URL resource yang dibayar, ASCII. Informasi audit; tidak menentukan kewajiban |
| `signature` | `ed25519:<base58>` atas byte kanonik voucher; lihat [`voucher-format.md`](./voucher-format.md) |

Voucher dipisah dari `signature` di payload, sama dengan argumen `register_cumulative(voucher, signature)`.

**Kenaikan per voucher.** `increment = voucher.cumulativeAmount - base.cumulativeAmount` MUST sama dengan `requirements.amount`. Nilai `amount` dari server MUST NOT dipercaya sebagai besar kewajiban: kewajiban sebesar yang ditandatangani payer, dan `amount` hanya memastikan payer membayar harga yang diminta.

**Aturan klien.**
- State `(seq, cumulativeAmount)` terakhir disimpan per `(payer, payee, epoch)`. Epoch baru memulai dari `seq 0`, kumulatif `0`.
- State lokal MUST naik hanya setelah `PAYMENT-RESPONSE` dengan `success: true`. Bila request gagal sebelum respons, voucher berikutnya memakai basis yang sama.
- Klien MUST mengirim paling banyak satu voucher belum terkonfirmasi per `(payer, payee)`; request paralel ke penjual yang sama diantrikan.
- Klien MUST memilih entri `x207:*` hanya bila anggota dan perkiraan headroom >= `amount`; selain itu memilih `exact`. Bila tidak ada entri yang bisa dibayar, klien MUST gagal tanpa menandatangani voucher.

### 4. Header `PAYMENT-RESPONSE`

Server mengirim `PAYMENT-RESPONSE` pada 200 setelah `/settle` sukses, dan pada 402 bila `/settle` gagal. Isinya `SettleResponse` facilitator.

```json
{
  "success": true,
  "transaction": "translator.x207-circle.near:summarizer.x207-circle.near:42:137",
  "network": "x207:agents-main",
  "payer": "translator.x207-circle.near",
  "extensions": { "x207": { "epoch": 42, "seq": 137, "cumulativeAmount": "2740000", "registration": "pending" } }
}
```

| Field | Arti |
| --- | --- |
| `transaction` | Commitment id `<payer>:<payee>:<epoch>:<seq>`. Bukan tx hash, karena `/settle` hanya mencatat |
| `extensions.x207.registration` | `pending` (tersimpan di facilitator, belum on-chain), `registered` (voucher dengan `seq` ini atau lebih tinggi sudah on-chain), `retrying` (registrasi pernah gagal dan diulang) |
| `errorReason` | Hanya bila `success: false`; nilai dari tabel di bagian 9 |

Penolakan karena `seq_not_increasing`, `cumulative_decreased`, atau `amount_mismatch` membawa `extensions.x207 { epoch, lastSeq, lastCumulativeAmount }` agar klien bisa menyelaraskan state. Server mengambil nilai itu dari `GET /x207/pair-state` (bagian 8.5) karena `VerifyResponse` tidak membawa `extensions`. Klien MAY menyelaraskan lalu mencoba sekali lagi; penolakan kedua tidak diulang.

`settlement_pending` (non-terminal) hanya muncul di mode demo `register_voucher` per request: bila registrasi belum final dalam timeout facilitator 10 detik, `/settle` menjawab `success: false, errorReason: "settlement_pending"`, resource tetap dilayani, dan facilitator melanjutkan registrasi.

### 5. Perilaku resource server

1. Request tanpa `PAYMENT-SIGNATURE`: balas 402 + `PAYMENT-REQUIRED`.
2. Dengan `PAYMENT-SIGNATURE`: decode base64. Header yang bukan JSON dibalas 402 `invalid_payload` tanpa memanggil facilitator. Selain itu panggil `POST /verify` (timeout 10 detik).
3. `isValid: false`: balas 402 dengan `PAYMENT-REQUIRED` baru yang `error`-nya berisi `invalidReason`. Untuk `insufficient_credit` entri `exact` MUST tetap ada. Untuk tiga kode resinkronisasi di bagian 4, sertakan `PAYMENT-RESPONSE` resinkronisasi.
4. `isValid: true`: jalankan handler. Bila handler gagal (5xx), server MUST NOT memanggil `/settle`, sehingga tidak ada kewajiban; status 5xx diteruskan.
5. Handler sukses: panggil `POST /settle`. `success: true` atau `settlement_pending`: balas 200 + `PAYMENT-RESPONSE`. Gagal lainnya: balas 402 + `PAYMENT-RESPONSE`.
6. Facilitator tidak menjawab dalam 10 detik atau menjawab 5xx: balas 503 dengan `Retry-After: 5`, tanpa melayani resource.

### 6. Headroom, pending, dan registrasi

**Headroom termasuk voucher pending.** Untuk payer `p` di epoch berjalan `e`:

```text
base(p, q)         = pending(p, q, e) bila ada, selain itu registered(p, q, e)
unregistered(p)    = sum_q [ pending(p, q, e).cumulativeAmount - registered(p, q, e).cumulativeAmount ]
computeHeadroom(p) = max(0, headroom(p) - unregistered(p))
syarat             : increment <= computeHeadroom(p)
```

`headroom(p)` adalah view on-chain `max(0, limit - outstanding_debt)`, `"0"` bila anggota tidak `active`. Hanya kenaikan pending di atas kumulatif terdaftar yang dikurangkan, karena kumulatif terdaftar sudah termasuk di `outstanding_debt`.

**Pending store.** Facilitator MUST menyimpan voucher yang diterima di `/settle` secara persisten, satu baris per `(circle, payer, payee, epoch)` dengan `seq` tertinggi. Jumlah U128 disimpan sebagai teks dan dibandingkan sebagai bilangan bulat besar.

**Penjadwal registrasi.** Facilitator mengirim `register_cumulative` per pasangan, bukan per request:

| Aturan | Default |
| --- | --- |
| Pemicu ambang | Kumulatif pending dikurangi terdaftar >= `registerThreshold` (1 credit) |
| Pemicu menjelang cutoff | Pada `cutoff_at - flushLead` (120 detik) semua baris pending epoch itu diregistrasi |
| Batas penerimaan | `/verify` menolak voucher epoch `e` dengan `epoch_closing` sejak `cutoff_at - flushLead` |
| Retry | Kegagalan disimpan lalu diulang dengan backoff 5, 10, 20, 40 detik (maksimum 60) sampai `cutoff_at` |
| Idempotensi | Aman diulang: kontrak menolak `seq` <= `last_seq` tanpa efek. Bila `last_seq >= seq`, facilitator menganggap registrasi sukses |
| Penolakan voucher baru | Selama payer punya registrasi gagal lebih dari satu percobaan (`attempts >= 2`), `/verify` menolak voucher baru payer itu dengan `registration_retry_pending` |
| Gagal sampai cutoff | Dicatat di log; risiko penjual sebatas nilai belum teregistrasi pasangan itu |
| Mode demo | `register_voucher` per request di setiap `/settle`, lewat flag konfigurasi; default tetap `register_cumulative` |

### 7. Urutan verifikasi `/verify`

Facilitator MUST menjalankan 19 cek berikut berurutan dan berhenti di penolakan pertama. `/verify` MUST NOT mengubah state.

| No | Cek | `invalidReason` |
| --- | --- | --- |
| 1 | `x402Version = 2` | `invalid_x402_version` |
| 2 | `accepted.scheme = batch-settlement` dan network terdaftar | `unsupported_scheme` / `invalid_network` |
| 3 | `accepted` sama persis dengan `paymentRequirements` dari server; `amount` string bilangan bulat > 0 | `invalid_payment_requirements` |
| 4 | Payload lolos skema `X207Payload` | `invalid_payload` |
| 5 | `voucher.circle = extra.circleContract =` konfigurasi | `circle_mismatch` |
| 6 | `voucher.payee = accepted.payTo`, `unit = credit`, `resource` ASCII; bila `extra.grantId` ada, `resource` = `x207:grant:<grantId>` | `payee_mismatch` / `grant_resource_mismatch` / `invalid_payload` |
| 7 | `voucher.payer != voucher.payee` | `self_payment` |
| 8 | `voucher.epoch = extra.epoch =` epoch berjalan | `epoch_mismatch` |
| 9 | `now < cutoff_at - flushLead` | `epoch_closing` |
| 10 | Payer terdaftar | `member_not_found` |
| 11 | Status payer `active` | `member_not_active` |
| 12 | Payee terdaftar dan `active` | `payee_not_active` |
| 13 | Payer dan payee tidak sedang keluar | `member_exiting` |
| 13a | Payer dan payee tidak dibekukan (view `is_frozen`, kontrak 0.0.12; dilewati bila facilitator tidak punya view itu). Berlaku juga untuk voucher baru di epoch pembekuan | `account_frozen` |
| 14 | Tanda tangan valid terhadap `pubkey_voucher` payer | `invalid_signature` |
| 15 | Payer tidak terkena aturan `registration_retry_pending` | `registration_retry_pending` |
| 16 | `voucher.seq > base.seq` (on-chain dan pending) | `seq_not_increasing` |
| 17 | `voucher.cumulativeAmount >= base.cumulativeAmount` | `cumulative_decreased` |
| 18 | `increment = requirements.amount` | `amount_mismatch` |
| 19 | `increment <= computeHeadroom(payer)` | `insufficient_credit` |

Kegagalan baca RPC (kedua endpoint gagal atau melewati timeout) bukan `invalidReason`; facilitator menjawab HTTP 503. Antara `cutoff_at` dan `close_epoch`, `get_epoch` tanpa argumen masih mengembalikan epoch yang sama dengan fase `cutoff`, sehingga voucher epoch itu gagal di cek 9.

### 8. Endpoint facilitator

Semua body `application/json`. Endpoint dipanggil resource server, bukan klien.

**8.1 `POST /verify`.** Body `{ x402Version, paymentPayload, paymentRequirements }`. Jawaban `{ "isValid": true, "payer": "..." }` atau `{ "isValid": false, "invalidReason": "...", "payer": "..." }`. Untuk penolakan di cek 1 sampai 4, `payer` boleh tidak ada.

**8.2 `POST /settle`.** Body sama dengan `/verify`. Facilitator menjalankan ulang `verify`; bila sah, menyimpan voucher di pending store (menggantikan `seq` lebih rendah pasangan itu) dan memicu registrasi bila ambang terlewati. Jawaban sukses = `SettleResponse` bagian 4. `/settle` yang diulang dengan payload sama mengembalikan jawaban sukses yang sama tanpa mengubah state. Payload dengan `seq` lebih kecil dari yang tersimpan ditolak `seq_not_increasing`.

**8.3 `GET /supported`.** Daftar `kinds` x207 (dengan `extra` berisi epoch berjalan) dan `exact`, serta `signers` per keluarga CAIP (`x207:*`). Akun signer adalah akun relayer facilitator.

**8.4 Status HTTP.**

| Status | Kapan |
| --- | --- |
| 200 | Hasil bisnis, termasuk `isValid: false` dan `success: false` |
| 400 | Body bukan JSON, field wajib hilang, network tidak lolos regex (`{ "error": "invalid_request" }`) |
| 404 | Rute tidak dikenal |
| 503 | RPC NEAR tidak terjangkau setelah failover atau melewati timeout 10 detik (`chain_unavailable`, dengan `Retry-After`) |
| 500 | Kesalahan internal lain |

**8.5 `GET /x207/pair-state`.** Parameter `network`, `payer`, `payee`, `epoch`. Jawaban `{ network, payer, payee, epoch, lastSeq, lastCumulativeAmount, source }` dengan `source` = `pending` (baris pending store), `onchain` (view `obligation`), atau `none` (`lastSeq 0`, `"0"`). Hanya baca; tidak mengubah state.

### 9. Kode alasan penolakan

| Kode | Arti | Tindakan klien |
| --- | --- | --- |
| `invalid_x402_version` | Versi bukan 2 | Perbarui SDK |
| `unsupported_scheme`, `invalid_network` | Scheme atau network tidak dilayani | Pilih entri lain |
| `invalid_payment_requirements` | `accepted` berbeda dari requirements server | Minta 402 baru |
| `invalid_payload` | Skema payload salah atau `unit` bukan `credit` | Perbaiki klien |
| `circle_mismatch` | `circle` atau `extra.circleContract` tidak cocok dengan konfigurasi | Minta 402 baru |
| `payee_mismatch` | `voucher.payee` != `payTo` | Perbaiki klien |
| `grant_resource_mismatch` | `extra.grantId` ada tetapi `voucher.resource` bukan `x207:grant:<grantId>` (endpoint grant F8, SD-053) | Perbaiki klien |
| `epoch_mismatch` | Epoch voucher bukan epoch berjalan | Minta 402 baru, reset state epoch |
| `epoch_closing` | Sudah di jendela `flushLead` sebelum cutoff | Pakai `exact` atau tunggu epoch berikutnya |
| `member_not_found`, `member_not_active`, `payee_not_active` | Anggota atau penjual tidak terdaftar atau tidak `active` | Pakai `exact` |
| `self_payment` | `payer = payee` | Perbaiki klien |
| `invalid_signature` | Tanda tangan tidak cocok dengan `pubkey_voucher` | Perbaiki kunci |
| `registration_retry_pending` | Voucher payer gagal teregistrasi berulang | Pakai `exact` sampai pulih |
| `seq_not_increasing` | `seq` <= `seq` terakhir (replay) | Selaraskan dengan `lastSeq` |
| `member_exiting` | Payer atau payee sedang keluar | Pakai `exact` atau penjual lain |
| `account_frozen` | Payer atau payee dibekukan oleh DAO (ADR-43) | Pakai penjual lain; pembekuan dicabut hanya oleh DAO |
| `cumulative_decreased` | `cumulativeAmount` turun | Selaraskan state |
| `amount_mismatch` | Kenaikan != harga yang diminta | Selaraskan state, coba sekali lagi |
| `insufficient_credit` | Kenaikan > headroom setelah dikurangi pending | Jatuh ke `exact` `near:mainnet` |
| `settlement_pending` | Non-terminal, hanya mode demo | Tidak ada; resource sudah dilayani |

## Appendix

### 10. Pemenuhan 7 syarat binding `batch-settlement`

| Syarat | Pemenuhan | Penegakan on-chain |
| --- | --- | --- |
| 1. Commitment format | `X207Payload`: voucher kumulatif + signature `ed25519:` di `PAYMENT-SIGNATURE` (bagian 3) | `register_cumulative(voucher, signature)` membaca byte kanonik yang sama |
| 2. Verification rules | 19 cek bagian 7; headroom termasuk pending bagian 6 | Kontrak memverifikasi ulang tanda tangan, status, `seq`, headroom, dan cutoff saat registrasi |
| 3. Storage behavior | Pending store di facilitator; commitment id `<payer>:<payee>:<epoch>:<seq>` | Satu entri state per pasangan per epoch di kontrak |
| 4. Double-spend prevention | `seq_not_increasing`, `cumulative_decreased`, satu voucher belum terkonfirmasi per pasangan | `seq` <= `last_seq` ditolak tanpa efek |
| 5. Commitment expiry | `epoch_mismatch`, `epoch_closing`; voucher tidak sah setelah cutoff; `maxTimeoutSeconds = 60` | `close_epoch` membekukan snapshot; registrasi sesudahnya gagal |
| 6. Redemption | Di luar siklus x402: kliring siklus (`submit_clearing`, `commit_epoch`), net debtor membayar residual ke pool, net creditor `claim` | `submit_clearing`, `commit_epoch`, settle, `finalize_epoch`, `claim` |
| 7. Trust model | Hybrid: facilitator hanya relayer tanpa custody dan tidak bisa memalsukan voucher; jaminan on-chain berupa stake dan dana cadangan; invariant MVP `limit <= stake` | Alokasi kerugian eksplisit: potong stake debtor, dana cadangan, lalu haircut ke kreditor langsung debtor tanpa kaskade |

### 11. Keamanan

**Replay.** Voucher bersifat kumulatif dengan `seq` monoton per `(payer, payee, epoch)`. Mengirim ulang voucher yang sama atau lebih lama ditolak facilitator (`seq_not_increasing`) dan kontrak (registrasi dengan `seq` <= `last_seq` ditolak tanpa efek). Nonce tanda tangan diturunkan dari `payer:payee:epoch:seq`, dan recipient-nya adalah akun kontrak lingkaran, sehingga tanda tangan tidak berlaku di lingkaran, pasangan, epoch, atau urutan lain. Karena voucher kumulatif, voucher terbaru menggantikan semua sebelumnya; tidak ada ID per request yang perlu disimpan.

**Authorization scope.** Kunci voucher (`pubkey_voucher`) adalah kunci ed25519 terpisah dari access key akun NEAR. Ia hanya dapat menandatangani voucher x207 untuk akun itu; tidak dapat memindahkan aset akun, memanggil kontrak lain, atau menandatangani transaksi NEAR. Bocornya kunci voucher berarti penyerang bisa membuat kewajiban atas nama payer sampai sebesar `limit`, tidak lebih, dan sebatas stake yang dikunci (`limit <= stake`). Pemilik MUST memperlakukan kunci ini sebagai rahasia. Tanda tangan mengikat `circle`, `payer`, `payee`, `epoch`, `seq`, `cumulativeAmount`, `unit`, dan `resource`; mengubah satu field membatalkannya.

**Settlement atomicity.** `/settle` mencatat voucher di pending store dan tidak mengirim transaksi on-chain; registrasi menyusul secara batch. Karena itu tidak ada atomisitas antara jawaban `/settle` dan kepastian on-chain. Risikonya dibatasi: (1) `/verify` mengurangkan voucher pending dari headroom sehingga payer tidak bisa menjanjikan lebih dari `limit`; (2) kegagalan registrasi diulang dengan backoff dan voucher baru payer ditolak setelah lebih dari satu percobaan gagal; (3) bila tetap gagal sampai cutoff, penjual menanggung paling banyak nilai yang belum teregistrasi untuk pasangan itu. Server MUST NOT memanggil `/settle` bila handler gagal, sehingga pembayaran hanya dicatat untuk resource yang dilayani.

**Facilitator relayer tanpa custody.** Facilitator tidak memegang dana dan tidak memegang kunci voucher mana pun. Ia hanya meneruskan voucher bertanda tangan payer ke kontrak dan membayar gas dengan akun relayer-nya. Facilitator tidak dapat memalsukan voucher (ADR-06), dan kontrak menolak voucher yang tanda tangannya tidak cocok dengan `pubkey_voucher` anggota. Facilitator yang jahat atau mati hanya dapat menunda registrasi atau menolak melayani; voucher yang telah ditandatangani payer dapat diregistrasi oleh pihak lain yang memegangnya sebelum cutoff.

**Persetujuan kliring saat `join`.** Kliring x207 hanya memakai siklus utang. Penghapusan satu siklus mengurangi utang dan piutang anggota dalam jumlah sama, sehingga posisi bersih dan lawan transaksi tiap anggota tidak berubah. Karena itu persetujuan atas kliring diberikan sekali, saat anggota memanggil `join(circle_id, pubkey_voucher, terms_hash)`: `terms_hash` mengikat anggota pada syarat lingkaran, termasuk kliring siklus oleh solver mana pun. Anggota tidak menandatangani tiap ronde kliring. Kontrak memverifikasi proposal kliring secara on-chain (tiap anggota seimbang dan jumlah yang dikliring tidak melebihi kewajiban, `ERR_UNBALANCED_MEMBER` dan `ERR_CLEARED_EXCEEDS_OBLIGATION`) sebelum diterapkan di `commit_epoch`.

**Keamanan input.** Implementasi MUST menolak, bukan menormalisasi, `cumulativeAmount` dengan nol di depan atau di atas U128, `resource` non-ASCII, `unit` selain `credit`, serta `epoch` atau `seq` yang bukan integer >= 1. Perbandingan jumlah MUST memakai bilangan bulat besar, bukan floating point.

### 12. Test vector

Berkas di [`test-vectors/`](./test-vectors/) adalah sumber tunggal yang dibaca CI TypeScript (`@x207/core`, `@x207/scheme`) dan CI Rust kontrak `x207-circle`. Hanya JSON standar: jumlah sebagai string desimal, byte sebagai hex, kunci sebagai `ed25519:<base58>`.

| Berkas | Isi |
| --- | --- |
| `keys.json` | Seed ed25519 dan kunci publik uji (`kA`, `kB`, `kC`, `kD`, `kOther`, `kZ`) |
| `voucher/valid.json` | Voucher sah: byte kanonik, nonce, hash, tanda tangan |
| `voucher/tampered_<field>.json` | Satu berkas per field voucher yang diubah; verifikasi MUST gagal |
| `voucher/bad_signature.json` | Tanda tangan rusak (`invalid_signature` / `ERR_BAD_SIGNATURE`) |
| `voucher/seq_stale.json`, `voucher/seq_backwards.json` | Replay dan `seq` mundur (`seq_not_increasing` / `ERR_SEQ_NOT_INCREASING`) |
| `voucher/past_cutoff.json` | Voucher setelah cutoff (`epoch_closing` / `ERR_PAST_CUTOFF`) |
| `payload/payment_signature_agents_main.json` | `PaymentPayload` dan nilai header `PAYMENT-SIGNATURE` |
| `payload/client_seq1_seq2.json` | Dua payload klien berurutan (`seq 1` dan `seq 2`) beserta header |
| `clearing/*.json` | Kasus kliring: sah, kliring melebihi kewajiban, anggota tak seimbang |
| `constants.json` | `CREDIT_DECIMALS`, `CREDIT_UNIT`, akun kontrak eksternal, RPC dan endpoint layanan |

### 13. Implementasi referensi

`@x207/core` (tipe, validator, `signVoucher`, `verifyVoucher`), `@x207/scheme` (peran klien, server, facilitator), dan `apps/facilitator` (Hono) di repo `sdk`. Kontrak `x207-circle` ada di repo `contracts`.
