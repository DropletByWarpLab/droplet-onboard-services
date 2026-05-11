"""WARP-230 — Mock backend contract tests.

The mock backend persists state to /var/lib/droplet/tpm/ just like the
real backend, so file-format and idempotency tests exercise the same
paths.
"""
import pytest

from backends.mock import MockBackend


@pytest.fixture
def backend(tmp_path):
    return MockBackend(storage_root=tmp_path)


def test_unprovisioned_by_default(backend):
    assert backend.is_provisioned() is False


def test_provision_creates_all_artifacts(backend, tmp_path):
    backend.provision(device_id="droplet-test", sealing_pcrs=[0, 2, 4, 7])
    assert backend.is_provisioned()
    assert (tmp_path / "ek-cert.pem").exists()
    assert (tmp_path / "srk-pub.pem").exists()
    assert (tmp_path / "device-id-pub.pem").exists()
    assert (tmp_path / "device-id-cert.pem").exists()
    assert (tmp_path / "device-id.sealed").exists()
    assert (tmp_path / "provisioned.json").exists()


def test_provision_is_idempotent(backend):
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    cert1 = backend.get_cert_pem()
    # Second provision call is a no-op
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    cert2 = backend.get_cert_pem()
    assert cert1 == cert2


def test_sign_returns_a_valid_signature(backend):
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    sig = backend.sign(b"hello world")
    assert isinstance(sig, bytes)
    assert len(sig) > 0


def test_sign_two_calls_with_same_payload_produce_verifiable_signatures(backend):
    """ECDSA signatures are non-deterministic; both should verify."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    sig1 = backend.sign(b"payload")
    sig2 = backend.sign(b"payload")
    pub_pem = backend.get_public_key_pem()
    pub = load_pem_public_key(pub_pem)
    pub.verify(sig1, b"payload", ec.ECDSA(hashes.SHA256()))
    pub.verify(sig2, b"payload", ec.ECDSA(hashes.SHA256()))


def test_sign_before_provision_raises(backend):
    with pytest.raises(RuntimeError, match="not provisioned"):
        backend.sign(b"x")


def test_get_status_reports_provisioned_state(backend):
    s = backend.get_status()
    assert s["provisioned"] is False
    backend.provision(device_id="droplet-abc", sealing_pcrs=[0, 2, 4, 7])
    s = backend.get_status()
    assert s["provisioned"] is True
    assert s["backend"] == "mock"
    assert "droplet-abc" in s["cert_subject"]
    assert s["sealing_pcrs"] == [0, 2, 4, 7]
    assert s["seal_valid"] is True


def test_reseal_after_pcr_change_succeeds(backend):
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    assert backend.get_status()["seal_valid"] is True
    backend.simulate_kernel_update()
    assert backend.get_status()["seal_valid"] is False
    result = backend.reseal()
    assert result["resealed"] is True
    assert backend.get_status()["seal_valid"] is True


def test_reseal_before_provision_raises(backend):
    with pytest.raises(RuntimeError, match="not provisioned"):
        backend.reseal()


def test_sign_works_across_kernel_update(backend):
    """Old seal is invalid but the in-memory private key still works
    until reseal. Real TPM behaves the same way: the active key remains
    available; only the sealed blob is stale."""
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    sig_before = backend.sign(b"x")
    backend.simulate_kernel_update()
    sig_after = backend.sign(b"x")
    assert sig_before is not None
    assert sig_after is not None


def test_simulate_kernel_update_bumps_pcr_4(backend):
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    s1 = backend.get_status()
    pcr4_before = s1["current_pcr_snapshot"][4]
    backend.simulate_kernel_update()
    s2 = backend.get_status()
    pcr4_after = s2["current_pcr_snapshot"][4]
    assert pcr4_before != pcr4_after


def test_persistence_across_instances(backend, tmp_path):
    """Mock writes to disk; a fresh instance pointed at the same dir
    should find the existing provision."""
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    fp1 = backend.get_status()["cert_fingerprint"]
    backend2 = MockBackend(storage_root=tmp_path)
    assert backend2.is_provisioned()
    assert backend2.get_status()["cert_fingerprint"] == fp1


def test_cert_pem_returns_valid_x509(backend):
    from cryptography.x509 import load_pem_x509_certificate

    backend.provision(device_id="droplet-cert-test", sealing_pcrs=[0, 2, 4, 7])
    cert = load_pem_x509_certificate(backend.get_cert_pem())
    assert "droplet-cert-test" in cert.subject.rfc4514_string()


def test_cert_fingerprint_format(backend):
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    fp = backend.get_status()["cert_fingerprint"]
    assert fp.startswith("sha256:")
    assert len(fp) == len("sha256:") + 64  # 32-byte hex


def test_sealing_pcrs_round_trip(backend):
    backend.provision(device_id="x", sealing_pcrs=[1, 3, 7])
    assert backend.get_status()["sealing_pcrs"] == [1, 3, 7]


def test_get_public_key_pem(backend):
    """Internal accessor used by sign-verify tests."""
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    pem = backend.get_public_key_pem()
    assert pem.startswith(b"-----BEGIN PUBLIC KEY-----")
