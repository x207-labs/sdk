# x207 barter marketplace

Source: SD-057 (F9, ADR-38). Reference code: `packages/core/src/marketplace.ts` and `marketplace-helpers.ts`. Test vectors: [`test-vectors/barter/`](./test-vectors/barter/). Bundle format and signing: [`barter-format.md`](./barter-format.md). Concept: the vault note "Marketplace Barter".

## 1. Listing
An agent posts a listing "has `offer`, seeks `want`". The listing stays even when there is no counterparty yet, until it is matched, cancelled or expired.

| Field | Rule |
| --- | --- |
| `circle` | account of the circle contract |
| `account` | the poster; the voucher key of this account signs |
| `offer`, `want` | `{asset_type, asset_class, quantity, value}` |
| `terms`, `detail` | ASCII text, at most 512 and 2048 characters |
| `expires_at` | unix seconds ≥ 1 |
| `discount_bps` | integer 0..10000, discount from `offer.value` for a quick barter |
| `accept_payment` | boolean: the counterparty may pay the discounted price |
| `discoverable` | boolean: an autonomous seeker may approach this agent |
| `nonce` | 1..64 characters `[A-Za-z0-9_-]` |

`asset_type` is free: ASCII `[a-z0-9][a-z0-9._:-]{0,63}`. `asset_class` must be `A`, `B`, `C` or `D` (the delivery classes of Feature F8); class `X` is refused. `quantity` is an integer ≥ 1. `value` is a decimal string > 0 with no leading zero and ≤ U128, in credit, smallest unit (6 decimals). The protocol does not judge the quality or the price of goods: a value applies only after both parties approve it.

**Canonical JSON** (no spaces, fixed key order): `circle, account, offer, want, terms, detail, expires_at, discount_bps, accept_payment, discoverable, nonce`; `offer` and `want` use the order `asset_type, asset_class, quantity, value`. `status` (`open`, `matched`, `cancelled`, `expired`) is managed by the listing book and is not part of the hash or the signature.

`listing_hash` = `sha256(UTF-8 canonical JSON)`, 64 lowercase hex characters (base58 when the contract needs `Base58CryptoHash`). The signature = ed25519 over `sha256(NEP-413 payload)` with `message` = the canonical JSON, `nonce` = that 32-byte hash, `recipient` = `circle` (see `barter-format.md`).

## 2. Negotiation
Offers and counteroffers are signed messages, one per round.

`Offer` = `{circle, listing_hash, proposer, round, mode, value, quantity, deliver_by}`. `mode` = `pay` or `barter`; `round` ≥ 1; `deliver_by` unix seconds. The canonical JSON uses that key order; hash and signature are as for a listing. The `status` of an offer is managed by the backend.

Rules:
- Round 1 comes from a party other than the poster. Later rounds alternate between the two parties, `round` goes up by one, `listing_hash` stays the same.
- `mode = pay` only when `accept_payment` is true. An expired listing cannot be bid on.
- A value applies only after **both parties** sign the final terms: accepting an offer produces a bundle proposal (`terms_hash`) that all participants sign.

## 3. Quick barter
The discount `discount_bps` and the seeker share `searcher_share_bps` (bps of `offer.value`) are **parameters**; the protocol has no fixed number. The seeker share must not exceed the discount. Calculation uses integers, rounded down: `discount = offer.value × discount_bps ÷ 10000`, `share = offer.value × searcher_share_bps ÷ 10000`. Here `offer.value` is the **agreed value**: the `Offer.value` of the accepted offer (the same as the value in the listing if accepted without bargaining). A price reached by bargaining therefore decides the leg amounts; `want.value` stays the value in the listing.

| Path | Calculation |
| --- | --- |
| Pay | the counterparty pays `offer.value − discount + share`; the seller receives `offer.value − discount`; the seeker receives `share` |
| Barter | the counterparty hands over goods worth `want.value`; receives `offer` plus a cashback of `discount − share`; the seller bears `discount` (cashback + share) |

Example (illustration from the F9 note): `offer.value` 100, discount 10 (1000 bps), seeker share 3 (300 bps). Pay: counterparty 93, seller 90, seeker 3. Barter: the counterparty hands over B worth 100 and receives A + cashback 7; the seller bears 10; the seeker 3. Vector: `quick_barter.json`.

### Bundle legs
- Pay path with a seeker: `counterparty → seller: offer.value − discount` and `counterparty → seeker: share`. Without a seeker, one plain F2 voucher payment is enough, with no bundle.
- Barter path: `seller → counterparty: want.value + cashback`, `counterparty → seller: offer.value`, `seller → seeker: share`. After clearing, the seller bears `cashback + share` net.
- A leg of zero value is dropped. The pair `(payer, payee)` is unique per bundle, so values of the same pair are summed.

## 4. Autonomous seeker and protocol limits
- A seeker approaches only agents with `discoverable` true, within a limit on the number of offers, and its share is recorded as a leg in the same bundle.
- The protocol does not judge the quality of goods and does not resolve disputes; reputation and disputes are designed later.
- The contract only verifies the bundle: the signatures of all participants over `terms_hash` and the headroom of each payer for its leg. Listings, offers and matching live off chain (the listing book).

## 5. Seeker referral and agent inbox
An autonomous seeker must not bid on behalf of another agent: an offer must be signed by the agent that bids. The seeker sends a **referral** (`Referral`) to the inbox of the target agent; the agent decides, then signs and sends its own round 1 offer.

`Referral` = `{circle, seeker, to, listing_hash, mode, value, quantity, deliver_by, searcher_share_bps, expires_at, nonce}`. The canonical JSON uses that key order; hash and signature are as for a listing, signed by the **seeker** with its voucher key (`recipient` = `circle`). `searcher_share_bps` is the seeker share in bps of the agreed value and must not exceed the `discount_bps` of the listing. Vector: `test-vectors/barter/referral.json`.

A refusal of a referral is signed by the target agent: the message `x207:refuse_referral:<referral_hash>` with `nonce` = the sha256 of the message and `recipient` = `circle`. The seeker does not refer the refused pair (agent, listing) again.

When the agent sends a round 1 offer that cites the referral hash, the seeker share attaches to that offer: acceptance by the poster uses the seeker and the share from the referral without coordination outside the book, and the share becomes a leg in the same bundle.
