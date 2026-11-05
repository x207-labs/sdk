# Changelog of the npm packages

Packages: `@x207/core`, `@x207/scheme`, `@x207/mcp`. The contract interface has its own changelog (`../CHANGELOG.md`). While the version is `0.0.x`, every change an outside caller can see raises the patch number.

## Unreleased: @x207/core 0.0.2, @x207/scheme 0.0.2, @x207/mcp 0.0.6 (prepared, not published)

Published so far: `@x207/core` 0.0.1, `@x207/scheme` 0.0.1, `@x207/mcp` 0.0.5. `@x207/scheme` and `@x207/mcp` depend on `@x207/core` at the exact version, so publish in the order core, scheme, mcp.

### @x207/core 0.0.2

**EVM agents (`@x207/core/evm`, new export)**
- `VoucherSigner` and EIP-712 signing for agents that hold only a `0x` key. Domain `EIP712Domain(string name,string version,bytes32 salt)` with `salt = keccak256("near:" + network + ":" + contract account id)` (audit finding C55: a signature is bound to one network and one circle). Types are fixed in `contracts/tests/fixtures/evm-eip712.json`.
- Signed actions for the relayer routes: join, claim, exit, withdraw, `auto_settle` and `auto_settle_off`.

**Auto-settle (contract 0.0.15)**
- `buildSetAutoSettleCall` (attaches the 1 yoctoNEAR the contract requires), `getAutoSettle`, and the events `auto_settle_set` and `auto_settled` in the NEP-297 parser.
- ABI pin moved to contract 0.0.15 (`abi/x207-circle.abi.json`, regenerated `types.generated.ts`).

**NEP-518 `rlp_execute` (SD-097)**
- `signNep518Transaction`, `decodeNep518Transaction`, `encodeNep518FunctionCall`, `decodeNep518FunctionCall`, `nep518ToAddress`, `NEP518_CHAIN_ID` (398 testnet, 397 mainnet), `NEP518_FUNCTION_CALL_SELECTOR`. A `0x` key signs an EIP-1559 transaction that calls a NEAR contract through its eth-implicit account; the circle sees the `0x` account as the caller. Tested against a real testnet transaction (`test/fixtures/nep518-rlp-execute.json`).

**Contract 0.0.13 and 0.0.14 interface**
- Parser for the 0.0.13 events (`clearing_applied` summary, `epoch_committed` with all positions), the canonical hashes `edgesHash` and `positionsHash`, and `get_proposal` in pages. ABI pins for 0.0.13 and 0.0.14.

**Formats**
- One-time code listing `x207:code:<hash>` with `code_commitment = contentHash(salt || code)` and a random 32-byte salt; transfer listing `x207:transfer:<hash>`.
- All error messages and warnings are English.

### @x207/scheme 0.0.2
- `x207Middleware` accepts `alsoAccept`: extra `accepts` entries (for example `exact` on `eip155:84532`, Base Sepolia) that are verified and settled at their own facilitator, next to the `x207` voucher entry (SD-093).
- EVM branch in verify and in the client: vouchers signed with EIP-712 by a `0x` key are accepted.
- Depends on `@x207/core` 0.0.2.

### @x207/mcp 0.0.6
- No change in the tools since 0.0.5. The package now depends on `@x207/core` 0.0.2 and `@x207/scheme` 0.0.2, so an install gets the EVM, auto-settle and NEP-518 code above.
- `server.json` (MCP Registry) moves to 0.0.6.

## @x207/mcp 0.0.5
Tool descriptions and parameter text rewritten for the Glama quality score. Hosted URLs: read API `https://x207.boxd.sh`, MCP `https://mcp.x207.boxd.sh/mcp`. `X207_EVM_PRIVATE_KEY` lets the write tools sign with an EVM key.

## @x207/mcp 0.0.1 to 0.0.4, @x207/core 0.0.1, @x207/scheme 0.0.1
First packages (2026-11-04): voucher format and signing, circle contract client, NEP-297 parser, barter and invoice formats, x402 scheme `x207`, MCP server with six read tools and the write tools (stdio only, off by default), `mcpName` and `server.json` for the MCP Registry, `bin` fix at 0.0.2.
