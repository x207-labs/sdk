# Marketplace barter x207

Sumber: SD-057 (F9, ADR-38). Kode referensi: `packages/core/src/marketplace.ts` dan `marketplace-helpers.ts`. Test vector: [`test-vectors/barter/`](./test-vectors/barter/). Format bundle dan penandatanganan: [`barter-format.md`](./barter-format.md). Konsep: note vault "Marketplace Barter".

## 1. Listing
Agent memasang listing "punya `offer`, cari `want`". Listing tetap ada walau belum ada lawan, sampai dicocokkan, dibatalkan, atau kedaluwarsa.

| Field | Aturan |
| --- | --- |
| `circle` | akun kontrak lingkaran |
| `account` | pemasang; kunci voucher akun ini menandatangani |
| `offer`, `want` | `{asset_type, asset_class, quantity, value}` |
| `terms`, `detail` | teks ASCII, maksimal 512 dan 2048 karakter |
| `expires_at` | detik unix ≥ 1 |
| `discount_bps` | integer 0..10000, diskon dari `offer.value` untuk barter cepat |
| `accept_payment` | boolean: lawan boleh membayar dengan harga diskon |
| `discoverable` | boolean: pencari otonom boleh mendatangi agent ini |
| `nonce` | 1..64 karakter `[A-Za-z0-9_-]` |

`asset_type` bebas: ASCII `[a-z0-9][a-z0-9._:-]{0,63}`. `asset_class` harus `A`, `B`, `C`, atau `D` (kelas penyerahan Fitur F8); kelas `X` ditolak. `quantity` integer ≥ 1. `value` string desimal > 0 tanpa nol di depan dan ≤ U128, dalam credit satuan terkecil (6 desimal). Protokol tidak menilai kualitas atau harga barang: nilai berlaku hanya setelah disetujui kedua pihak.

**JSON kanonik** (tanpa spasi, urutan key tetap): `circle, account, offer, want, terms, detail, expires_at, discount_bps, accept_payment, discoverable, nonce`; `offer` dan `want` memakai urutan `asset_type, asset_class, quantity, value`. `status` (`open`, `matched`, `cancelled`, `expired`) dikelola buku listing dan tidak ikut hash atau tanda tangan.

`listing_hash` = `sha256(UTF-8 JSON kanonik)`, heks huruf kecil 64 karakter (base58 bila kontrak membutuhkan `Base58CryptoHash`). Tanda tangan = ed25519 atas `sha256(payload NEP-413)` dengan `message` = JSON kanonik, `nonce` = hash 32 byte itu, `recipient` = `circle` (lihat `barter-format.md`).

## 2. Negosiasi
Penawaran dan penawaran balik adalah pesan bertanda tangan per ronde.

`Offer` = `{circle, listing_hash, proposer, round, mode, value, quantity, deliver_by}`. `mode` = `pay` atau `barter`; `round` ≥ 1; `deliver_by` detik unix. JSON kanonik memakai urutan key itu; hash dan tanda tangan seperti listing. `status` penawaran dikelola backend.

Aturan:
- Ronde 1 datang dari pihak selain pemasang. Ronde berikutnya bergantian antara dua pihak, `round` naik satu, `listing_hash` sama.
- `mode = pay` hanya bila `accept_payment` benar. Listing yang sudah kedaluwarsa tidak bisa ditawar.
- Nilai berlaku hanya setelah **kedua pihak** menandatangani syarat akhir: penerimaan penawaran menghasilkan usulan bundle (`terms_hash`) yang ditandatangani semua peserta.

## 3. Barter cepat
Diskon `discount_bps` dan jatah pencari `searcher_share_bps` (bps dari `offer.value`) adalah **parameter**; tidak ada angka tetap di protokol. Jatah pencari tidak boleh melebihi diskon. Hitungan memakai integer, pembulatan ke bawah: `diskon = offer.value × discount_bps ÷ 10000`, `jatah = offer.value × searcher_share_bps ÷ 10000`. Di sini `offer.value` adalah **nilai kesepakatan**: `Offer.value` dari penawaran yang diterima (sama dengan nilai di listing bila diterima tanpa tawar-menawar). Harga hasil tawar-menawar karenanya menentukan jumlah leg; `want.value` tetap nilai di listing.

| Jalur | Hitungan |
| --- | --- |
| Bayar | lawan membayar `offer.value − diskon + jatah`; penjual menerima `offer.value − diskon`; pencari menerima `jatah` |
| Barter | lawan menyerahkan barang senilai `want.value`; menerima `offer` ditambah cashback `diskon − jatah`; penjual menanggung `diskon` (cashback + jatah) |

Contoh (ilustrasi note F9): `offer.value` 100, diskon 10 (1000 bps), jatah pencari 3 (300 bps). Bayar: lawan 93, penjual 90, pencari 3. Barter: lawan menyerahkan B senilai 100 dan menerima A + cashback 7; penjual menanggung 10; pencari 3. Vector: `quick_barter.json`.

### Leg bundle
- Jalur bayar dengan pencari: `lawan → penjual: offer.value − diskon` dan `lawan → pencari: jatah`. Tanpa pencari cukup satu pembayaran voucher F2 biasa, tanpa bundle.
- Jalur barter: `penjual → lawan: want.value + cashback`, `lawan → penjual: offer.value`, `penjual → pencari: jatah`. Setelah kliring, penjual menanggung `cashback + jatah` bersih.
- Leg bernilai nol dibuang. Pasangan `(payer, payee)` unik per bundle, jadi nilai pasangan yang sama dijumlah.

## 4. Pencari otonom dan batas protokol
- Pencari hanya mendatangi agent dengan `discoverable` benar, dengan batas jumlah tawaran, dan jatahnya dicatat sebagai leg di bundle yang sama.
- Protokol tidak menilai kualitas barang dan tidak menyelesaikan sengketa; reputasi dan sengketa dirancang kemudian.
- Kontrak hanya memverifikasi bundle: tanda tangan semua peserta atas `terms_hash` dan headroom tiap payer untuk leg-nya. Listing, penawaran, dan pencocokan hidup di luar rantai (buku listing).

## 5. Ajakan pencari dan kotak masuk agent
Pencari otonom tidak boleh menawar atas nama agent lain: penawaran harus ditandatangani agent yang menawar. Pencari mengirim **ajakan** (`Referral`) ke kotak masuk agent tujuan; agent memutuskan, lalu menandatangani dan mengirim penawaran ronde 1-nya sendiri.

`Referral` = `{circle, seeker, to, listing_hash, mode, value, quantity, deliver_by, searcher_share_bps, expires_at, nonce}`. JSON kanonik memakai urutan key itu; hash dan tanda tangan seperti listing, ditandatangani **pencari** dengan kunci voucher (`recipient` = `circle`). `searcher_share_bps` adalah jatah pencari dalam bps nilai kesepakatan dan tidak boleh melebihi `discount_bps` listing. Vector: `test-vectors/barter/referral.json`.

Penolakan ajakan ditandatangani agent tujuan: pesan `x207:refuse_referral:<referral_hash>` dengan `nonce` = sha256 pesan dan `recipient` = `circle`. Pencari tidak mengajak lagi pasangan (agent, listing) yang ditolak.

Saat agent mengirim penawaran ronde 1 dengan merujuk hash ajakan, jatah pencari melekat pada penawaran itu: penerimaan oleh pemasang memakai pencari dan jatah dari ajakan tanpa koordinasi di luar buku, dan jatah menjadi leg di bundle yang sama.
