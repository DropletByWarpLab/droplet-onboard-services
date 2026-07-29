"""WARP-1639 — device-bridge's rack-panel console handback.

POST /panel/console is the privileged half of the panel's debug button: it
starts droplet-panel-console.service (root oneshot) to hand the framebuffer
back to the kernel console. The bridge itself cannot do the work — it runs as
`droplet` under NoNewPrivileges, and both writing /sys/class/vtconsole/*/bind
and calling chvt need root.

Two properties matter enough to pin:
  1. it is AUTH-GATED (the bridge can be LAN-reachable with BRIDGE_BIND=0.0.0.0,
     and "anyone on the LAN can drop the status screen to a login prompt" is
     not a posture we want), and
  2. there is NO reverse route — taking the console AWAY from an operator must
     not be remotely triggerable, since that is the exact failure the whole
     recovery path exists to prevent.

Lives in scripts/test/pytest/ rather than services/oled-display/tests/ on
purpose: oled-display is ci-coverage-exempt as hardware-only and its suite runs
in NO workflow, so a test placed there would never guard anything. device-bridge
is stdlib-only, so it imports cleanly in this conftest-free home.

Loader mirrors test_device_bridge_mtls.py (hyphenated filename => importlib).
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_BRIDGE_PATH = (Path(__file__).resolve().parents[3]
                / "services" / "oled-display" / "device-bridge.py")


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location("device_bridge_panel_test",
                                                  _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_starts_the_console_unit_start_verb_only(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    calls = []
    monkeypatch.setattr(bridge, "_run",
                        lambda cmd, timeout=15: (calls.append(cmd), (0, "", ""))[1])

    ok, info = bridge.run_panel_console()

    assert ok is True
    assert calls == [["systemctl", "start", "droplet-panel-console.service"]]
    assert "console" in str(info).lower()


def test_polkit_denial_surfaces_the_real_message(monkeypatch):
    """The caller is a person standing at a rack trying to get a prompt.
    Flattening this to "failed" would strand them."""
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run", lambda cmd, timeout=15: (
        1, "", "Failed to start droplet-panel-console.service: Access denied"))

    ok, info = bridge.run_panel_console()
    assert ok is False
    assert "Access denied" in info


def test_never_raises_when_systemctl_is_missing(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def boom(cmd, timeout=15):
        raise FileNotFoundError("systemctl")

    monkeypatch.setattr(bridge, "_run", boom)
    ok, info = bridge.run_panel_console()
    assert ok is False and isinstance(info, str)


def test_unit_name_is_overridable(monkeypatch):
    bridge = _load_bridge(
        monkeypatch, {"DROPLET_PANEL_CONSOLE_UNIT": "custom-panel.service"})
    calls = []
    monkeypatch.setattr(bridge, "_run",
                        lambda cmd, timeout=15: (calls.append(cmd), (0, "", ""))[1])
    bridge.run_panel_console()
    assert calls[0][-1] == "custom-panel.service"


def test_route_is_auth_gated():
    """Guard against the route ever being added to the pre-auth section."""
    src = _BRIDGE_PATH.read_text(encoding="utf-8")
    idx = src.index('if self.path == "/panel/console":')
    window = src[idx:idx + 900]
    assert "self._authed()" in window
    assert "401" in window


def test_there_is_no_remote_claim_route():
    """Handing the panel back TO the display service must stay host-only."""
    src = _BRIDGE_PATH.read_text(encoding="utf-8")
    code = "\n".join(ln for ln in src.splitlines()
                     if not ln.lstrip().startswith("#"))
    assert "droplet-panel-claim.service" not in code
    assert '"/panel/claim"' not in code


def test_polkit_rule_grants_start_only_on_the_console_unit():
    rule = (_BRIDGE_PATH.parent / "50-droplet-device-bridge.rules").read_text(
        encoding="utf-8")
    # Assert on the RULE, not the file: the header comment legitimately names
    # the claim unit while explaining why it is deliberately not granted.
    code = "\n".join(ln for ln in rule.splitlines()
                     if not ln.lstrip().startswith("//"))
    assert "droplet-panel-console.service" in code
    assert 'action.lookup("verb") === "start"' in code
    # The claim unit must never be reachable through polkit.
    assert "droplet-panel-claim.service" not in code
