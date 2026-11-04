"""The x402 side of an x207 buyer in Python (SD-086): read a 402, choose the `batch-settlement` entry on `x207:<circleId>`, sign the next cumulative voucher
and build the `PAYMENT-SIGNATURE` header; read `PAYMENT-RESPONSE` to commit the voucher or resynchronise. The bytes are those of `X207SchemeClient`
of `@x207/scheme` (checked with `spec/test-vectors/payload/`). Standard library only; no network here, `x207.client` does the HTTP."""
import base64
import json
import re
from typing import Callable, Dict, Optional, Tuple

from . import signing
from ._check import MAX_SAFE_INTEGER, U128_MAX, is_account, is_int, is_uint_string, need
from .signing import FormatError, SecretKey, canonical_json
from .voucher import CREDIT_UNIT, grant_resource, sign_voucher

X207_SCHEME = "batch-settlement"
CREDIT_DECIMALS = 6
_NETWORK = re.compile(r"^x207:[-_a-zA-Z0-9]{1,32}$", re.ASCII)
_COMMITMENT = re.compile(r"^[^:]+:[^:]+:\d+:\d+$")


class SpendLimitError(Exception):
    """The owner's limit stops a payment; no voucher was signed."""


class PaymentRefused(Exception):
    """The server refused the voucher; `reason` is its `errorReason`."""

    def __init__(self, reason: str):
        super().__init__(f"payment refused: {reason}")
        self.reason = reason


def encode_header(value: dict) -> str:
    """Base64 of the compact JSON, like the x402 v2 headers (`PAYMENT-SIGNATURE`)."""
    return base64.b64encode(canonical_json(value).encode("utf-8")).decode("ascii")


def decode_header(header: str) -> dict:
    """The JSON object in a `PAYMENT-REQUIRED` or `PAYMENT-RESPONSE` header (standard or URL-safe base64, padding optional)."""
    text = header.strip()
    raw = base64.b64decode(text + "=" * (-len(text) % 4), altchars=b"-_" if ("-" in text or "_" in text) else None)
    value = json.loads(raw.decode("utf-8"))
    need(isinstance(value, dict), "header must hold a JSON object")
    return value


def validate_requirements(requirements) -> dict:
    """The rules of `validatePaymentRequirements` of `@x207/core`; raises `FormatError`."""
    need(isinstance(requirements, dict), "requirements must be an object")
    need(requirements.get("scheme") == X207_SCHEME, 'scheme must be "batch-settlement"')
    network = requirements.get("network")
    need(isinstance(network, str) and _NETWORK.match(network) is not None, "network must be x207:<circleId>")
    amount = requirements.get("amount")
    need(is_uint_string(amount) and amount != "0", "amount must be an integer string > 0")
    need(requirements.get("asset") == "USD", 'asset must be "USD"')
    need(is_account(requirements.get("payTo")), "payTo must be a NEAR account")
    need(is_int(requirements.get("maxTimeoutSeconds"), 1), "maxTimeoutSeconds must be an integer >= 1")
    extra = requirements.get("extra")
    need(isinstance(extra, dict), "extra must be an object")
    need(is_account(extra.get("circleContract")), "extra.circleContract must be a NEAR account")
    need(extra.get("unit") == CREDIT_UNIT, 'extra.unit must be "credit"')
    need(extra.get("decimals") == CREDIT_DECIMALS and not isinstance(extra.get("decimals"), bool), "extra.decimals must be 6")
    need(is_int(extra.get("epoch"), 1), "extra.epoch must be an integer >= 1")
    need(extra.get("grantId") is None or is_int(extra.get("grantId"), 1), "extra.grantId must be an integer >= 1 if present")
    return requirements


def select_x207_requirements(payment_required: dict) -> Optional[dict]:
    """The first entry of `accepts` that is `batch-settlement` on an `x207:` network, or `None` (the seller offers only `exact`)."""
    for entry in payment_required.get("accepts", []) if isinstance(payment_required, dict) else []:
        if isinstance(entry, dict) and entry.get("scheme") == X207_SCHEME and str(entry.get("network", "")).startswith("x207:"):
            return entry
    return None


class MemoryVoucherStore:
    """`seq` and `cumulativeAmount` of the last confirmed voucher for (payer, payee, epoch); `(0, "0")` when none yet."""

    def __init__(self) -> None:
        self._states: Dict[Tuple[str, str, int], Tuple[int, str]] = {}

    def get(self, payer: str, payee: str, epoch: int) -> Tuple[int, str]:
        return self._states.get((payer, payee, epoch), (0, "0"))

    def commit(self, payer: str, payee: str, epoch: int, seq: int, cumulative: str) -> None:
        self._states[(payer, payee, epoch)] = (seq, cumulative)


