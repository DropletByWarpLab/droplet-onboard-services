"""Structlog setup + per-request correlation-ID middleware.

JSON renderer when LOG_FORMAT=json (production), console renderer otherwise (dev).
A `CorrelationIdMiddleware` ASGI middleware reads or generates a trace_id per
request and stores it in a ContextVar; the structlog processor adds it to every
log line. An httpx event hook propagates it as ``X-Request-ID`` to Ollama.
"""

from __future__ import annotations

import logging
import os
import sys
import uuid
from contextvars import ContextVar
from typing import Any, Awaitable, Callable

import httpx
import structlog

trace_id_var: ContextVar[str | None] = ContextVar("trace_id", default=None)


def _add_trace_id(_logger: Any, _method: str, event_dict: dict) -> dict:
    """Structlog processor: copy the request-scoped trace_id into the log record."""
    tid = trace_id_var.get()
    if tid is not None:
        event_dict["trace_id"] = tid
    return event_dict


def configure_structlog() -> None:
    """Configure structlog for the app. Idempotent."""
    fmt = os.getenv("LOG_FORMAT", "json").lower()
    level_name = os.getenv("LOG_LEVEL", "info").upper()
    level = getattr(logging, level_name, logging.INFO)

    logging.basicConfig(stream=sys.stdout, level=level, format="%(message)s")

    if fmt == "json":
        renderer = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer()

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            _add_trace_id,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )


class CorrelationIdMiddleware:
    """ASGI middleware that injects a per-request trace_id ContextVar.

    Honors an incoming ``X-Request-ID`` header from upstream callers
    (the orchestrator) so logs correlate across the whole hop.
    """

    def __init__(self, app: Callable[..., Awaitable[None]]):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        incoming = headers.get(b"x-request-id")
        trace_id = incoming.decode() if incoming else uuid.uuid4().hex[:16]
        token = trace_id_var.set(trace_id)
        try:
            await self.app(scope, receive, send)
        finally:
            trace_id_var.reset(token)


async def propagate_trace_id_hook(request: httpx.Request) -> None:
    """httpx event hook: stamp X-Request-ID on outbound requests when set."""
    tid = trace_id_var.get()
    if tid:
        request.headers["X-Request-ID"] = tid


def get_logger(name: str | None = None) -> Any:
    """Convenience accessor used by other modules."""
    return structlog.get_logger(name) if name else structlog.get_logger()
