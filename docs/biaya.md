# Biaya: kapan ada transaksi on-chain

Membayar dengan voucher x207 tidak mengirim transaksi NEAR per panggilan. Ringkasannya:

| Kejadian | Transaksi on-chain? | Siapa yang membayar gas |
| --- | --- | --- |
| Agent membayar satu panggilan x402 (voucher baru) | Tidak. Voucher ditandatangani di klien dan diperiksa facilitator | Tidak ada |
| `/settle` menyimpan voucher | Tidak. Facilitator menyimpan voucher terbaru tiap pasangan di pending store D3 | Tidak ada |
| Registrasi `register_cumulative` | Ya, **satu per pasangan (payer, payee) per epoch**, bukan per panggilan | Akun relayer facilitator |
| `join` dan stake | Ya, sekali per anggota | Agent |
| `close_epoch`, `submit_clearing`, `commit_epoch` | Ya, satu per epoch untuk seluruh lingkaran | Keeper dan solver |
| Pelunasan residual dan `claim` | Ya, hanya untuk posisi bersih | Pihak yang bersangkutan |

## Voucher kumulatif

Tiap voucher memuat `cumulativeAmount` untuk pasangan dan epoch itu dan `seq` yang selalu naik. Voucher yang lebih baru menggantikan yang lama, jadi kontrak hanya perlu voucher terakhir. 300 panggilan antara dua agent dalam satu epoch menjadi satu registrasi, bukan 300 transaksi.

Facilitator mendaftarkan sebuah pasangan bila selisih antara kumulatif terbaru dan yang sudah terdaftar melewati ambang (default 1 credit, `registerThreshold`) dan, apa pun nilainya, 120 detik sebelum `cutoff_at`. Kegagalan diulang dengan jeda 5, 10, 20, 40, lalu 60 detik sampai `cutoff_at`.

## Angka dari repositori ini

Sandbox `npm run demo:sandbox` (dari akar payung) menjalankan 120 panggilan berbayar antara enam agent pada kepadatan `medium` dan mencatat 12 registrasi. Hasil itu tercatat di README payung bagian 4; angkanya bergantung pada kepadatan graf (siapa membeli dari siapa), jadi bukan konstanta.

## Biaya gas

Satu function call NEAR memakai sekitar 10 sampai 30 TGas, yang pada saat keputusan ADR-17 dihitung sekitar 0,004 sampai 0,013 dolar. Angka ini perkiraan dari catatan desain, bukan hasil ukur kami di mainnet; ukur ulang sebelum dipakai untuk menghitung anggaran.

## Mengapa begini

Keputusannya ADR-17 di catatan desain `x207 - Keputusan Desain`: registrasi per panggilan membuat biaya gas melebihi harga panggilan murah, sehingga x207 meniru pola `batch-settlement` x402 di EVM dengan voucher kumulatif. Risiko penjual hanya selisih registrasi yang belum terdaftar (lihat [Jaminan pembayaran untuk penjual](seller-guarantees.md)). Registrasi per panggilan (ADR-07) tetap ada sebagai mode demo.
