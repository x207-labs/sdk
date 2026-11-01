# Jaminan pembayaran untuk penjual

Penjual menerima voucher yang belum tentu sudah ada di rantai saat respons dikirim. Empat hal berikut menjaga agar risikonya kecil dan terbatas.

1. **Verifikasi facilitator sebelum handler.** `/verify` menjalankan 19 cek berurutan (tanda tangan voucher, anggota `active`, epoch dan `cutoff`, kenaikan `seq` dan kumulatif, headroom termasuk voucher yang belum teregistrasi) dan berhenti di penolakan pertama. Middleware hanya memanggil handler bila `isValid` bernilai `true`, dan hanya memanggil `/settle` bila handler sukses (status < 400).
2. **Registrasi sebelum `cutoff`.** Facilitator menyimpan voucher terbaru tiap pasangan lalu mengirim `register_cumulative` saat selisih kumulatif melewati ambang (default 1 credit) dan pada `cutoff_at − 120 detik`. Kegagalan diulang dengan jeda 5, 10, 20, 40, lalu 60 detik sampai `cutoff_at`. Voucher baru dari payer yang registrasinya gagal dua kali ditolak (`registration_retry_pending`).
3. **Invariant MVP `limit ≤ stake`.** Limit kredit tiap anggota tidak pernah melebihi stake-nya, jadi kewajiban yang terdaftar selalu punya jaminan. Residual yang tidak dibayar dipotong dari stake saat `finalize_epoch`.
4. **Risiko sebatas jeda registrasi.** Yang belum dijamin kontrak hanya selisih `cumulative_amount − registered_cumulative` per pasangan: voucher yang diterima tetapi belum (atau gagal) teregistrasi. Selisih itu dicatat di log facilitator bila registrasi tetap gagal sampai `cutoff` (baris `failed`).

Dasar keputusan: ADR-17 (registrasi kumulatif dan ambang) dan ADR-18 (jaminan stake) di catatan desain `x207 - Keputusan Desain`; ADR-23 untuk retry dan penolakan voucher baru.
