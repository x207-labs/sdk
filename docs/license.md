# License of content (SD-070, pipeline P7, ADR-46)

x207 stores no file. The seller keeps the **ciphertext** at any source; the buyer pays with a voucher that the backend holds; the key of the file is released sealed to the buyer; the buyer checks the plain file against `content_hash`; a wrong file is shown by a proof that anyone can check. All of it is in `@x207/core` (`license.ts`) and runs in the browser (no `node:crypto`).

| Piece | Function |
| --- | --- |
| `content_hash`: sha256 up to 4 MiB, Merkle root per 4 MiB above | `contentHash`, `ContentHasher`, `merkleRoot` |
| Document, hash, resource `x207:license:<hash>` | `serializeLicense`, `licenseDocumentHash`, `licenseResource` |
| Encryption: XChaCha20-Poly1305 per 4 MiB chunk, final-chunk flag in the AAD | `encryptContent`, `decryptContent` |
| Key sealed to the buyer (x25519 from the ed25519 voucher key) | `sealKey`, `openSealedKey`, `deriveBoxKey` |
| Release signed by the seller (the notice `key_released`) | `createRelease`, `signRelease`, `verifyRelease` |
| Buyer check and proof of cheating | `verifyDelivery`, `makeCheatProof`, `checkCheatProof` |
| Sources of the ciphertext | `httpsSource`, `ipfsSource`, `fetchCiphertext` |
| Canary watermark of a dataset | `addCanaries`, `findCanaries`, `stripCanaries` |

Crypto: `@noble/ciphers` 1.3.0, `@noble/curves` 1.9.7, `@noble/hashes` 1.8.0 (already in the lockfile as dependencies of other packages; approved by the coordinator).

## Sources and size
- `https` takes any host name (S3, R2, Drive, Dropbox, your own server). The SDK refuses a non-https address, credentials in the address, and a redirect to a non-https address; the check of private addresses is the backend's.
- `ipfs` takes a **CIDv1 raw sha2-256**, which names one block. A **file larger than one block uses `https`**: CIDv0 and `dag-pb` (the root of a multi-block DAG) cannot be verified without walking the DAG, so they are refused (`source_cid_unsupported`). Whatever the source says, `cipher_hash` of the release is checked on the bytes.

## Proof of cheating
Ciphertext, the release signed by the seller (it holds `cipher_hash`, `content_hash` and the sealed key) and the box key that opens the sealed key. The checker needs only the public key of the seller. A proof for a right file is refused (`file_is_correct`), a wrong box key is refused (`box_key_invalid`). The buyer's secret key never leaves the buyer.

## Limits
- A sealed key that the buyer cannot open is not provable as cheating: the buyer disputes with reason `other` and nothing is paid.
- An exclusive license is recorded per `content_hash`; a seller who changes one byte is not detected.
- A watermark finds someone who spreads the file unchanged, not someone who reworks it.
