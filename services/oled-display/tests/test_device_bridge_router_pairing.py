"""Unit tests for the device-bridge router-pairing boundary (ADR-071 slice B).

POST /host/router-pairing {target, password} is how the orchestrator persists the
password routing just claimed from a freshly-flashed router. The bridge runs as
the unprivileged `droplet` user, so it never writes docker/secrets itself: it
spools {target, password} into its tmpfs RuntimeDirectory and `systemctl start`s
droplet-pair-apply.service (polkit, start verb only).

Pinned here:
  - destructive class: the admin token only, the panel token is refused;
  - strict validation BEFORE anything is spooled (target enum, exactly 32
    lowercase hex), junk is a 400 and the unit is never started;
  - the spool is 0600 in a 0700 dir and holds exactly {target, password};
  - the unit is started with the exact argv and the request is gone afterwards,
    on success AND on failure;
  - the password never reaches a log line or a response body.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import stat
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"
_IS_POSIX = os.name == "posix"

PANEL = "panel-token-not-admin"
ADMIN = "admin-token-not-panel"
_UNIT = "droplet-pair-apply.service"
PASSWORD = "0123456789abcdef0123456789abcdef"


class _FakeHeaders(dict):
    def get(self, k, default=None):
        for key, val in self.items():
            if key.lower() == k.lower():
                return val
        return default


class _FakeRfile:
    def __init__(self, body: bytes):
        self._body = body

    def read(self, n):
        return self._body[:n]


class _FakeHandler:
    def __init__(self, bridge, headers, path, body: bytes = b""):
        self.headers = _FakeHeaders(headers)
        self.rfile = _FakeRfile(body)
        self.path = path
        self.command = "POST"
        self.sent: list[tuple[int, object]] = []
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)
        self.do_POST = bridge.Handler.do_POST.__get__(self, bridge.Handler)
        self._dispatch_post = bridge.Handler._dispatch_post.__get__(self, bridge.Handler)

    def _send(self, status, obj):
        self.sent.append((status, obj))


def _post(bridge, payload, *, token=ADMIN, raw=None):
    body = raw if raw is not None else json.dumps(payload).encode()
    headers = {"Content-Length": str(len(body))}
    if token:
        headers["X-Droplet-Auth"] = token
    h = _FakeHandler(bridge, headers, "/host/router-pairing", body)
    h.do_POST()
    assert h.sent, "handler did not send a response"
    return h.sent[-1]


@pytest.fixture
def bridge(monkeypatch, tmp_path):
    for k in ("BRIDGE_AUTH_TOKEN", "BRIDGE_ADMIN_TOKEN", "SERVICE_TOKEN_DISPLAY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", PANEL)
    monkeypatch.setenv("BRIDGE_ADMIN_TOKEN", ADMIN)
    monkeypatch.setenv("DROPLET_PAIR_SPOOL_DIR", str(tmp_path / "pair-spool"))
    monkeypatch.setenv("DROPLET_PAIR_APPLY_UNIT", _UNIT)
    spec = importlib.util.spec_from_file_location("device_bridge_pairing_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeHost:
    """Replaces bridge._run; plays systemctl + the root unit's read of the spool."""

    def __init__(self, bridge, spool: Path):
        self.spool = spool
        self.calls: list[list[str]] = []
        self.requests: list[dict] = []
        self.modes: list[int] = []
        self.dir_modes: list[int] = []
        self.rc = 0
        self.err = ""
        self.consume = True

    def __call__(self, cmd, timeout=15):
        self.calls.append(list(cmd))
        assert cmd == ["systemctl", "start", _UNIT], "unexpected command: %r" % (cmd,)
        req = self.spool / "request.json"
        assert req.exists(), "bridge must spool the request before starting the unit"
        if _IS_POSIX:
            self.modes.append(stat.S_IMODE(req.stat().st_mode))
            self.dir_modes.append(stat.S_IMODE(self.spool.stat().st_mode))
        self.requests.append(json.loads(req.read_text()))
        if self.rc != 0:
            return self.rc, "", self.err
        if self.consume:
            req.unlink()  # the root unit consumes (zeroes + unlinks) the spool
        return 0, "", ""


