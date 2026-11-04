# One paid MCP tool, paid with an x207 voucher (SD-083, spike)

`@x402/mcp` 2.29.0 takes the x207 scheme without any change in either package. A tool of an MCP server costs one voucher of the circle; the agent that calls it signs the voucher after the server answers `402`; the tool runs only after the facilitator verified the voucher; the voucher is registered on the contract. Run on `near-sandbox` with a real circle contract.

```bash
X207_SANDBOX=1 npx vitest run examples/mcp-paid-tool     # from the sdk folder; about 40 seconds
```

## How it is wired

| Side | Code | What |
| --- | --- | --- |
| Seller | `src/seller.ts` | `x402ResourceServer` (with an `HTTPFacilitatorClient` on the reference facilitator), `register("x207:<circleId>", new X207SchemeServer())`, `buildPaymentRequirements({ scheme: "batch-settlement", network, payTo, price: "$0.02" })`, then `createPaymentWrapper(resourceServer, { accepts })` around the handler of `server.tool(...)` |
| Buyer | `src/buyer.ts` | `createx402MCPClient({ schemes: [{ network: "x207:<circleId>", client: new X207SchemeClient({ payer, secretKey }) }], autoPayment: true, onPaymentRequested })` |
| Test | `test/paid-tool.sandbox.test.ts` | circle, two members, the facilitator over HTTP, the two ends of the MCP connection linked in memory, and the `RegistrationScheduler` that puts the voucher on the contract |

What the test shows: a free tool runs with no payment; the paid tool asks `onPaymentRequested` (amount `20000`, the seller as `payTo`), runs, and answers with `paymentResponse.transaction` = `payer:payee:epoch:1` and `registration: "pending"`; the relayer registers the voucher and the view `obligation` says `cumulative` `20000`, `last_seq` 1; a payment that the owner refuses runs nothing and signs nothing.

## What did not fit, and what to know

1. **One copy of `@x402/core` (SD-084).** The SDK pins `@x402/core`, `@x402/fetch` and `@x402/near` at 2.29.0, the version `@x402/mcp` 2.29.0 depends on (`~2.29.0`), so there is one copy of `@x402/core` in the lockfile and the scheme classes (`X207SchemeServer`, `X207SchemeClient`) are passed to the registries without any cast. (Before SD-084 the SDK was on 2.28.0 and a cast `as never` was needed.) `scripts/check-pins.mjs` of the umbrella holds the same pins.
2. **One `zod` (SD-084).** `@x402/core` and `@x402/mcp` need `zod` `^4.6.6`; `packages/mcp` pins `zod` 4.6.7, so the SDK tree has one `zod`.
3. **`X207PaymentClient` is not used.** `createx402MCPClient` builds its own `x402Client`, so the headroom estimate of `X207PaymentClient` (the voucher while the headroom lasts, the `exact` entry after `insufficient_credit`) is not in this path. `wrapMCPClientWithPayment(mcpClient, new X207PaymentClient(...))` should bring it; **not tried**.
4. **Install.** The example has its own `node_modules` (not in the lockfile of the sdk): `@x207/core` and `@x207/scheme` are workspace packages and are not on the npm registry, so an install inside this folder alone fails. To reproduce: remove the two `@x207/*` lines from `dependencies`, run `npm install --workspaces=false --package-lock=false --ignore-scripts` here, put the lines back; the workspace links of the sdk resolve `@x207/*`. Adding `examples/mcp-paid-tool` to `tsconfig.json` of the sdk and to the lockfile is left to whoever owns them.
5. **Not checked:** a real wallet or host (Claude Desktop) as the buyer, Streamable HTTP or stdio instead of the in-memory link, `x402Version` 1 clients, more than one paid call (the pair state of the second voucher), and the `exact` fallback. The voucher `resource` that the client signs for an MCP tool was not looked at.
