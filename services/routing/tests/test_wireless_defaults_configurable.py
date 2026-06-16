"""NET-02 — wireless radio/iface/device defaults are configurable, not host-hardcoded.

The historical `radio0` / `default_radio0` / `wlan0` literals don't exist on
the shipped router host (MT7922 → `radio3` / `default_radio3`) nor on a
single-box (`wlp14s0`/similar). These defaults must come from the deployment
env (`DROPLET_WIFI_RADIO`, `DROPLET_WIFI_IFACE_SECTION`,
`DROPLET_WIFI_SCAN_DEVICE`), falling back to the literal only when unset, and
an explicit per-request/-call value must always win.

`schemas` reads its env defaults at import time, so the env-override cases
reload the module under a patched environment.
"""

import importlib
import os
from unittest import mock

import pytest

import droplet_openwrt_sdk as sdk


class _CapturingRouter:
    """Records the args dict each `_call` receives so we can assert `device`."""

    def __init__(self):
        self.last_args: dict | None = None

    def _call(self, obj, method, args=None):
        self.last_args = args
        # iwinfo scan returns {"results": [...]}, info returns a dict.
        return {"results": []}


# --- SDK scan/info device resolution (DROPLET_WIFI_SCAN_DEVICE) ---

def test_scan_explicit_device_wins():
    r = _CapturingRouter()
    sdk.WirelessApi(r).scan("radio3")
    assert r.last_args == {"device": "radio3"}


def test_scan_falls_back_to_literal_when_env_unset(monkeypatch):
    monkeypatch.delenv("DROPLET_WIFI_SCAN_DEVICE", raising=False)
    r = _CapturingRouter()
    sdk.WirelessApi(r).scan()
    assert r.last_args == {"device": "wlan0"}


def test_scan_uses_env_when_set(monkeypatch):
    monkeypatch.setenv("DROPLET_WIFI_SCAN_DEVICE", "wlp14s0")
    r = _CapturingRouter()
    sdk.WirelessApi(r).scan()
    assert r.last_args == {"device": "wlp14s0"}


def test_scan_falls_back_to_literal_when_env_set_but_empty(monkeypatch):
    # The single-box compose passes `DROPLET_WIFI_SCAN_DEVICE=${...:-}` so on a
    # blank `.env` the routing container receives the var set-but-empty (""). A
    # bare os.environ.get(key, "wlan0") would return "" here (the default only
    # fires when the key is ABSENT), and iwinfo scan {"device": ""} raises ubus
    # INVALID_ARGUMENT. Empty must coalesce to the literal, same as unset.
    monkeypatch.setenv("DROPLET_WIFI_SCAN_DEVICE", "")
    r = _CapturingRouter()
    sdk.WirelessApi(r).scan()
    assert r.last_args == {"device": "wlan0"}


def test_scan_falls_back_to_literal_when_env_whitespace_only(monkeypatch):
    # A whitespace-only value (e.g. a stray space in the env file) is just as
    # invalid for iwinfo as empty — it must also fall back to the literal.
    monkeypatch.setenv("DROPLET_WIFI_SCAN_DEVICE", "   ")
    r = _CapturingRouter()
    sdk.WirelessApi(r).scan()
    assert r.last_args == {"device": "wlan0"}


def test_radio_info_uses_env_when_set(monkeypatch):
    monkeypatch.setenv("DROPLET_WIFI_SCAN_DEVICE", "phy1-ap0")
    r = _CapturingRouter()
    sdk.WirelessApi(r).radio_info()
    assert r.last_args == {"device": "phy1-ap0"}


def test_connected_clients_uses_env_when_set(monkeypatch):
    monkeypatch.setenv("DROPLET_WIFI_SCAN_DEVICE", "wlp14s0")
    r = _CapturingRouter()
    sdk.WirelessApi(r).connected_clients()
    assert r.last_args == {"device": "wlp14s0"}


# --- Schema radio/iface-section defaults (DROPLET_WIFI_*) ---

def _reload_schemas(env: dict):
    with mock.patch.dict(os.environ, env, clear=False):
        import schemas
        return importlib.reload(schemas)


def test_schema_defaults_fall_back_to_literals_when_env_unset():
    env = {
        k: v for k, v in os.environ.items()
        if k not in {"DROPLET_WIFI_RADIO", "DROPLET_WIFI_IFACE_SECTION"}
    }
    with mock.patch.dict(os.environ, env, clear=True):
        import schemas
        schemas = importlib.reload(schemas)
        try:
            assert schemas.SetSsidRequest(ssid="x").radio == "radio0"
            assert schemas.SetSsidRequest(ssid="x").iface_section == "default_radio0"
            assert schemas.SetChannelRequest(channel="36").radio_section == "radio0"
            assert schemas.ApApproveRequest(ssid="x", encryption_key="12345678").radio == "radio0"
        finally:
            importlib.reload(schemas)


def test_schema_defaults_follow_env_for_shipped_radio3_shape():
    schemas = _reload_schemas(
        {"DROPLET_WIFI_RADIO": "radio3", "DROPLET_WIFI_IFACE_SECTION": "default_radio3"}
    )
    try:
        assert schemas.SetSsidRequest(ssid="x").radio == "radio3"
        assert schemas.SetSsidRequest(ssid="x").iface_section == "default_radio3"
        assert schemas.SetPasswordRequest(password="pw12345678").iface_section == "default_radio3"
        assert schemas.SetChannelRequest(channel="149").radio_section == "radio3"
        assert schemas.CreateGuestNetworkRequest(ssid="g", password="pw12345678").radio == "radio3"
        assert schemas.ApApproveRequest(ssid="x", encryption_key="12345678").radio == "radio3"
    finally:
        importlib.reload(schemas)


def test_schema_explicit_value_overrides_env():
    schemas = _reload_schemas({"DROPLET_WIFI_RADIO": "radio3"})
    try:
        # An explicit caller-supplied radio must always win over the env default.
        assert schemas.SetSsidRequest(radio="radio9", ssid="x").radio == "radio9"
    finally:
        importlib.reload(schemas)
