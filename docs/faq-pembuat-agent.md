# FAQ pembuat agent

## Berapa modal yang terkunci?

Anggota mengunci **stake** USDT di kontrak lingkaran. Pada versi hackathon limit kredit tidak melebihi stake (`limit ≤ stake`), dan limit awal adalah rasio dari stake (parameter `base_limit_ratio`, default 80%). Contoh: stake 50 USDT memberi limit 40 credit pada awalnya. Limit dapat naik dari riwayat pelunasan tunai (`limit_growth`, dibatasi `limit_cap`) dan turun bila ada gagal bayar. Stake bukan biaya: bisa ditarik lewat `request_exit` dan `withdraw_stake` setelah utang Anda nol dan epoch keluar `finalized`. Residual yang tidak dibayar dipotong dari stake saat `finalize_epoch`.

## Apa yang terjadi saat headroom habis?

`headroom` = limit dikurangi utang berjalan (termasuk voucher yang sudah diterima facilitator tetapi belum terdaftar). Bila voucher berikutnya melebihi headroom, facilitator menolaknya dengan `insufficient_credit`. Klien `X207PaymentClient` menangkap penolakan itu dan jatuh ke entri `exact` pada `accepts` yang sama bila agent mendaftarkannya; tanpa entri `exact`, panggilan gagal dengan `NoPayableRequirementsError`. Headroom pulih setelah kliring epoch menghapus utang melingkar dan setelah Anda melunasi posisi bersih. Anda juga bisa menambah stake. Untuk membatasi belanja agent lebih rendah dari limit on-chain, pasang `spendLimit` (SD-020) atau kebijakan belanja pemilik di `createAgentBuyer`.

## Apakah ini kompatibel dengan x402 biasa?

Ya, sebagai tambahan. Penjual tetap menjawab `402` dengan `PAYMENT-REQUIRED`; `x207Middleware` menambahkan entri `batch-settlement` pada network `x207:<circleId>` di samping entri lain seperti `exact`. Pembeli tetap memakai `@x402/fetch`; klien x207 hanya dipilih bila headroom cukup. Pembeli x402 biasa yang bukan anggota tetap bisa membayar lewat `exact`. Detail dan batasnya ada di README payung bagian "x207 as an evolution of x402".

## Apa risikonya bagi saya sebagai penjual?

Lihat [Jaminan pembayaran untuk penjual](seller-guarantees.md): risiko sebatas voucher yang diterima tetapi belum terdaftar, dan stake pembeli menjadi jaminan sisanya.

## Kunci apa yang saya pegang?

Kunci voucher ed25519 yang terpisah dari access key NEAR. Dampak bila bocor ada di [Keamanan kunci voucher](voucher-key-security.md).
