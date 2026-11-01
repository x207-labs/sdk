# x207 SDK

SDK publik x207: binding x402 `batch-settlement` model *credit-backed* di network `x207:<circleId>`, plus facilitator referensi dan test vector. Bagian dari [`x207-labs/x207`](https://github.com/x207-labs/x207). Modul M2 dan M3, fitur F2, F4, F5.

| Folder | Paket | Modul | Fitur | Isi |
| --- | --- | --- | --- | --- |
| `packages/core/` | `@x207/core` | M2, M3 (pustaka bersama) | F2, F4, F5 | Tipe voucher, tanda tangan, client kontrak `x207-circle`, parser event NEP-297 |
| `packages/scheme/` | `@x207/scheme` | M2 | F2, F5 | Binding x402 per peran: `client/`, `server/`, `facilitator/` |
| `apps/facilitator/` | `@x207/facilitator` | M3 | F2 (F4 opsional) | Facilitator referensi: `/verify`, `/settle`, `/supported` |
| `spec/` | — | M2 | F2 | `scheme_batch_settlement_x207.md` dan `test-vectors/`, sumber tunggal format voucher untuk CI TypeScript dan Rust |

Kontrak yang dirujuk: `x207-circle` (M1). Penyimpanan yang disentuh: D1, D2, D3 (pending store facilitator), D7.

## Pengembangan

Butuh Node ≥ 22.22.2 dan npm 11. Semua dependency dipin exact.

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
```

Konfigurasi facilitator disalin dari `.env.example` ke `.env`. Rahasia hanya di `.env`, yang tidak di-commit.

## Quickstart pembuat agent (pembeli)

Paket `@x207/*` belum di-publish; langkah di bawah memakai clone repo ini (`npm install` memasang workspace). Syarat: akun NEAR agent dengan USDT, dan lingkaran x207 yang sudah berjalan (alamat kontrak `x207-circle`, `circleId`, dan hash syarat lingkaran dari operatornya).

1. **Instal dan bangun.** `npm install`, lalu `npm run build`.
2. **Kunci voucher.** Agent memakai satu kunci ed25519 khusus voucher. Kunci ini bukan access key NEAR dan tidak bisa memindahkan aset; baca dampak bila bocor di [Keamanan kunci voucher](docs/voucher-key-security.md).
3. **Onboarding (join + stake).** `onboardMember` membuat kunci voucher, mengirim `join`, mengirim stake lewat `ft_transfer_call`, dan menunggu status `active`. Transaksinya ditandatangani access key pemilik akun:

   ```ts
   import { onboardMember, createCircleViewFn } from "@x207/core";
   import { createNearSender } from "@x207/core/signer";

   const view = createCircleViewFn({ circleContract: "x207-circle.near" });
   const { secretKey, member } = await onboardMember(
     { sendCall: createNearSender({ rpcUrl, accountId: "agent.near", secretKey: ownerAccessKey }), view },
     { circleContract: "x207-circle.near", circleId: "agents-main", accountId: "agent.near", termsHash, stakeAmount: "50000000" },
   );
   // simpan `secretKey` (kunci voucher) di tempat rahasia; member.status === "active"
   ```

4. **Daftarkan `x207:*` dan panggil.** Satu wrapper `@x402/fetch`; `X207PaymentClient` sudah mendaftarkan `x207:*` dan jatuh ke entri `exact` bila headroom habis:

   ```ts
   import { wrapFetchWithPayment } from "@x402/fetch";
   import { X207PaymentClient, headroomFromRpc } from "@x207/scheme";

   const client = new X207PaymentClient({ payer: "agent.near", secretKey, headroom: headroomFromRpc({}) });
   const paidFetch = wrapFetchWithPayment(fetch, client);
   const response = await paidFetch("https://seller.example/api/summarize");
   ```

5. **Baca hasilnya.** Respons 200 membawa header `PAYMENT-RESPONSE` (base64 JSON): `transaction` berisi commitment id `<payer>:<payee>:<epoch>:<seq>` dan `extensions.x207.registration` berisi `pending`, `retrying`, atau `registered`.

Contoh lengkap yang diuji: [`examples/buyer`](examples/buyer). Dijalankan terhadap near-sandbox lewat `npm run test:sandbox`.

## Quickstart penjual

1. **Pasang middleware.** `x207Middleware` memakai `Request`/`Response` web standar, jadi cocok di Hono, Express (adapter), atau fetch handler apa pun:

   ```ts
   import { x207Middleware } from "@x207/scheme";

   const paywall = x207Middleware({
     routes: { "/api/summarize": { price: "$0.02", description: "Ringkas teks" } },
     facilitatorUrl: process.env.FACILITATOR_URL!,
     circleId: "agents-main",
     payTo: "summarizer.agents.near",
   });
   // response = await paywall(request, (req) => handler(req))
   ```

2. **Arahkan ke facilitator.** Jalankan facilitator referensi (`apps/facilitator`, variabel di `.env.example`: `X207_CIRCLES`, `X207_RELAYER_ACCOUNT_ID`, `X207_RELAYER_PRIVATE_KEY`, `NEAR_RPC_URLS`) dan isi `FACILITATOR_URL` di penjual. `GET /supported` memuat `batch-settlement` di `x207:<circleId>` dan `exact` di `near:mainnet`; 402 penjual mengiklankan keduanya, sehingga anggota membayar dengan voucher dan non-anggota dengan `exact`.
3. **Cek saldo klaim.** Piutang penjual terlihat di read API indexer: `GET /x207/circles/{circleId}/members/{akun}/settlements` (posisi `claimable` setelah `finalize_epoch`). Klaim dengan `claim(epoch, "near" | "intents")` dari dashboard.

Contoh yang diuji: [`examples/seller`](examples/seller).

## Lisensi

Apache-2.0
