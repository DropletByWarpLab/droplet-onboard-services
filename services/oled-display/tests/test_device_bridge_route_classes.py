"""device-bridge token split (WARP-3595).

The display container holds the panel token (BRIDGE_AUTH_TOKEN); only the
orchestrator holds the admin token (BRIDGE_ADMIN_TOKEN). ROUTE_CLASSES is the one
table that classifies every route as open / read / write / destructive.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"
PANEL = "panel-token-not-admin"
ADMIN = "admin-token-not-panel"


def _load(monkeypatch, env=None):
    env = {"BRIDGE_AUTH_TOKEN": PANEL, "BRIDGE_ADMIN_TOKEN": ADMIN, **(env or {})}
    for k in ("BRIDGE_AUTH_TOKEN", "BRIDGE_ADMIN_TOKEN", "SERVICE_TOKEN_DISPLAY",
              "DEVICE_SECRET_KEY", "SERVICE_SECRET"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location("device_bridge_classes", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _H:
    def __init__(self, bridge, method, path, token):
        self.headers = {"X-Droplet-Auth": token} if token else {}
        self.command = method
        self.path = path
        self.authed = bridge.Handler._authed.__get__(self, bridge.Handler)


def _ok(bridge, method, path, token):
    return _H(bridge, method, path, token).authed()


def test_every_route_in_the_handlers_has_a_class(monkeypatch):
    """Fails when a route literal is added to Handler without a ROUTE_CLASSES row."""
    bridge = _load(monkeypatch)
    src = _BRIDGE_PATH.read_text()
    start = src.index("class Handler(")
    literals = set(re.findall(r'(?:path|self\.path) == "(/[^"]*)"', src[start:]))
    if re.search(r'startswith\("/drives/"\)', src[start:]):
        literals.add("/drives/{uuid}/eject")
    classified = {p for (_m, p) in bridge.ROUTE_CLASSES}
    assert literals - classified == set(), (
        "route(s) served without a ROUTE_CLASSES entry: %s" % sorted(literals - classified))
    assert classified - literals == set(), (
        "ROUTE_CLASSES entry for a route no handler serves: %s" % sorted(classified - literals))
    assert set(bridge.ROUTE_CLASSES.values()) <= {"open", "read", "write", "destructive"}


@pytest.mark.parametrize("route", [
    ("POST", "/system/factory-reset"), ("POST", "/pools/command"),
    ("POST", "/openwrt/wifi/hostapd"), ("POST", "/openwrt/wifi/guest"),
    ("DELETE", "/openwrt/wifi/guest"), ("POST", "/tls/reload"),
    ("POST", "/tls/bootstrap-refresh"), ("POST", "/host/public-fqdn"),
    ("POST", "/host/box-name"), ("POST", "/drives/abc-123/eject"),
])
def test_destructive_routes_refuse_the_panel_token(monkeypatch, route):
    bridge = _load(monkeypatch)
    assert _ok(bridge, *route, PANEL) is False
    assert _ok(bridge, *route, ADMIN) is True


@pytest.mark.parametrize("route", [
    ("GET", "/wifi"), ("GET", "/openwrt/qr"), ("GET", "/drives"), ("GET", "/pools"),
    ("POST", "/panel/console"), ("POST", "/openwrt/wifi/rotate"),
    ("POST", "/wifi/connect"), ("POST", "/drives/changed"),
])
def test_panel_routes_accept_both_tokens(monkeypatch, route):
    bridge = _load(monkeypatch)
    assert _ok(bridge, *route, PANEL) is True
    assert _ok(bridge, *route, ADMIN) is True
    assert _ok(bridge, *route, "wrong") is False
    assert _ok(bridge, *route, "") is False


def test_unlisted_route_and_unknown_method_are_destructive(monkeypatch):
    bridge = _load(monkeypatch)
    assert bridge._route_class("POST", "/brand/new") == "destructive"
    assert _ok(bridge, "POST", "/brand/new", PANEL) is False
    # A bare handler (no method) gets the strictest class for the path.
    assert bridge._route_class(None, "/openwrt/wifi/guest") == "destructive"


def test_legacy_secrets_are_not_bridge_tokens(monkeypatch):
    """DEVICE_SECRET_KEY and SERVICE_SECRET no longer stand in for the panel token."""
    bridge = _load(monkeypatch, {"DEVICE_SECRET_KEY": "master", "SERVICE_SECRET": "svc"})
    assert bridge.BRIDGE_AUTH_TOKEN == PANEL
    assert _ok(bridge, "GET", "/drives", "master") is False
    assert _ok(bridge, "GET", "/drives", "svc") is False
    only_legacy = _load(monkeypatch, {"BRIDGE_AUTH_TOKEN": "", "BRIDGE_ADMIN_TOKEN": "",
                                      "DEVICE_SECRET_KEY": "master", "SERVICE_SECRET": "svc"})
    assert only_legacy.BRIDGE_AUTH_TOKEN == ""
    assert only_legacy.BRIDGE_ADMIN_TOKEN == ""
    with pytest.raises(RuntimeError):
        only_legacy._boot_banner()


def test_old_env_without_admin_token_keeps_panel_reads_and_refuses_destructive(monkeypatch):
    bridge = _load(monkeypatch, {"BRIDGE_ADMIN_TOKEN": ""})
    assert _ok(bridge, "GET", "/drives", PANEL) is True
    assert _ok(bridge, "POST", "/system/factory-reset", PANEL) is False
    assert _ok(bridge, "POST", "/system/factory-reset", "") is False
    bridge._boot_banner()  # starts (warns), does not raise


def test_display_token_equal_to_admin_token_refuses_to_start(monkeypatch):
    bridge = _load(monkeypatch, {"BRIDGE_ADMIN_TOKEN": PANEL})
    with pytest.raises(RuntimeError):
        bridge._boot_banner()


def test_compose_gives_the_display_container_no_admin_token():
    compose = (Path(__file__).resolve().parents[3] / "docker" / "docker-compose.yml").read_text()
    block = compose[compose.index("\n  oled-display:") + 1:]
    nxt = re.search(r"\n  [a-z0-9-]+:\n", block)
    block = block[:nxt.start()] if nxt else block
    assert "SERVICE_TOKEN_BRIDGE" not in block and "BRIDGE_ADMIN_TOKEN" not in block