class PendingPayment:
    """A voucher that is signed and not yet confirmed by `PAYMENT-RESPONSE`."""

    def __init__(self, payload: dict, header: str, key: Tuple[str, str, int], seq: int, cumulative: str, amount: int):
        self.payload = payload
        self.header = header
        self.key = key
        self.seq = seq
        self.cumulative = cumulative
        self.amount = amount


class X207PaymentClient:
    """Cumulative vouchers per (payer, payee, epoch), one request at a time per client (call from one thread)."""

    def __init__(self, payer: str, secret_key: SecretKey, store: Optional[MemoryVoucherStore] = None,
                 max_per_call: Optional[str] = None, max_per_epoch: Optional[str] = None):
        need(is_account(payer), "payer must be a NEAR account")
        signing.public_key_of(secret_key)  # fails early on a bad key
        self.payer = payer
        self._secret_key = secret_key
        self.store = store or MemoryVoucherStore()
        self._max_per_call = int(max_per_call) if max_per_call is not None else None
        self._max_per_epoch = int(max_per_epoch) if max_per_epoch is not None else None
        self._spent: Dict[int, int] = {}

    def spent_in_epoch(self, epoch: int) -> int:
        return self._spent.get(epoch, 0)

    def create_payment(self, requirements: dict, resource_url: str) -> PendingPayment:
        """Signs the next voucher for `requirements`. The state moves only in `on_response`, when the server confirms it."""
        checked = validate_requirements(requirements)
        extra = checked["extra"]
        amount = int(checked["amount"])
        epoch = extra["epoch"]
        resource = resource_url if extra.get("grantId") is None else grant_resource(extra["grantId"])
        spent = self.spent_in_epoch(epoch)
        if self._max_per_call is not None and amount > self._max_per_call:
            raise SpendLimitError(f"spend limit per call exceeded: {amount} > {self._max_per_call}")
        if self._max_per_epoch is not None and spent + amount > self._max_per_epoch:
            raise SpendLimitError(f"spend limit per epoch exceeded: {spent} spent + {amount} > {self._max_per_epoch}")
        seq0, cumulative0 = self.store.get(self.payer, checked["payTo"], epoch)
        seq, cumulative = seq0 + 1, str(int(cumulative0) + amount)
        need(int(cumulative) <= U128_MAX and seq <= MAX_SAFE_INTEGER, "voucher counters overflow")
        unsigned = {"circle": extra["circleContract"], "payer": self.payer, "payee": checked["payTo"], "epoch": epoch, "seq": seq,
                    "cumulativeAmount": cumulative, "unit": CREDIT_UNIT, "resource": resource}
        signed = sign_voucher(unsigned, self._secret_key)
        signature = signed.pop("signature")
        # key order of x402Client.createPaymentPayload: the header bytes are those of the TypeScript client
        payment_payload = {"x402Version": 2, "payload": {"voucher": signed, "signature": signature}, "resource": {"url": resource_url}, "accepted": checked}
        self._spent[epoch] = spent + amount
        return PendingPayment(payment_payload, encode_header(payment_payload), (self.payer, checked["payTo"], epoch), seq, cumulative, amount)

    def on_response(self, pending: PendingPayment, payment_response: Optional[dict]) -> bool:
        """Reads the `PAYMENT-RESPONSE` of the retried request. True: the voucher is an obligation now (state moved).
        False: it was refused or unconfirmed; the budget is returned and, when the server says where it stands (`lastSeq`), the state follows the server,
        so that the caller may sign once more (`resynced` below)."""
        self.resynced = False
        epoch = pending.key[2]
        if isinstance(payment_response, dict) and payment_response.get("success") is True:
            self.store.commit(*pending.key, pending.seq, pending.cumulative)
            return True
        self._spent[epoch] = max(0, self.spent_in_epoch(epoch) - pending.amount)
        ext = (payment_response or {}).get("extensions", {}) if isinstance(payment_response, dict) else {}
        ext = ext.get("x207") if isinstance(ext, dict) else None
        if isinstance(ext, dict) and is_int(ext.get("epoch"), 1) and is_int(ext.get("lastSeq"), 0) and is_uint_string(ext.get("lastCumulativeAmount")):
            self.store.commit(pending.key[0], pending.key[1], ext["epoch"], ext["lastSeq"], ext["lastCumulativeAmount"])
            self.resynced = True
        return False

    resynced = False
