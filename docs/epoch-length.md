# `epoch_length` and the wait for payment (for sellers)

`epoch_length` is a circle parameter held by the DAO that owns the contract, not a constant in the code. The demo default is 3600 seconds (1 hour, ADR-25); the range the contract accepts is 300 to 604800 seconds (5 minutes to 7 days). Related parameters: `proposal_window` (default 600 seconds) and `payment_window` (default 1800 seconds, minimum 900).

## How to change it

Only the `owner` account (the circle's Sputnik DAO) may call `set_params`. The flow: a `set_params` proposal is created and approved in the DAO, then the contract stores the new value as *pending* params that apply from the next epoch (applied at `close_epoch` of the current epoch). A value outside the range is refused with `ERR_PARAM_OUT_OF_RANGE: <field>`. The view `get_pending_params` shows the waiting value and its `effective_epoch`, and the event `params_updated` records the change. The dashboard shows it on the Governance page.

## Trade-offs for sellers

| Shorter epoch | Longer epoch |
| --- | --- |
| Debt is cleared and net positions fall due sooner, so the seller's risk hangs for a shorter time | Fewer clearing and registration transactions per day |
| More `close_epoch`, `submit_clearing`, `commit_epoch` transactions per day | The seller waits longer until the cash payment of its net position falls due |
| A smaller graph per epoch, so fewer cycles can be removed | A bigger graph gives more chances for cycles (density, ADR-16) |

The seller's worst-case wait to receive cash from a net position is the rest of the epoch plus `proposal_window` plus `payment_window` after `cutoff_at`.

## What counts as "paid"

Value removed by clearing is paid through **debt reduction**: circular debts cancel each other, so there is no cash payment for that part. Only the net position becomes a cash payment (USDT) in the payment window. A seller who receives a voucher from a buyer whose debt is later removed by clearing does not have to wait for cash for the removed part.
