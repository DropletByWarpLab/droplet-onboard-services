"""WARP-868 — UbusClient transport rigor.

uhttpd resets connections under concurrent load (stock max_requests=3 vs the
orchestrator's network-summary fan-out), and a reset during the response read
surfaces as a NAKED ConnectionResetError — an OSError that is NOT a URLError.
The old `except URLError` let it escape the SDK, so FastAPI answered an
untyped 500 instead of the typed 503 the dashboard knows how to soften
(observed live on the .87 box, 2026-06-11: ConnectionResetError storms while
/dhcp/leases and the wizard's DDNS write 500'd).

Contract pinned here:
  - one bounded retry on a transport failure (transient reset rides out);
  - a persistent transport failure maps to ConnectionLost (→ 503), never a
    raw OSError;
  - truncated/garbage JSON (mid-read reset) also maps to ConnectionLost;
  - batch_call shares the same behaviour;
  - a clean response is returned untouched (no retry).
"""

from __future__ import annotations

import io
import json
from contextlib import contextmanager

import pytest

import droplet_openwrt_sdk as sdk
from droplet_openwrt_sdk import ConnectionLost, UbusClient


def _ok_response(body: object):
    """A minimal context-manager mimicking urlopen's response object."""

    @contextmanager
    def cm():
        yield io.BytesIO(json.dumps(body).encode("utf-8"))

    return cm()


@pytest.fixture(autouse=True)
def fast_retry(monkeypatch: pytest.MonkeyPatch):
    """The single bounded retry sleeps 0.1s — zero it for the test run."""
    monkeypatch.setattr(sdk.time, "sleep", lambda _s: None)


def test_reset_then_success_is_retried_once(monkeypatch: pytest.MonkeyPatch):
    calls: list[int] = []

    def fake_urlopen(req, timeout=None):
        calls.append(1)
        if len(calls) == 1:
            raise ConnectionResetError(104, "Connection reset by peer")
        return _ok_response({"jsonrpc": "2.0", "id": 1, "result": [0, {"ok": True}]})

    monkeypatch.setattr(sdk, "urlopen", fake_urlopen)
    client = UbusClient("127.0.0.1", 8181)
    result = client.call("0" * 32, "session", "login", {})
    assert result == {"ok": True}
    assert len(calls) == 2  # initial + exactly one retry


def test_persistent_reset_maps_to_connection_lost(monkeypatch: pytest.MonkeyPatch):
    calls: list[int] = []

    def fake_urlopen(req, timeout=None):
        calls.append(1)
        raise ConnectionResetError(104, "Connection reset by peer")

    monkeypatch.setattr(sdk, "urlopen", fake_urlopen)
    client = UbusClient("127.0.0.1", 8181)
    with pytest.raises(ConnectionLost):
        client.raw_call("call", ["0" * 32, "uci", "get", {}])
    assert len(calls) == 2  # bounded: never a third attempt


def test_timeout_maps_to_connection_lost(monkeypatch: pytest.MonkeyPatch):
    def fake_urlopen(req, timeout=None):
        raise TimeoutError("timed out")

    monkeypatch.setattr(sdk, "urlopen", fake_urlopen)
    client = UbusClient("127.0.0.1", 8181)
    with pytest.raises(ConnectionLost):
        client.raw_call("call", ["0" * 32, "uci", "get", {}])


def test_truncated_json_maps_to_connection_lost(monkeypatch: pytest.MonkeyPatch):
    @contextmanager
    def truncated():
        yield io.BytesIO(b'{"jsonrpc": "2.0", "id": 1, "resu')

    monkeypatch.setattr(sdk, "urlopen", lambda req, timeout=None: truncated())
    client = UbusClient("127.0.0.1", 8181)
    with pytest.raises(ConnectionLost):
        client.raw_call("call", ["0" * 32, "uci", "get", {}])


def test_batch_call_retries_reset_and_returns_in_order(
    monkeypatch: pytest.MonkeyPatch,
):
    calls: list[int] = []

    def fake_urlopen(req, timeout=None):
        calls.append(1)
        if len(calls) == 1:
            raise ConnectionResetError(104, "Connection reset by peer")
        sent = json.loads(req.data.decode("utf-8"))
        # Answer out of order to exercise the by-id reassembly.
        responses = [
            {"jsonrpc": "2.0", "id": p["id"], "result": [0, {"n": p["id"]}]}
            for p in reversed(sent)
        ]
        return _ok_response(responses)

    monkeypatch.setattr(sdk, "urlopen", fake_urlopen)
    client = UbusClient("127.0.0.1", 8181)
    out = client.batch_call(
        "0" * 32,
        [("uci", "get", {}), ("uci", "get", {}), ("uci", "get", {})],
    )
    assert [o["n"] for o in out] == sorted(o["n"] for o in out)
    assert len(calls) == 2


def test_batch_call_tolerates_idless_response_elements(
    monkeypatch: pytest.MonkeyPatch,
):
    """rpcd can emit bare error objects without an "id" key in a batch
    response. The by-id reassembly must skip them, not KeyError."""

    def fake_urlopen(req, timeout=None):
        sent = json.loads(req.data.decode("utf-8"))
        responses = [
            {"jsonrpc": "2.0", "id": p["id"], "result": [0, {"n": p["id"]}]}
            for p in sent
        ]
        # Bare error object, no "id" — as rpcd emits for malformed members.
        responses.append(
            {"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid request"}}
        )
        return _ok_response(responses)

    monkeypatch.setattr(sdk, "urlopen", fake_urlopen)
    client = UbusClient("127.0.0.1", 8181)
    out = client.batch_call("0" * 32, [("uci", "get", {}), ("uci", "get", {})])
    assert len(out) == 2


def test_batch_call_idless_element_replacing_response_is_typed_error(
    monkeypatch: pytest.MonkeyPatch,
):
    """If an id-less error object stands in for a request's response, the
    missing match must surface as the typed UbusError, never a KeyError."""

    def fake_urlopen(req, timeout=None):
        sent = json.loads(req.data.decode("utf-8"))
        responses = [
            {"jsonrpc": "2.0", "id": sent[0]["id"], "result": [0, {}]},
            {"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid request"}},
        ]
        return _ok_response(responses)

    monkeypatch.setattr(sdk, "urlopen", fake_urlopen)
    client = UbusClient("127.0.0.1", 8181)
    with pytest.raises(sdk.UbusError, match="Missing response"):
        client.batch_call("0" * 32, [("uci", "get", {}), ("uci", "get", {})])


def test_clean_response_needs_no_retry(monkeypatch: pytest.MonkeyPatch):
    calls: list[int] = []

    def fake_urlopen(req, timeout=None):
        calls.append(1)
        return _ok_response({"jsonrpc": "2.0", "id": 1, "result": [0, {}]})

    monkeypatch.setattr(sdk, "urlopen", fake_urlopen)
    client = UbusClient("127.0.0.1", 8181)
    client.raw_call("call", ["0" * 32, "system", "board", {}])
    assert len(calls) == 1
