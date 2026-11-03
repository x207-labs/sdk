# Metered endpoint (SD-064, pipeline P5, class D)

A resource that is paid per unit of use (CPU, GPU, storage, a feed, a relay, a home device) is an x402 endpoint. `createMeteredEndpoint` gives it the price per unit, the ceiling per request, the listing detail and the warnings of its kind from one line of configuration. The contract is not changed: the units live in the SDK, the listing and the voucher.

```ts
import { createMeteredEndpoint } from "@x207/scheme";

const gpu = createMeteredEndpoint({
  kind: "gpu",                 // one of the twelve kinds below
  unitPrice: "$0.50",          // credit for one unit (default unit of the kind: minute)
  handler: async (request, { unit, quantity }) => new Response(await run(quantity)),
});

const serve = gpu.mount("/api/gpu", { facilitatorUrl, circleId, payTo });   // (request) => Response
const detail = gpu.listingDetail("https://gpu.example.com/api/gpu");        // Listing.detail for BE-050
```

The buyer asks `?quantity=30`; the 402 announces `extra.meter = {unit, quantity, unit_price, max_quantity}`; the handler runs only after a valid voucher for `unit_price × quantity`. A request above the ceiling is refused 413 before any 402. A long job is paid in steps with `MeteredJob` (SD-063).

| kind | asset type | no. | units (first is default) |
| --- | --- | --- | --- |
| `cpu` | `compute:cpu-idle` | 31 | minute, job |
| `gpu` | `compute:gpu-hours` | 32 | minute, job |
| `storage` | `storage:capacity` | 33 | GB, day |
| `cdn` | `cdn:static-cache` | 34 | GB, request |
| `inference` | `model:inference` | 35 | request, call |
| `fine-tuning` | `model:fine-tuning` | 36 | job |
| `data-feed` | `oracle:data-feed` | 44 | call, request |
| `iot-sensor` | `iot:sensor-data` | 45 | call, day |
| `gas-relayer` | `gas:relayer` | 47 | request, call |
| `priority-slot` | `queue:priority-slot` | 49 | request, day |
| `proxy-bandwidth` | `network:proxy-bandwidth` | 55 | GB, request |
| `home-device` | `compute:home-device` | 90 | minute, day, job |

Default ceiling per request: 1000 call, 1000 request, 1440 minute, 31 day, 1000 GB, 1 job. Override with `maxQuantity`. `proxy-bandwidth` and `home-device` carry a warning about local law, power and security.

## Job escrow and the count of the buyer (SD-067, SD-068)

**Job escrow** (`JobBudget`, `SellerJob`, `BuyerJob`): the budget of a long job is committed as a bundle, and the job is paid chunk by chunk with cumulative vouchers. The seller works chunk k only after the voucher of chunk k arrived; the buyer signs the voucher of chunk k only after chunk k-1 arrived. A buyer who stops costs the seller nothing; a seller who vanishes costs the buyer one chunk at most. The contract needs two legs in a bundle (`ERR_BAD_BUNDLE`), so the terms carry a counter leg of one smallest unit from the seller to the buyer. The voucher is cumulative for the pair (payer, payee, epoch), so a job starts from `baseCumulative` and `baseSeq` of the pair, and the budget is reserved only in the running epoch: the job must end inside it.

**Count of the buyer** (`BuyerMeter`, option `meter` of `X207SchemeClient`): the buyer records what it really received (`recordBytes` for GB, `recordMillis` for minute and day, `recordCalls`) and signs no voucher above the price of that count plus what it asked for (`expect`). `authorize` checks a 402 with `extra.meter` before any voucher is signed; `checkVoucher` and `sign` check a cumulative voucher. A bill of 10 GB for 2 GB gets no voucher above 2 GB. The meter is per epoch (`epoch` and `baseCumulative` of the pair in the constructor, `startEpoch` for the next epoch): a voucher cumulative restarts in each epoch, so what was received in epoch 1 does not cover a voucher of epoch 2. Errors are `MeterOverbilledError` with a stable `code`:

| code | When |
| --- | --- |
| `meter_missing` | the 402 has no `extra.meter`, so the unit and quantity of the bill are unknown |
| `meter_bad_count` | a count that is negative, not an integer where one is needed, or has more than 6 decimals |
| `meter_unit_mismatch` | the unit of the 402 is not the unit bought, or a count in bytes or time for a meter of another unit |
| `meter_amount_mismatch` | `amount` is not `unit_price × quantity` of the announcement |
| `meter_price_too_high` | the unit price of the 402 is above the price the buyer agreed |
| `meter_quantity_over_expected` | the quantity of the 402 is above what the buyer asked for (or the ceiling per request) |
| `meter_overbilled` | a cumulative voucher is above the price of what was received plus what was asked for, counted per epoch from the base of the pair |
| `meter_wrong_epoch` | the voucher is for an epoch other than the one of the meter (call `startEpoch(epoch, baseCumulative)`), or the epoch or the base is not valid |
