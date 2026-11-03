# Invoice and installments (SD-065, pipeline P8, ADR-44)

An invoice is a claim of an issuer on a debtor outside x207. When the debtor signs it as an ordinary voucher it becomes an edge `debtor -> issuer` of the ledger and is cleared with everything else (F3). The contract does not change. All of this is in `@x207/core` (`invoice.ts`).

| Piece | Function |
| --- | --- |
| Document `{id, issuer, debtor, amount, memo}`, canonical JSON, sha256 | `serializeInvoice`, `invoiceHash` |
| `resource` of the voucher: `x207:invoice:<hash>` | `invoiceResource`, `parseInvoiceResource` |
| One-time voucher that continues the state of the pair | `invoiceVoucher`, `signInvoiceVoucher` |
| Date to epoch (nominal schedule) | `epochForTime` |
| Plan of n installments in n epochs | `planInstallments` (1 to 24) |
| All installment vouchers, signed once in advance | `signInstallments`, `installmentVoucher` |
| State of the pair after an installment (to seed the voucher store) | `installmentState` |
| Catch-up voucher for an installment that failed | `catchUpVoucher` |

The old format of the scenario `invoice:<hash>` is not an invoice resource any more: `parseInvoiceResource` returns `null` for it.

## Rules for installments
- Every installment voucher is signed by the debtor in advance: `seq` 1 of the pair in its epoch, cumulative equal to that installment.
- An ordinary voucher from the debtor to the issuer in the same epoch starts at `seq` 2, and its cumulative already holds the installment (`installmentState` gives that state for the voucher store of the client).
- There is **no spare voucher signed in advance**. A spare could be registered by the issuer although the real installment was paid, and the debtor would pay twice. If an installment fails to register (no headroom), the debtor signs a catch-up voucher **after** the failure (`catchUpVoucher`), once: it moves the installment to the next epoch on top of the state the pair has there. A second failure is `missed`; the SDK refuses a second catch-up (`installment_already_shifted`). There is no automatic fine.
- The date of an invoice maps to an epoch on the nominal schedule `openedAt + n × epochLength`. The contract opens the next epoch when `close_epoch` is called, so the real epoch can drift; the issuer must register before the `cutoff_at` of the epoch.

## Limit that is acknowledged, not a guarantee
The contract rejects a `seq` that does not increase per `(payer, payee, epoch)` and allows gaps in `seq`. A debtor can therefore block an installment voucher by registering a voucher with a higher `seq` to the issuer first: the installment with `seq` 1 is then refused. A signature in advance is evidence, not a guarantee of payment. What answers it is outside this format: the status `blocked_by_debtor` and the reputation of the backend, and the two-sided bond (CT-094) for a large invoice. A full guarantee needs a lock of headroom across epochs in the contract, which is not built.
