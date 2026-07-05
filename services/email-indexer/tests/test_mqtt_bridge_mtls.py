"""WARP-235 — mqtt_bridge must speak mTLS to the broker.

Identity is the client certificate CN ("email-indexer"), issued by the
WARP-236 internal CA; the shared username/password pair is retired. MQTT_TLS=1
(the compose default) attaches the DROPLET_TLS_* bundle via the shared
_shared/internal_tls helper; MQTT_TLS=0 keeps a plaintext dev connection.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # service dir
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # services/ for _shared


def _fresh_bridge(monkeypatch, tmp_path, tls: str):
    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
    monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
    monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))
    monkeypatch.setenv("MQTT_HOST", "broker")
    monkeypatch.setenv("MQTT_PORT", "8883" if tls == "1" else "1883")
    monkeypatch.setenv("MQTT_TLS", tls)
    import mqtt_bridge

    return importlib.reload(mqtt_bridge)


class _FakePaho:
    recorded: dict = {}

    def __init__(self, *a, **kw):
        pass

    def tls_set(self, ca_certs=None, certfile=None, keyfile=None):
        _FakePaho.recorded["tls"] = (ca_certs, certfile, keyfile)

    def username_pw_set(self, *a):
        _FakePaho.recorded["userpass"] = True

    def connect(self, host, port, keepalive=30):
        _FakePaho.recorded["connect"] = (host, port)

    def loop_start(self):
        pass


def test_mqtt_tls_enabled_presents_bundle_and_no_userpass(monkeypatch, tmp_path):
    bridge = _fresh_bridge(monkeypatch, tmp_path, tls="1")
    _FakePaho.recorded = {}
    monkeypatch.setattr(bridge.mqtt, "Client", _FakePaho)
    monkeypatch.setattr(bridge, "_client", None, raising=True)

    bridge.start()

    assert _FakePaho.recorded["connect"] == ("broker", 8883)
    assert _FakePaho.recorded["tls"] == (
        str(tmp_path / "ca.pem"),
        str(tmp_path / "cert.pem"),
        str(tmp_path / "key.pem"),
    )
    assert "userpass" not in _FakePaho.recorded


def test_mqtt_tls_disabled_stays_plaintext(monkeypatch, tmp_path):
    bridge = _fresh_bridge(monkeypatch, tmp_path, tls="0")
    _FakePaho.recorded = {}
    monkeypatch.setattr(bridge.mqtt, "Client", _FakePaho)
    monkeypatch.setattr(bridge, "_client", None, raising=True)

    bridge.start()

    assert _FakePaho.recorded["connect"] == ("broker", 1883)
    assert "tls" not in _FakePaho.recorded
    assert "userpass" not in _FakePaho.recorded
