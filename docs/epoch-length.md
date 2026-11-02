# `epoch_length` dan waktu tunggu pembayaran (untuk penjual)

`epoch_length` adalah parameter lingkaran yang dipegang DAO pemilik kontrak, bukan konstanta kode. Default demo 3600 detik (1 jam, ADR-25); rentang yang diterima kontrak 300 sampai 604800 detik (5 menit sampai 7 hari). Parameter terkait: `proposal_window` (default 600 detik) dan `payment_window` (default 1800 detik, minimal 900).

## Cara mengubahnya

Hanya akun `owner` (Sputnik DAO lingkaran) yang boleh memanggil `set_params`. Alurnya: proposal `set_params` dibuat dan disetujui di DAO, lalu kontrak menyimpan nilai baru sebagai params *pending* yang berlaku mulai epoch berikutnya (diterapkan saat `close_epoch` epoch berjalan). Nilai di luar rentang ditolak `ERR_PARAM_OUT_OF_RANGE: <field>`. View `get_pending_params` menunjukkan nilai yang menunggu dan `effective_epoch`-nya, dan event `params_updated` mencatat perubahan. Dasbor menampilkannya di halaman Tata kelola.

## Kompromi untuk penjual

| Epoch lebih pendek | Epoch lebih panjang |
| --- | --- |
| Utang terhapus dan posisi bersih jatuh tempo lebih cepat, jadi risiko penjual menggantung lebih singkat | Lebih sedikit transaksi kliring dan registrasi per hari |
| Lebih banyak transaksi `close_epoch`, `submit_clearing`, `commit_epoch` per hari | Penjual menunggu lebih lama sampai pembayaran tunai atas posisi bersihnya jatuh tempo |
| Graf per epoch lebih kecil, jadi lebih sedikit siklus yang bisa dihapus | Graf lebih besar memberi lebih banyak peluang siklus (kepadatan, ADR-16) |

Waktu tunggu terburuk penjual untuk menerima uang tunai dari posisi bersih adalah sisa epoch ditambah `proposal_window` ditambah `payment_window` setelah `cutoff_at`.

## Apa yang dihitung "sudah dibayar"

Nilai yang terhapus kliring sudah terbayar lewat **pengurangan utang**: utang melingkar saling meniadakan, sehingga tidak ada pembayaran tunai untuk bagian itu. Hanya posisi bersih yang menjadi pembayaran tunai (USDT) di jendela pembayaran. Penjual yang menerima voucher dari pembeli yang kelak terhapus kliring tidak perlu menunggu tunai untuk bagian yang terhapus.
