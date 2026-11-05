# EVM agent example

An agent that holds **only an EVM key** (`0x…`) uses an x207 circle. It has no NEAR account, no NEAR key and no NEAR token. The relayer sends the NEAR transactions and pays the gas and the join deposit; the agent signs EIP-712 messages.

```text
agent (0x key) --signs--> facilitator /evm/join, /evm/claim, /evm/exit, /evm/withdraw --> circle contract (join_evm, claim_evm, ...)
agent (0x key) --eip712 voucher--> x402 seller --> facilitator /verify, /settle --> relayer registers the voucher
```

The member id in the circle is the lower-case `0x` address. A voucher is signed with `signTypedData` (domain `{ name: "x207", version: "1", salt }` with `salt = keccak256("near:" + network + ":" + contract account id)`, type `Voucher`); the facilitator recovers the address with viem, the contract with `ecrecover`. The types are fixed in the design note and in `contracts/tests/fixtures/evm-eip712.json`.

## Use it in code

```ts
import { createEvmAgent } from "./src/agent.js";

const agent = createEvmAgent({ privateKey: "0x…", relayerUrl: "https://…", circleContract: "x207-v014.testnet" });
await agent.join(termsHash);                 // relayer pays the deposit (and, on testnet, stakes)
const response = await agent.payFetch()(url); // pays x402 `x207` entries with an eip712 voucher
await agent.claim(epoch, "wallet.testnet");   // payout to a NEAR account you name in the signature
```

Run it once against a testnet facilitator that has the relayer routes:

```bash
EVM_PRIVATE_KEY=0x… RELAYER_URL=https://… CIRCLE_CONTRACT=x207-v014.testnet SELLER_URL=https://…/api/summarize npm run start -w @x207/example-evm-agent
```

Without `EVM_PRIVATE_KEY` the example makes a new key and prints only the address.

## Limits of this version

- Intents, grants, escrow and deals are not available to EVM members yet (they need the member as the transaction sender).
- On mainnet the stake and the payout would go through NEAR Intents; this is roadmap. On testnet and in the sandbox the relayer holds a mock USDT and stakes for the agent (`X207_EVM_STAKE_TOKEN`, `X207_EVM_STAKE_AMOUNT`).
- The relayer limits requests per address and the joins it sponsors per hour.

The end-to-end test is `test/evm-agent.sandbox.test.ts` (`X207_SANDBOX=1`, needs the contract 0.0.14 wasm).

## Testnet run (SD-090)

`test/evm-agent.testnet.live.test.ts` (`X207_TESTNET=1`, keys under `$X207_SECRETS`) runs the whole path on `x207-v014.testnet` with a new `0x` key: join through the relayer, DAO admission (the circle has admission `dao`, so the council votes `admit_member` and the relayer stakes afterwards), a paid x402 call with an EIP-712 voucher, registration, epoch close, commit and finalize by the keeper, and `claim_evm` to the eth-implicit NEAR account of the same `0x` address. All hashes are in [docs/testnet-epochs/sd090-evm-agent-run.json](../../../docs/testnet-epochs/sd090-evm-agent-run.json).

