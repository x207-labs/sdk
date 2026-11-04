"""A paying HTTP client for x207 sellers (SD-086), standard library only: GET a URL, answer a 402 with a signed voucher, read the receipt.
It does what `wrapFetchWithPayment` + `X207PaymentClient` do in TypeScript, for the `batch-settlement` entry on `x207:<circleId>`."""
import json
import urllib.error
import urllib.request
from typing import Dict, Optional

from .payment import PaymentRefused, X207PaymentClient, decode_header, select_x207_requirements


class PaidResponse:
    def __init__(self, status: int, headers: Dict[str, str], body: bytes, receipt: Optional[dict], paid: bool):
        self.status = status
        self.headers = headers
        self.body = body
        self.receipt = receipt  # the decoded PAYMENT-RESPONSE, None when the call was free
        self.paid = paid

    def json(self):
        return json.loads(self.body.decode("utf-8"))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect would carry the voucher to another host: refused."""

    def redirect_request(self, *args, **kwargs):
        return None


def _get(url: str, headers: Dict[str, str], timeout: float):
    request = urllib.request.Request(url, headers=headers, method="GET")
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
    except urllib.error.HTTPError as error:
        return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()


def paid_get(client: X207PaymentClient, url: str, timeout: float = 60.0) -> PaidResponse:
    """GET `url`; on a 402 that offers the x207 scheme, pay once (twice when the server resynchronises the counters) and return the paid answer.
    Raises `PaymentRefused` when the seller refuses the voucher, `RuntimeError` when it offers no x207 entry."""
    status, headers, body = _get(url, {}, timeout)
    if status != 402:
        return PaidResponse(status, headers, body, None, False)
    header = headers.get("payment-required")
    required = decode_header(header) if header else json.loads(body.decode("utf-8"))
    requirements = select_x207_requirements(required)
    if requirements is None:
        raise RuntimeError("the seller offers no batch-settlement entry on an x207 network: nothing this client can pay")
    refusal = "unknown"
    for _attempt in range(2):
        pending = client.create_payment(requirements, url)
        status, headers, body = _get(url, {"PAYMENT-SIGNATURE": pending.header}, timeout)
        receipt_header = headers.get("payment-response")
        receipt = decode_header(receipt_header) if receipt_header else None
        if client.on_response(pending, receipt) and status == 200:
            return PaidResponse(status, headers, body, receipt, True)
        refusal = (receipt or {}).get("errorReason") or f"HTTP {status}"
        if not client.resynced:
            break
        # the server told us where its counters are: sign again from there, once
        challenge = headers.get("payment-required")
        if challenge:
            fresh = select_x207_requirements(decode_header(challenge))
            requirements = fresh or requirements
    raise PaymentRefused(refusal)
