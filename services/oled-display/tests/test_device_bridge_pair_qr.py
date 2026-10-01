"""WARP-2954 / ADR-058 — the app-pairing link on the panel's rail.

The bridge computes `droplet://pair?server=https://<lan ip>&spki=<pin>` on the
host from the SAME leaf the gateway serves, so the pin on the glass is byte-
identical to what the orchestrator mints into the dashboard QR and what the
apps compute. These tests pin that identity against an openssl oracle, the
mtime cache, the honest-refusal shapes, and the auth gate on the route.

`device-bridge.py` is not importable by name (hyphen); it is loaded from its
path the way test_device_bridge.py does.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_BRIDGE_PATH = _HERE.parent / "device-bridge.py"

# The house unit's real self-signed bootstrap leaf (public data — any TLS
# client on the LAN sees it), RSA-2048, SANs droplet.local / 192.168.9.195 / …
LEAF_PEM = """-----BEGIN CERTIFICATE-----
MIIDbjCCAlagAwIBAgIUAlSK5TGY8EIKhYF9BpBMUtmUHIYwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTRHJvcGxldCBFZGdlIERldmljZTAeFw0yNjA4MjQwMDE2
NTlaFw0zNjA4MjEwMDE2NTlaMB4xHDAaBgNVBAMME0Ryb3BsZXQgRWRnZSBEZXZp
Y2UwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJTowoqlgJIqh2BWAU
oeF7tWViDbPvgWkQb/GjiiDfy+3mhaYGlME1AUliZ2RFKcfUaZUWl/Hx/m0IB76U
V4sprx+RBOMGkIUQcX+7XlKuLaUsMFfoKtanTgz3QUu6DL5DZmHseODcSckF5alB
Di8JsbQ3XORbs4/k+st+rZ7ixcXq8Ew8YMBWyzRSAOTNyuBIRyubpE2ICXTev9Vt
Cgte5Gfya2XSDyQMe13zCtHQeRTENZrfiMaD6nv7jmP0MemtDUV3MGYS4MT3jONs
GkHINdp/bxCsNS1/xaw+Zsjf2k62HVnUQU6iSFYv4D2GWZ+grCcckzClS3UbbF8C
bpNPAgMBAAGjgaMwgaAwfwYDVR0RBHgwdoIJbG9jYWxob3N0ggdkcm9wbGV0gg1k
cm9wbGV0LmxvY2Fsggtkcm9wbGV0LmxhboIKZHJvcGxldC1haYIQZHJvcGxldC1h
aS5sb2NhbIIOZHJvcGxldC1haS5sYW6HBMCoCcOHBKwRAAGHBH8AAAGHBKwSAAEw
HQYDVR0OBBYEFMcORZ7r953P5iWdsn+jxt8IVQXSMA0GCSqGSIb3DQEBCwUAA4IB
AQAfOcbb8KAdhx0nQ0LAIqjr+dvJGA+aQ7iE0PGS/foH9stCNb0BYUl9u3hw8DeG
iDuqL9xslTLj59q1CXakQp9Nwcabmuz4g0ecvt/bAlp/hr1wufdwMC4sGfQFd5Mm
mdhemY5mWxsJ9qK5T0g8RUrsWVQLvA54arkBrlu1B76U94D4mD4PuqvQgjd94oSh
oBSExYAPhKI1v2xIYyMiyInzx7XLzYJai0lZA2jvzI00Lgl53Gm7OiTZtd3mXTqA
LShUlCL6TPB4psnOIT1WLAi0VRlAmMiPh9O9guVJ+Uk9NoMXFC+3ANSNebfb1KBF
uSd9DJAIdEt6/CNInKDHBh7j
-----END CERTIFICATE-----
"""
# Derived independently of the code under test:
#   openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER \
#     | openssl dgst -sha256 -binary | base64
LEAF_PIN = "8BevqGrXi+1KveZGkPBbe42742sm6cj0EOU2ph498lw="
# WARP-3414 — the same key in READING form, derived independently of the code
# under test from the certificate above:
#   openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER \
#     | openssl dgst -sha256 -binary | xxd -p -c 64 | tr a-f A-F   (grouped in 4s)
# The Droplet Mac app's confirmation-screen format: uppercase hex, 4-char
# groups, single spaces, 16 groups. The orchestrator, the installer output and
# `droplet-fingerprint` pin the very same string against this certificate.
LEAF_FINGERPRINT = ("F017 AFA8 6AD7 8BED 4ABD E646 90F0 5B7B "
                    "8DBB E36B 26E9 C8F4 10E5 36A6 1E3D F25C")

pytestmark = pytest.mark.skipif(shutil.which("openssl") is None,
                                reason="openssl CLI not on PATH")


def _load_bridge(monkeypatch: pytest.MonkeyPatch, cert_path: Path):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    monkeypatch.setenv("DROPLET_TLS_CERT", str(cert_path))
    spec = importlib.util.spec_from_file_location("device_bridge_pair_under_test",
                                                  _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def leaf(tmp_path: Path) -> Path:
    p = tmp_path / "droplet.crt"
    p.write_text(LEAF_PEM, encoding="utf-8")
    return p


def test_the_pin_is_the_standard_spki_pin_of_the_served_leaf(monkeypatch, leaf):
    bridge = _load_bridge(monkeypatch, leaf)
    assert bridge.served_cert_pin() == LEAF_PIN
    # And exactly what the openssl recipe says, recomputed here so the test
    # does not merely agree with a constant the code could have copied.
    pub = subprocess.run(["openssl", "x509", "-in", str(leaf), "-pubkey", "-noout"],
                         capture_output=True, check=True).stdout
    der = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "DER"],
                         input=pub, capture_output=True, check=True).stdout
    import base64, hashlib
    assert base64.b64encode(hashlib.sha256(der).digest()).decode() == LEAF_PIN


def test_a_fullchain_pins_the_leaf_not_the_issuer(monkeypatch, tmp_path):
    # Leaf first, then a second block: the pin must come from the first.
    other = subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt",
         "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", os.devnull,
         "-days", "2", "-subj", "/CN=Not The Droplet"],
        capture_output=True, check=True,
        env={**os.environ, "MSYS_NO_PATHCONV": "1"}).stdout.decode()
    # openssl on Windows emits CRLF and write_text doubles the CR: the bridge
    # must read that too (it re-wraps the body canonically), so the fixture
    # is deliberately left in that state rather than cleaned up here.
    chain = tmp_path / "droplet.crt"
    chain.write_text(LEAF_PEM + other, encoding="utf-8")
    bridge = _load_bridge(monkeypatch, chain)
    assert bridge.served_cert_pin() == LEAF_PIN
    # Sanity: the other block really has a different pin.
    only_other = tmp_path / "other.crt"
    only_other.write_text(other, encoding="utf-8")
    assert bridge.served_cert_pin(str(only_other)) not in (None, LEAF_PIN)


def test_the_pin_follows_a_certificate_swap_via_mtime(monkeypatch, leaf):
    bridge = _load_bridge(monkeypatch, leaf)
    assert bridge.served_cert_pin() == LEAF_PIN
    # Same mtime → cached, even though the body is now unreadable.
    st = leaf.stat()
    leaf.write_text("garbage", encoding="utf-8")
    os.utime(leaf, (st.st_atime, st.st_mtime))
    assert bridge.served_cert_pin() == LEAF_PIN
    # New mtime → recomputed → honest None.
    os.utime(leaf, (time.time() + 5, time.time() + 5))
    assert bridge.served_cert_pin() is None


def test_missing_or_unparseable_leaf_is_none_never_a_throw(monkeypatch, tmp_path):
    bridge = _load_bridge(monkeypatch, tmp_path / "does-not-exist.crt")
    assert bridge.served_cert_pin() is None
    bad = tmp_path / "bad.crt"
    bad.write_text("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
                   encoding="utf-8")
    assert bridge.served_cert_pin(str(bad)) is None


def test_pair_link_is_the_compact_pin_only_form(monkeypatch, leaf):
    """The rail card holds a version-4 code at the scan floor: 78 bytes at
    ECC L. The full dashboard link (~100 bytes) cannot be scanned from the
    glass; the pin-only base64url form is 63 and carries the same key."""
    bridge = _load_bridge(monkeypatch, leaf)
    link = bridge.pair_link(LEAF_PIN)
    assert link == "droplet://pair?spki=8BevqGrXi-1KveZGkPBbe42742sm6cj0EOU2ph498lw"
    assert len(link) <= 78
    # base64url of the SAME 32 bytes the standard pin encodes.
    import base64
    assert base64.urlsafe_b64decode(link.split("spki=")[1] + "=") == base64.b64decode(LEAF_PIN)


def test_snapshot_is_honest_about_why_there_is_no_link(monkeypatch, leaf):
    bridge = _load_bridge(monkeypatch, leaf)
    # No usable LAN address (DHCP pending) → no link, and it says so.
    monkeypatch.setattr(bridge, "uplink_ip_snapshot", lambda: {"uplinkIp": "0.0.0.0"})
    snap = bridge.pair_qr_snapshot()
    assert snap["ok"] is False and "address" in snap["error"]
    # Address but no readable certificate → no link, and it says so.
    monkeypatch.setattr(bridge, "uplink_ip_snapshot", lambda: {"uplinkIp": "192.168.9.195"})
    monkeypatch.setattr(bridge, "served_cert_pin", lambda cert_path=None: None)
    snap = bridge.pair_qr_snapshot()
    assert snap["ok"] is False and "certificate" in snap["error"]


def test_snapshot_carries_the_link_when_both_halves_exist(monkeypatch, leaf):
    bridge = _load_bridge(monkeypatch, leaf)
    monkeypatch.setattr(bridge, "uplink_ip_snapshot", lambda: {"uplinkIp": "192.168.9.195"})
    snap = bridge.pair_qr_snapshot()
    assert snap == {
        "ok": True,
        "server": "https://192.168.9.195",
        "spki": LEAF_PIN,
        "payload": bridge.pair_link(LEAF_PIN),
        # WARP-3414: the reading form of the same pin, for the rail's
        # "Droplet fingerprint" face.
        "fingerprint": LEAF_FINGERPRINT,
    }


def test_the_fingerprint_is_the_mac_apps_format_for_the_known_certificate(monkeypatch, leaf):
    """WARP-3414: uppercase hex, 4-character groups, single spaces, 16 groups —
    exactly what the Mac app shows — pinned against a known certificate."""
    import re
    bridge = _load_bridge(monkeypatch, leaf)
    assert bridge.format_key_fingerprint(LEAF_PIN) == LEAF_FINGERPRINT
    assert re.fullmatch(r"[0-9A-F]{4}( [0-9A-F]{4}){15}", LEAF_FINGERPRINT)
    # Recomputed with the openssl recipe, so the constant is not just copied.
    pub = subprocess.run(["openssl", "x509", "-in", str(leaf), "-pubkey", "-noout"],
                         capture_output=True, check=True).stdout
    der = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "DER"],
                         input=pub, capture_output=True, check=True).stdout
    import hashlib
    h = hashlib.sha256(der).hexdigest().upper()
    assert " ".join(h[i:i + 4] for i in range(0, 64, 4)) == LEAF_FINGERPRINT


def test_a_malformed_pin_never_becomes_a_fingerprint(monkeypatch, leaf):
    """A shortened value must never reach the glass: a short prefix can be
    ground out by an impostor."""
    import base64
    bridge = _load_bridge(monkeypatch, leaf)
    for bad in ("", "not base64 !!", base64.b64encode(b"\x00" * 8).decode(),
                base64.b64encode(b"\x00" * 33).decode()):
        with pytest.raises(Exception):
            bridge.format_key_fingerprint(bad)


def test_the_route_is_gated_like_openwrt_qr(monkeypatch, leaf):
    """The LAN address is box-internal topology: same gate as /openwrt/qr."""
    src = _BRIDGE_PATH.read_text(encoding="utf-8")
    i = src.index('if path == "/pair/qr":')
    block = src[i:i + 600]
    assert "self._authed()" in block and "pair_qr_snapshot()" in block
