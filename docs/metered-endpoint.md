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
