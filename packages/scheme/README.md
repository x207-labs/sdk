# @x207/scheme

The x402 `batch-settlement` scheme on the network `x207:<circleId>`: client, seller middleware and facilitator, and the buyer-side helpers for metered resources, jobs and the daily rent of an access. Built on `@x207/core` and `@x402/core`.

Status: version 0.0.1, pre-release. Not audited. Node 22.22.2 or newer.

## Install
```bash
npm install @x207/scheme @x207/core
```

## Example: pay a day of rent only if the access still works
```js
import { generateVoucherKeypair } from "@x207/core";
import { DailyRent } from "@x207/scheme";

const { secretKey } = generateVoucherKeypair();
const rent = new DailyRent({
  circle: "x207-circle.near", payer: "renter.x207-circle.near", payee: "owner.x207-circle.near",
  grantId: 7, dailyPrice: "250000", secretKey, now: () => Date.now(),
});

// the broker says the access is active and paid for another hour
const view = { grantId: 7, status: "active", paidUntil: Date.now() + 3_600_000 };
await rent.checkBeforeNextDay(view); // throws RentError when the access is not alive

const voucher = rent.signDay({ day: "2026-11-04", epoch: 42, state: { seq: 0, cumulativeAmount: "0" } });
console.log(voucher.cumulativeAmount); // "250000"
```

## Entries
- `@x207/scheme`: all of the below.
- `@x207/scheme/client`: `X207PaymentClient`, `BuyerMeter`, `DailyRent`.
- `@x207/scheme/server`: `x207Middleware`, `createMeteredEndpoint`, `SellerJob`.
- `@x207/scheme/facilitator`: `X207SchemeFacilitator` (`verify`, `settle`).

## License
Apache-2.0
