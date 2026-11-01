# x207 SDK

SDK publik x207: binding x402 `batch-settlement` model *credit-backed* di network `x207:<circleId>`, plus facilitator referensi dan test vector. Bagian dari [`x207-protocol/x207`](https://github.com/x207-protocol/x207).

| Folder | Paket | Modul | Fitur | Isi |
| --- | --- | --- | --- | --- |
| `packages/core/` | `@x207/core` | M2 | F1, F2, F4, F5 | Tipe voucher, tanda tangan, client kontrak `x207-circle`, parser event NEP-297 |
| `packages/scheme/` | `@x207/scheme` | M2 | F2, F5 | Binding x402 per peran: `client/`, `server/`, `facilitator/` |
| `apps/facilitator/` | `@x207/facilitator` | M3 | F2, F4 | Facilitator referensi: `/verify`, `/settle`, `/supported` |
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

## Lisensi

Apache-2.0
