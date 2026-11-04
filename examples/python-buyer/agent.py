#!/usr/bin/env python3
"""A Python agent that pays an x402 endpoint with the x207 scheme (SD-086).

    X207_PAYER=translator.x207-circle.near X207_VOUCHER_KEY=ed25519:... python agent.py http://localhost:3000/api/summarize --calls 3

The payer must be an `active` member of the circle (see docs/join-the-circle.md) and the key is its voucher key (ADR-06), not a NEAR access key.
Every call is paid with the next cumulative voucher; nothing is signed that the limits below do not allow. Standard library only (the `x207` package of ../../python).
"""
import argparse
import json
import os
import sys

try:
    import x207
except ImportError:  # run straight from a checkout without installing
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python"))
    import x207


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Pay an x402 endpoint with the x207 scheme.")
    parser.add_argument("url")
    parser.add_argument("--calls", type=int, default=1, help="how many paid calls (default 1)")
    parser.add_argument("--max-per-call", default=os.environ.get("X207_MAX_PER_CALL"), help="credit base units (6 decimals); refuse a dearer call")
    parser.add_argument("--max-per-epoch", default=os.environ.get("X207_MAX_PER_EPOCH"), help="credit base units (6 decimals); refuse more per epoch")
    args = parser.parse_args(argv)
    payer, key = os.environ.get("X207_PAYER"), os.environ.get("X207_VOUCHER_KEY")
    if not payer or not key:
        print("set X207_PAYER (the member account) and X207_VOUCHER_KEY (ed25519:..., its voucher key)", file=sys.stderr)
        return 2
    client = x207.X207PaymentClient(payer, key, max_per_call=args.max_per_call, max_per_epoch=args.max_per_epoch)
    for number in range(1, args.calls + 1):
        try:
            response = x207.paid_get(client, args.url)
        except (x207.PaymentRefused, x207.SpendLimitError, RuntimeError) as error:
            print(f"call {number}: not paid: {error}", file=sys.stderr)
            return 1
        ext = ((response.receipt or {}).get("extensions") or {}).get("x207", {})
        print(json.dumps({"call": number, "status": response.status, "paid": response.paid, "body": response.json(),
                          "epoch": ext.get("epoch"), "seq": ext.get("seq"), "cumulativeAmount": ext.get("cumulativeAmount"), "registration": ext.get("registration")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
