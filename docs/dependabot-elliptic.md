# Dependabot: `elliptic` 6.6.1 (GHSA-848j-6mx2-7j84), triage SD-103

Status: **open, not upgraded, alert not dismissed.** Checked on 2026-11-09.

## The alert

- Package `elliptic`, severity low (CVSS 5.6), "uses a cryptographic primitive with a risky implementation". Vulnerable range `<= 6.6.1`, **no patched version exists** (GitHub advisory API: `first_patched_version: null`).
- The flaw: ECDSA **signing** with `elliptic` computes the RFC 6979 value `k` with the wrong byte length when `k` has leading zeros. The signature is then wrong and, if an attacker holds both a faulty and a correct signature for the same input, the secret key can be derived. Verifying signatures is not affected by this description.

## Where it comes from

`npm ls elliptic` in this repository:

```
@x207/facilitator@0.0.1 (apps/facilitator)
  -> @near-js/crypto@2.5.1
    -> secp256k1@5.0.1
      -> elliptic@6.6.1
```

- It is a transitive dependency of the facilitator only. No other workspace pulls it.
- `secp256k1` loads its native binding first and falls back to `elliptic` only when the binding fails to load (`node_modules/secp256k1/index.js`).
- Inside `@near-js/crypto` the vulnerable path is `KeyPairSecp256k1.sign`, which calls `secp256k1.ecdsaSign`.

## Is a fix available

No.

- `elliptic` 6.6.1 is the latest published version; the advisory covers all known versions.
- `secp256k1` 5.0.2 (the latest) still depends on `elliptic ^6.5.7`.
- `@near-js/crypto` 2.5.1 is the `latest` tag and pins `secp256k1` 5.0.1.
- An `overrides` entry could only point `elliptic` at another version of the same unpatched package, or at a different library; neither makes it safer, and a swapped-in library would not be tested by `@near-js/crypto`.

## Why the exposure here is low (from the code, not a run of an exploit)

- The facilitator's gas-key code assumes an ed25519 key: `apps/facilitator/src/gas-key.ts` (`signGasKeyTransaction`) strips an `ed25519:` prefix and decodes the rest as the public key. The ed25519 code path does not use `elliptic`. The relayer key in `relay.ts` goes through `KeyPair.fromString`, which accepts either key type; I did not find a check that rejects `secp256k1:`.
- `grep` over `apps` and `packages` finds no use of a secp256k1 NEAR key; the only `secp256k1` hits are the name in the asset-template redaction regex (`packages/core/src/asset-templates.ts`) and a comment on the group order (`packages/core/src/evm.ts`).
- The EVM voucher path of `@x207/core` (`packages/core/src/evm.ts`) imports `viem` for signing, not `elliptic`; I did not trace `viem`'s own dependencies.
- The package is loaded by `@near-js/crypto` at import time, so it is installed and loaded, but its signing function is not called by this code.

This is a reading of the source. It is not a guarantee: an operator who configures a `secp256k1:` relayer key for the facilitator would use the vulnerable signing path. Do not do that until a patched release exists.

## What stays open

- Watch for a patched `elliptic`, a `secp256k1` release that drops it, or a `@near-js/crypto` release that moves to `@noble/curves` only. Re-run `npm ls elliptic` and `npm audit` when `@near-js/*` is bumped.
- The Dependabot alert stays open on purpose so that it shows when a fix lands.