@pytest.fixture
def host(bridge, monkeypatch, tmp_path):
    h = FakeHost(bridge, tmp_path / "pair-spool")
    monkeypatch.setattr(bridge, "_run", h)
    return h


def test_route_is_destructive_and_refuses_the_panel_token(bridge, host):
    assert bridge.ROUTE_CLASSES[("POST", "/host/router-pairing")] == "destructive"
    status, body = _post(bridge, {"target": "router", "password": PASSWORD}, token=PANEL)
    assert status == 401
    assert host.calls == []


def test_missing_token_is_refused(bridge, host):
    status, _ = _post(bridge, {"target": "router", "password": PASSWORD}, token=None)
    assert status == 401
    assert host.calls == []


@pytest.mark.parametrize("target", ["router", "ap", "switch"])
def test_valid_request_spools_then_starts_the_unit(bridge, host, target):
    status, body = _post(bridge, {"target": target, "password": PASSWORD})
    assert (status, body) == (200, {"ok": True})
    assert host.calls == [["systemctl", "start", _UNIT]]
    assert host.requests == [{"target": target, "password": PASSWORD}]
    if _IS_POSIX:
        assert host.modes == [0o600]
        assert host.dir_modes == [0o700]


def test_spool_is_gone_after_success(bridge, host):
    _post(bridge, {"target": "router", "password": PASSWORD})
    assert not (host.spool / "request.json").exists()
    assert not (host.spool / "request.json.tmp").exists()


@pytest.mark.parametrize("payload", [
    {},
    {"target": "router"},
    {"password": PASSWORD},
    {"target": "gateway", "password": PASSWORD},
    {"target": "ROUTER", "password": PASSWORD},
    {"target": ["router"], "password": PASSWORD},
    {"target": "router", "password": PASSWORD[:-1]},
    {"target": "router", "password": PASSWORD + "0"},
    {"target": "router", "password": PASSWORD.upper()},
    {"target": "router", "password": "g" * 32},
    {"target": "router", "password": PASSWORD + "\n"},
    {"target": "router", "password": 12345678901234567890123456789012},
    {"target": "router", "password": None},
])
def test_invalid_requests_are_400_and_nothing_is_spooled_or_started(bridge, host, payload):
    status, body = _post(bridge, payload)
    assert status == 400
    assert body["ok"] is False
    assert host.calls == []
    assert not (host.spool / "request.json").exists()


def test_non_object_and_bad_json_bodies_are_400(bridge, host):
    assert _post(bridge, None, raw=b"[1,2]")[0] == 400
    assert _post(bridge, None, raw=b"{not json")[0] == 400
    assert host.calls == []


def test_failed_unit_start_is_502_and_the_request_is_removed(bridge, host):
    host.rc = 1
    host.err = "Access denied"
    status, body = _post(bridge, {"target": "router", "password": PASSWORD})
    assert status == 502
    assert body["code"] == "executor_failed"
    assert "Access denied" in body["error"]
    assert not (host.spool / "request.json").exists()
    assert PASSWORD not in json.dumps(body)


def test_request_left_behind_by_a_unit_that_did_not_consume_it_is_wiped(bridge, host):
    host.consume = False
    status, _ = _post(bridge, {"target": "router", "password": PASSWORD})
    assert status == 200
    assert not (host.spool / "request.json").exists()


def test_password_never_reaches_logs_or_responses(bridge, host, caplog):
    caplog.set_level(logging.DEBUG)
    results = [
        _post(bridge, {"target": "router", "password": PASSWORD}),
        _post(bridge, {"target": "bogus", "password": PASSWORD}),
    ]
    host.rc = 1
    host.err = "boom"
    results.append(_post(bridge, {"target": "ap", "password": PASSWORD}))
    for _status, body in results:
        assert PASSWORD not in json.dumps(body)
    assert PASSWORD not in caplog.text
    for call in host.calls:
        assert PASSWORD not in " ".join(call)


def test_concurrent_request_is_refused_with_409(bridge, host):
    assert bridge._PAIR_LOCK.acquire(blocking=False)
    try:
        status, body = _post(bridge, {"target": "router", "password": PASSWORD})
    finally:
        bridge._PAIR_LOCK.release()
    assert status == 409
    assert body["code"] == "busy"
    assert host.calls == []
