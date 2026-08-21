"""Tests for structlog + correlation-ID middleware."""

from __future__ import annotations

import json
import os
import sys
from io import StringIO
from pathlib import Path

import pytest
import structlog

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture(autouse=True)
def _reset_structlog():
    structlog.reset_defaults()
    yield
    structlog.reset_defaults()


def test_configure_structlog_json(monkeypatch):
    """JSON renderer when LOG_FORMAT=json."""
    monkeypatch.setenv("LOG_FORMAT", "json")

    from logging_config import configure_structlog, trace_id_var
    configure_structlog()

    log = structlog.get_logger()
    token = trace_id_var.set("abcd1234")
    try:
        out = StringIO()
        with monkeypatch.context() as m:
            m.setattr("sys.stdout", out)
            log.info("hello", model="llama3.2:3b")
        line = out.getvalue().strip().splitlines()[-1]
        record = json.loads(line)
        assert record["event"] == "hello"
        assert record["model"] == "llama3.2:3b"
        assert record["trace_id"] == "abcd1234"
        assert "level" in record
        assert "timestamp" in record
    finally:
        trace_id_var.reset(token)


def test_configure_structlog_console(monkeypatch):
    """Console renderer when LOG_FORMAT is not json (default for dev)."""
    monkeypatch.setenv("LOG_FORMAT", "console")

    from logging_config import configure_structlog
    configure_structlog()

    log = structlog.get_logger()
    out = StringIO()
    with monkeypatch.context() as m:
        m.setattr("sys.stdout", out)
        log.info("hello-console", k="v")
    line = out.getvalue().strip().splitlines()[-1]
    # Console renderer produces non-JSON.
    with pytest.raises(json.JSONDecodeError):
        json.loads(line)
    assert "hello-console" in line


@pytest.mark.asyncio
async def test_correlation_id_middleware_uses_incoming_header(monkeypatch):
    """If X-Request-ID is provided, the middleware uses it as trace_id."""
    monkeypatch.setenv("LOG_FORMAT", "json")

    from logging_config import CorrelationIdMiddleware, configure_structlog, trace_id_var
    configure_structlog()

    seen = {}

    async def app(scope, receive, send):
        seen["trace_id"] = trace_id_var.get()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    wrapped = CorrelationIdMiddleware(app)
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/health",
        "headers": [(b"x-request-id", b"req-12345")],
    }
    await wrapped(scope, _noop_receive, _noop_send)
    assert seen["trace_id"] == "req-12345"
    # After request, ContextVar is reset.
    assert trace_id_var.get() is None


@pytest.mark.asyncio
async def test_correlation_id_middleware_generates_when_missing(monkeypatch):
    """Without an incoming header, the middleware generates a 16-char trace_id."""
    monkeypatch.setenv("LOG_FORMAT", "json")

    from logging_config import CorrelationIdMiddleware, configure_structlog, trace_id_var
    configure_structlog()

    seen = {}

    async def app(scope, receive, send):
        seen["trace_id"] = trace_id_var.get()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    wrapped = CorrelationIdMiddleware(app)
    scope = {"type": "http", "method": "GET", "path": "/health", "headers": []}
    await wrapped(scope, _noop_receive, _noop_send)
    assert seen["trace_id"] is not None
    assert len(seen["trace_id"]) == 16
    assert all(c in "0123456789abcdef" for c in seen["trace_id"])


async def _noop_receive():
    return {"type": "http.request", "body": b"", "more_body": False}


async def _noop_send(_):
    pass
