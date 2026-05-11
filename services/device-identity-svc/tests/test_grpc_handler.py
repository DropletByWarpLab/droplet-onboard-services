"""WARP-230 — gRPC handler unit tests.

Use the mock backend directly + the unwrapped servicer methods (no live
gRPC channel) — exercises the request→backend wiring without spinning
up sockets.
"""
from unittest.mock import MagicMock

import grpc
import pytest

from backends.mock import MockBackend
from grpc_generated import device_identity_pb2 as pb
from grpc_server import DeviceIdentityServicer


@pytest.fixture
def backend(tmp_path):
    return MockBackend(storage_root=tmp_path)


@pytest.fixture
def servicer(backend):
    return DeviceIdentityServicer(backend)


def test_sign_before_provision_returns_failed_precondition(servicer):
    ctx = MagicMock()
    servicer.Sign(pb.SignRequest(payload=b"x"), ctx)
    ctx.set_code.assert_called_once_with(grpc.StatusCode.FAILED_PRECONDITION)


def test_sign_after_provision_returns_signature(backend, servicer):
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    resp = servicer.Sign(pb.SignRequest(payload=b"hello"), MagicMock())
    assert len(resp.signature) > 0
    assert resp.algorithm == "ECDSA-P256-SHA256"


def test_get_cert_after_provision(backend, servicer):
    backend.provision(device_id="abc", sealing_pcrs=[0, 2, 4, 7])
    resp = servicer.GetCert(pb.GetCertRequest(), MagicMock())
    assert resp.cert_pem.startswith("-----BEGIN CERTIFICATE-----")


def test_get_cert_before_provision_returns_failed_precondition(servicer):
    ctx = MagicMock()
    servicer.GetCert(pb.GetCertRequest(), ctx)
    ctx.set_code.assert_called_once_with(grpc.StatusCode.FAILED_PRECONDITION)


def test_get_status_unprovisioned(servicer):
    resp = servicer.GetStatus(pb.GetStatusRequest(), MagicMock())
    assert resp.provisioned is False
    assert resp.backend == "mock"


def test_get_status_provisioned(backend, servicer):
    backend.provision(device_id="abc-device", sealing_pcrs=[0, 2, 4, 7])
    resp = servicer.GetStatus(pb.GetStatusRequest(), MagicMock())
    assert resp.provisioned is True
    assert resp.seal_valid is True
    assert "abc-device" in resp.cert_subject


def test_reseal_rejects_invalid_nonce(backend, servicer):
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    ctx = MagicMock()
    servicer.Reseal(pb.ResealRequest(operator_auth_nonce="not-a-real-nonce"), ctx)
    ctx.set_code.assert_called_once_with(grpc.StatusCode.UNAUTHENTICATED)


def test_reseal_rejects_empty_nonce(backend, servicer):
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    ctx = MagicMock()
    servicer.Reseal(pb.ResealRequest(operator_auth_nonce=""), ctx)
    ctx.set_code.assert_called_once_with(grpc.StatusCode.UNAUTHENTICATED)


def test_reseal_with_valid_nonce(backend, servicer):
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    backend.simulate_kernel_update()
    nonce = servicer.issue_reseal_nonce()
    resp = servicer.Reseal(pb.ResealRequest(operator_auth_nonce=nonce), MagicMock())
    assert resp.resealed is True
    assert resp.sealed_at != ""


def test_reseal_nonce_is_single_use(backend, servicer):
    backend.provision(device_id="x", sealing_pcrs=[0, 2, 4, 7])
    nonce = servicer.issue_reseal_nonce()
    servicer.Reseal(pb.ResealRequest(operator_auth_nonce=nonce), MagicMock())
    ctx = MagicMock()
    servicer.Reseal(pb.ResealRequest(operator_auth_nonce=nonce), ctx)
    ctx.set_code.assert_called_once_with(grpc.StatusCode.UNAUTHENTICATED)
