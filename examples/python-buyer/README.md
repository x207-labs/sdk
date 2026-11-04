# A Python agent that pays with x207 (SD-086)

`agent.py` pays an x402 endpoint with the x207 scheme (`batch-settlement` on `x207:<circleId>`) from Python, using only the standard library and the `x207` package of [`../../python`](../../python). The seller can be any x207 seller; the test runs it against [`../seller`](../seller) (TypeScript, Hono) behind the reference facilitator and the real contract in `near-sandbox`.

The payer must be an `active` member of the circle and `X207_VOUCHER_KEY` is its **voucher key** (`ed25519:…`, ADR-06), not a NEAR access key. How to join: [docs/join-the-circle.md](../../../docs/join-the-circle.md).

## Set up and run

A local virtual environment in this folder; nothing is installed globally and nothing is published to PyPI:

```bash
cd sdk/examples/python-buyer
python3 -m venv .venv && .venv/bin/pip install ../../python    # pure Python, no dependencies
X207_PAYER=my-agent.testnet X207_VOUCHER_KEY=ed25519:… \
  .venv/bin/python agent.py http://localhost:3000/api/summarize --calls 3
```

Each paid call prints one JSON line: `{"call":1,"status":200,"paid":true,"body":{…},"epoch":9,"seq":1,"cumulativeAmount":"20000","registration":"pending"}`. `--max-per-call` and `--max-per-epoch` (credit base units, 6 decimals; or `X207_MAX_PER_CALL`, `X207_MAX_PER_EPOCH`) stop a payment before any voucher is signed (exit code 1). Without the venv, `python3 agent.py …` works from a checkout too (it adds `../../python` to the path). Re-run `pip install ../../python` after the package changes.

What the agent does, as `paid_get(client, url)` in `x207.client`: GET the URL; on `402` read `PAYMENT-REQUIRED`, take the `batch-settlement` entry on an `x207:` network (an endpoint that offers only `exact` is refused: this client cannot pay it); sign the next **cumulative** voucher for (payer, payee, epoch) and retry with `PAYMENT-SIGNATURE`; read `PAYMENT-RESPONSE`. The counters move only when the server confirms. If the server says it is further ahead (`extensions.x207.lastSeq`, for example after a restart of the agent), the client takes the server's counters and signs once more. A redirect is never followed, so the voucher cannot be sent to another host.

## Tests

| Test | What it checks | Needs |
| --- | --- | --- |
| `python/tests/test_payment.py` (`cd sdk/python && python3 -m unittest discover -s tests`) | the `PAYMENT-SIGNATURE` header bytes equal the vectors of `spec/test-vectors/payload/`; limits, resync, grant resource; `paid_get` against a stub seller | python3 |
| `test/parity.test.ts` (`npx vitest run examples/python-buyer/test/parity.test.ts` in `sdk/`) | 40 random vouchers signed by `@x207/core` verify in Python, and the signatures Python makes are the same bytes; tampered vouchers fail on both sides; a Python keypair signs for TypeScript | python3 |
| `test/python-buyer.sandbox.test.ts` (`X207_SANDBOX=1 npx vitest run examples/python-buyer/test/python-buyer.sandbox.test.ts`) | a Python process pays the TypeScript seller three times (seq 1 to 3), a restarted process resyncs and pays seq 4, the facilitator registers the vouchers and the contract shows `cumulative 80000`, `last_seq 4`; a spend limit stops the next call | near-sandbox as for the other sandbox tests; `X207_PYTHON` picks the interpreter (default: `.venv`, else `python3`) |

Not covered: bundle legs (`bundleId`), metered endpoints (`extra.meter`), and the `exact` fallback; the TypeScript client does those.
