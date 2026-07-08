"""WARP-235 — camera-discovery MQTT over mTLS.

The host-network service dials the broker's loopback TLS publish
(mqtts://localhost:8883) and presents its own bundle (identity = cert CN
"camera-discovery") via the shared _shared/internal_tls helper. Plain mqtt://
URLs (dev broker) keep the old inline-credential path.
"""
from __future__ import annotations


def _fake_paho(recorded):
    class FakePaho:
        def __init__(self, *a, **kw):
            pass

        def tls_set(self, ca_certs=None, certfile=None, keyfile=None):
            recorded["tls"] = (ca_certs, certfile, keyfile)

        def username_pw_set(self, user, password):
            recorded["userpass"] = (user, password)

        def connect(self, host, port, keepalive=60):
            recorded["connect"] = (host, port)

        def loop_start(self):
            pass

    return FakePaho


def test_parse_mqtt_url_flags_mqtts_scheme():
    import main

    assert main._parse_mqtt_url("mqtts://localhost:8883") == (
        "localhost", 8883, None, None, True,
    )
    # port defaults flip on the scheme
    assert main._parse_mqtt_url("mqtts://localhost") == (
        "localhost", 8883, None, None, True,
    )
    assert main._parse_mqtt_url("mqtt://u:p@localhost") == (
        "localhost", 1883, "u", "p", False,
    )


def test_mqtts_connect_presents_bundle_no_userpass(monkeypatch, tmp_path):
    import main

    for name in ("cert", "key", "ca"):
        (tmp_path / f"{name}.pem").write_text("PEM")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(tmp_path / "cert.pem"))
    monkeypatch.setenv("DROPLET_TLS_KEY", str(tmp_path / "key.pem"))
    monkeypatch.setenv("DROPLET_TLS_CA", str(tmp_path / "ca.pem"))
    monkeypatch.setattr(main, "MQTT_BROKER", "mqtts://localhost:8883", raising=True)

    recorded = {}
    monkeypatch.setattr(main.mqtt, "Client", _fake_paho(recorded))
    main._connect_mqtt()

    assert recorded["connect"] == ("localhost", 8883)
    assert recorded["tls"] == (
        str(tmp_path / "ca.pem"),
        str(tmp_path / "cert.pem"),
        str(tmp_path / "key.pem"),
    )
    assert "userpass" not in recorded


def test_plain_mqtt_connect_keeps_userpass(monkeypatch):
    import main

    monkeypatch.setattr(main, "MQTT_BROKER", "mqtt://u:p@localhost:1883", raising=True)

    recorded = {}
    monkeypatch.setattr(main.mqtt, "Client", _fake_paho(recorded))
    main._connect_mqtt()

    assert recorded["connect"] == ("localhost", 1883)
    assert recorded["userpass"] == ("u", "p")
    assert "tls" not in recorded
