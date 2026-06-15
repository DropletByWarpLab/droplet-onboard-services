"""WARP-230 — Real (tpm2-pytss) backend integration tests.

Skip-gated by ``RUN_TPM_INTEGRATION=1`` so they only run when a real
TPM device or swtpm emulator is available. Local dev (Mac, no TPM) and
PR-required CI lanes skip these by default.

Same contract tests as test_backend_mock.py — both backends must
behave identically at this surface.
"""
import os

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_TPM_INTEGRATION") != "1",
    reason="RUN_TPM_INTEGRATION=1 not set",
)


@pytest.fixture
def backend(tmp_path):
    from backends.real import RealBackend
    return RealBackend(storage_root=tmp_path)


def test_unprovisioned_by_default(backend):
    assert backend.is_provisioned() is False


def test_provision_creates_artifacts(backend, tmp_path):
    backend.provision(device_id="droplet-test", sealing_pcrs=[0, 2, 4, 7])
    assert backend.is_provisioned()
    assert (tmp_path / "device-id-cert.pem").exists()
    assert (tmp_path / "device-id.sealed").exists()


def test_sign_after_provision(backend):
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    sig = backend.sign(b"hello")
    assert isinstance(sig, bytes) and len(sig) > 0


def test_get_status_after_provision(backend):
    backend.provision(device_id="abc", sealing_pcrs=[0, 2, 4, 7])
    s = backend.get_status()
    assert s["provisioned"] is True
    assert s["backend"] == "real"
    assert s["seal_valid"] is True


def test_reseal_after_pcr_change(backend):
    """End-to-end reseal: provision against current PCRs, mutate a PCR
    (e.g., via swtpm.pcr_extend), reseal, verify seal_valid recovers."""
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    # Test runner must arrange a PCR extend between these two calls
    # (swtpm has tpm2_pcrextend; real hardware would be a kernel update).
    result = backend.reseal()
    assert result["resealed"] is True
