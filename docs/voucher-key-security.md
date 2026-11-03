# Voucher key security

Applies to `@x207/core` (SD-037, ADR-06).

## What this key is

The voucher key is an ed25519 keypair that an agent uses to sign cumulative vouchers off chain. Its public key is registered as `pubkey_voucher` at `join` (D1). The `x207-circle` contract verifies voucher signatures against that key.

**This key is not a NEAR access key.** It is not registered on any NEAR account, cannot sign transactions, and cannot move tokens or NEAR out of the agent's account. The only thing it can sign is an x207 voucher (canonical bytes in [`spec/voucher-format.md`](../spec/voucher-format.md)), and a voucher only counts if an `active` member has headroom.

## Creating the key

```ts
import { generateVoucherKeypair } from "@x207/core";

const { secretKey, publicKey } = generateVoucherKeypair();
// secretKey: "ed25519:<base58 64 byte>"  -> keep secret (env or secret manager)
// publicKey: "ed25519:<base58 32 byte>"  -> sent to join() as pubkey_voucher
```

`generateVoucherKeypair` uses the system random generator. Create a new key just for vouchers; do not reuse the seed of the access key of the NEAR account (the contract accepts a key equal to the access key, but that weakens this separation, ADR-32 K-23).

## If the key leaks

An attacker who holds the voucher key can sign vouchers in the name of the agent until the agent's headroom is used up. The impact:

- **Can:** create vouchers with payer = the agent to any `active` payee. Each voucher adds to the agent's obligation. The total loss is limited by the agent's `limit`, and in the MVP `limit ≤ stake` (ADR-18), so the maximum loss is the stake that is already locked.
- **Cannot:** move assets in the agent's NEAR account, sign NEAR transactions, withdraw the stake (`withdraw_stake` is called from the NEAR account, not with the voucher key), or change other members.

Step if you suspect a leak: call `request_exit` from the agent's NEAR account. Once `exit_requested_epoch` is set, the facilitator refuses new vouchers from that agent (`member_exiting`, ADR-29). Vouchers already accepted stay as obligations. Interface spec `0.0.1` does not yet have a key rotation method.

## Practice

- Keep `secretKey` only in `.env` or a secret manager; do not commit it.
- One key per agent; do not share it between agents.
- Limit `limit` through the stake to what you are ready to lose if the key leaks.
