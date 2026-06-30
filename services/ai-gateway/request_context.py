"""WARP-108 — request-id context + logging integration for the AI gateway.

A ContextVar holds the current request id; a logging Filter stamps it onto
every record (all module loggers propagate to the root handler, so installing
the filter+formatter once covers the whole service).
"""
from __future__ import annotations

import logging
import re
import uuid
from contextvars import ContextVar

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_NO_CONTEXT = "no-request-context"

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)


def new_request_id() -> str:
    return str(uuid.uuid4())


def sanitize_request_id(raw: str | None) -> str | None:
    if not isinstance(raw, str):
        return None
    return raw if _REQUEST_ID_RE.match(raw) else None


def get_request_id() -> str | None:
    return request_id_var.get()


def set_request_id(value: str) -> None:
    request_id_var.set(value)


class RequestIdFilter(logging.Filter):
    """Attach `request_id` to every record (or the no-context marker)."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get() or _NO_CONTEXT
        return True


def configure_logging(level: int = logging.INFO) -> None:
    """Install the request-id filter + formatter on the root handler. Idempotent."""
    root = logging.getLogger()
    root.setLevel(level)
    if not root.handlers:
        root.addHandler(logging.StreamHandler())
    fmt = "%(asctime)s %(levelname)s [%(name)s] [request_id=%(request_id)s] %(message)s"
    formatter = logging.Formatter(fmt)
    for handler in root.handlers:
        # Avoid stacking duplicate filters on repeat calls.
        if not any(isinstance(f, RequestIdFilter) for f in handler.filters):
            handler.addFilter(RequestIdFilter())
        handler.setFormatter(formatter)
