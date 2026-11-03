# Readiness of the npm packages (SD-075)

Nothing was published. `npm publish` waits for the owner. This page says what was checked, what was changed, and what is left.

## Which packages are public
| Package | Version | Public | Entries |
| --- | --- | --- | --- |
| `@x207/core` | 0.0.1 | yes | `.`, `./signer`, `./package.json` |
| `@x207/scheme` | 0.0.1 | yes | `.`, `./client`, `./server`, `./facilitator`, `./package.json` |
| `@x207/facilitator`, `@x207/example-buyer`, `@x207/example-seller` | 0.0.1 | no (`"private": true`) | apps and examples of this repository |

`@x207/scheme` depends on `@x207/core` at the exact version 0.0.1, so `core` is published first.

## The tarball (`npm pack --dry-run --json`, after `npm run build`)
| Package | Files | Size | Content |
| --- | --- | --- | --- |
| `@x207/core` | 55 | 96 kB | `dist/**/*.js`, `dist/**/*.d.ts`, `README.md`, `LICENSE`, `package.json` |
| `@x207/scheme` | 45 | 43 kB | the same |

Found before the change: no `README.md` and no `LICENSE` in either tarball (npm takes the license file from the package folder, not from the repository root), the source maps (`dist/**/*.map`, which point to `src/` that is not shipped) and `dist/tsconfig.tsbuildinfo` in `scheme`. Found after the change: only `dist` code and types, the README, the LICENSE and `package.json`. No test, fixture, `.env`, key or `abi` source file is in either tarball (checked by name: `test`, `fixture`, `.env`, `key`; the only match is `access-key.*`, a source module).

## Fields
`name`, `version`, `license`, `type: module`, `main`, `types`, `exports` (with `types` first), `engines` (`node >=22.22.2`) were right. Added: `files` (code, README, LICENSE, and no maps or build info), `repository` (with `directory`), `homepage`, `bugs`, `keywords`, `sideEffects: false`, `publishConfig.access: public`, and descriptions in English. `repository` names `github.com/x207-labs/sdk`, which is a **private** repository: the link works for the owner only until the repositories are made public (the owner decides).

## Install and run from the local tarballs
In a clean folder: `npm pack` in each package, then `npm install x207-core-0.0.1.tgz x207-scheme-0.0.1.tgz`. The example of each README was cut out of the README and run as it is:
- `@x207/core`: signs a voucher and prints `true`, then `false` for a changed amount.
- `@x207/scheme`: `DailyRent` checks an active access and signs one day, `250000`.
- Every entry loads: `@x207/scheme`, `/client`, `/server`, `/facilitator`, `@x207/core`, `@x207/core/signer`. `npm ls --all` shows no missing or invalid dependency.

## Open points (for the owner)
1. **`npm audit --omit=dev` says 4 high:** `zod < 4.6.6` (memory use on oversized constrained collections, GHSA-mrhx-c7xc-m3w5) through `@x402/core` 2.0.0 to 2.28.0, which both packages depend on at the exact version 2.28.0. No fixed version exists at the time of writing. We do not parse untrusted collections with zod ourselves, but the facilitator and the seller middleware use `@x402/core` types and clients on request bodies, so the issue is in the path. Say it in the release notes, or move to a fixed `@x402/core` when there is one.
2. **Name and scope:** the packages are named `@x207/*`. The scope `@x207` must exist on npm and the owner must be a member; this was not checked (it needs a login).
3. **Provenance:** publishing with `--provenance` from the CI of the repository gives a signed link from the package to the commit; it needs the repository to be public. Not set up.
4. **Version:** 0.0.1 is the version of every package of the repository; the contract is at 0.0.12 and the interface of `@x207/core` follows it (`ContractAbi`). Decide whether the first release is 0.0.1 or 0.1.0 before publishing.
5. **Node:** `core` uses `node:crypto` in several modules (vouchers, hashes), so it runs on Node and not in a browser as it is; the modules for content licenses and grantee proofs avoid it (the frontend imports them). A browser build is not part of this item.
6. **Dry run of the publish:** `npm publish --dry-run` was not run, because it asks for a login.
