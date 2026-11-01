# Keamanan kunci voucher

Berlaku untuk `@x207/core` (SD-037, ADR-06).

## Apa kunci ini

Kunci voucher adalah keypair ed25519 yang dipakai agent untuk menandatangani voucher kumulatif off-chain. Kunci publiknya didaftarkan sebagai `pubkey_voucher` saat `join` (D1). Kontrak `x207-circle` memverifikasi tanda tangan voucher terhadap kunci itu.

**Kunci ini bukan access key NEAR.** Ia tidak terdaftar di akun NEAR mana pun, tidak bisa menandatangani transaksi, dan tidak bisa memindahkan token atau NEAR dari akun agent. Satu-satunya yang bisa ditandatanganinya adalah voucher x207 (byte kanonik di [`spec/voucher-format.md`](../spec/voucher-format.md)), dan voucher hanya berlaku bila anggota `active` punya headroom.

## Membuat kunci

```ts
import { generateVoucherKeypair } from "@x207/core";

const { secretKey, publicKey } = generateVoucherKeypair();
// secretKey: "ed25519:<base58 64 byte>"  -> simpan rahasia (env atau secret manager)
// publicKey: "ed25519:<base58 32 byte>"  -> dikirim ke join() sebagai pubkey_voucher
```

`generateVoucherKeypair` memakai pembangkit acak sistem. Buat kunci baru khusus voucher; jangan memakai ulang seed access key akun NEAR (kontrak menerima kunci yang sama dengan access key, tetapi itu melemahkan pemisahan ini, ADR-32 K-23).

## Bila kunci bocor

Penyerang yang memegang kunci voucher bisa menandatangani voucher atas nama agent, sampai headroom agent habis. Dampaknya:

- **Bisa:** membuat voucher payer = agent ke payee mana pun yang `active`. Tiap voucher menambah kewajiban agent. Total kerugian dibatasi `limit` agent, dan di MVP `limit ≤ stake` (ADR-18), jadi kerugian maksimum sebesar stake yang sudah dikunci.
- **Tidak bisa:** memindahkan aset di akun NEAR agent, menandatangani transaksi NEAR, menarik stake (`withdraw_stake` dipanggil dari akun NEAR, bukan dengan kunci voucher), atau mengubah anggota lain.

Langkah bila curiga bocor: panggil `request_exit` dari akun NEAR agent. Sejak `exit_requested_epoch` terisi, facilitator menolak voucher baru dari agent itu (`member_exiting`, ADR-29). Voucher yang sudah diterima sebelumnya tetap menjadi kewajiban. Spec antarmuka `0.0.1` belum punya method rotasi kunci.

## Praktik

- Simpan `secretKey` hanya di `.env` atau secret manager; jangan di-commit.
- Satu kunci per agent; jangan dibagi antar agent.
- Batasi `limit` lewat stake sesuai yang siap hilang bila kunci bocor.
