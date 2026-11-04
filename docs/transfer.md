# Transfer through the official feature of a platform (SD-077, P4, ADR-49)

A domain, a game item or a ticket changes hands through the platform itself: a registrar transfer, a Steam trade offer, a ticket transfer. x207 holds the voucher of the buyer until the platform shows that it happened. The contract does not change; on the chain there is a voucher with `resource = "x207:transfer:<hash>"`. The backend side is `backend/docs/transfers.md` (BE-074).

```ts
import { transferDocumentHash, transferResource, sellTxt, ownTxt, transferVoucher, transferBundleTerms } from "@x207/core";

const doc = {
  circle, seller, platform: "domain", transfer_ref: "example-shop.com", proof_method: "dns_txt",
  estimate_seconds: 86_400, value: "30000000", nonce: "n1",
};
const hash = transferDocumentHash(doc);       // transfer_doc of the listing detail
const resource = transferResource(hash);      // x207:transfer:<hash>
const sellText = sellTxt(listingHash);        // TXT on the domain before the listing: x207-sell=<listing_hash>
const ownText = ownTxt(purchaseId);           // TXT after the transfer: x207-own=<purchase id>
const voucher = transferVoucher({ doc, buyer, epoch, state }); // continues the pair, adds the price
```

| Platform | `proof_method` | `transfer_ref` | Window |
| --- | --- | --- | --- |
| `domain` | `dns_txt` | a domain name in lowercase ASCII (punycode for an international one) | 7 days |
| `game_item` | `trade_api` | `<appid>:<assetid>` | 1 hour |
| `ticket` | `buyer_confirm` | 1 to 256 characters of text | 1 day |

The mapping from platform to method is fixed. `estimate_seconds` is 1 up to the window of the platform. A ticket is limited to 100 credit. A website or an online store is roadmap only.

## A value at or above `bond_threshold`
At or above `bond_threshold` (default 100 credit) the transfer is a bundle of two legs with an arbiter, so the bond of CT-094 applies: `transferBundleTerms` gives the leg of the buyer to the seller for the price, the counter leg of 1 smallest unit from the seller to the buyer (the contract wants two legs), the `arbiter`, `confirm_by` (at most 14 days after now) and an optional `agreement_hash`. Without an arbiter the call throws `transfer_arbiter_required`. The arbiter is neither the buyer nor the seller. The window of the bond is 14 days, shorter than the 60 days in which a registrar can take a transfer back; that gap is accepted as a limit.

## Errors
`TransferError` with `code`: `transfer_bad_account`, `transfer_bad_hash`, `transfer_bad_platform`, `transfer_bad_ref`, `transfer_bad_method`, `transfer_method_mismatch`, `transfer_bad_value`, `transfer_bad_estimate`, `transfer_bad_nonce`, `transfer_bad_resource`, `transfer_bad_txt`, `transfer_ticket_over_limit`, `transfer_bond_threshold_invalid`, `transfer_arbiter_required`.

## What it does not say
The proof says that the buyer controlled the domain, or that the trade was accepted, at the moment it was checked. It does not say that a registrar will not reverse the transfer, that a Steam item is the genuine one, or that a ticket is valid: a ticket is the word of the buyer.
