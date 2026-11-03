# @x207/core

Core of x207, the mutual credit settlement layer for x402 agent payments on NEAR: signed credit vouchers, the client of the `x207-circle` contract, the parser of its NEP-297 events, and the formats of barter bundles, invoices, service orders, content licenses and access rent.

Status: version 0.0.1, pre-release. Not audited (our own reviews are in `docs/security.md` of the repository). Node 22.22.2 or newer.

## Install
```bash
npm install @x207/core
```

## Example: sign and verify a voucher
```js
import { generateVoucherKeypair, signVoucher, verifyVoucher } from "@x207/core";

const { publicKey, secretKey } = generateVoucherKeypair();
const voucher = signVoucher(
  {
    circle: "x207-circle.near", payer: "a.x207-circle.near", payee: "b.x207-circle.near",
    epoch: 42, seq: 1, cumulativeAmount: "20000", unit: "credit", resource: "https://seller.example/api",
  },
  secretKey,
);
console.log(verifyVoucher(voucher, publicKey)); // true
console.log(verifyVoucher({ ...voucher, cumulativeAmount: "99999" }, publicKey)); // false
```
A voucher is cumulative per `(payer, payee, epoch)`: `seq` rises and `cumulativeAmount` never goes down. The voucher key is not a NEAR access key.

## Entries
- `@x207/core`: everything above, plus `ContractAbi` (types generated from `abi.json` of the contract, interface 0.0.12).
- `@x207/core/signer`: signing with a key held by the caller.

## License
Apache-2.0
