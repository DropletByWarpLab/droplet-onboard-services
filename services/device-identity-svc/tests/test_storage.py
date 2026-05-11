"""WARP-230 — file I/O for /var/lib/droplet/tpm/.

Atomic writes (write-to-tmp, fsync, rename) so a crash mid-write doesn't
leave a half-written sealed blob. provisioned.json tracks the PCR snapshot
+ cert fingerprint so the provision script knows whether to skip.
"""
from pathlib import Path

from storage import Storage


def test_write_and_read_roundtrips(tmp_path):
    s = Storage(tmp_path)
    s.write("ek-cert.pem", b"-----BEGIN CERTIFICATE-----\n...\n")
    assert s.read("ek-cert.pem").startswith(b"-----BEGIN")


def test_write_is_atomic(tmp_path):
    """No .tmp leftover after a successful write."""
    s = Storage(tmp_path)
    s.write("good.bin", b"complete")
    assert s.read("good.bin") == b"complete"
    assert not list(tmp_path.glob("*.tmp"))


def test_provisioned_marker_roundtrips(tmp_path):
    s = Storage(tmp_path)
    s.write_provisioned({
        "at": "2026-05-11T03:00:00Z",
        "pcrs": [0, 2, 4, 7],
        "cert_fingerprint": "sha256:abc123",
    })
    p = s.read_provisioned()
    assert p["pcrs"] == [0, 2, 4, 7]
    assert p["cert_fingerprint"] == "sha256:abc123"


def test_read_provisioned_missing_returns_none(tmp_path):
    s = Storage(tmp_path)
    assert s.read_provisioned() is None


def test_is_provisioned_false_when_marker_missing(tmp_path):
    s = Storage(tmp_path)
    assert s.is_provisioned() is False


def test_is_provisioned_true_when_marker_present(tmp_path):
    s = Storage(tmp_path)
    s.write_provisioned({"at": "now", "pcrs": [0], "cert_fingerprint": "x"})
    assert s.is_provisioned() is True
