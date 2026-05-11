"""WARP-230 — gRPC handler for the device-identity sidecar.

Pure-mechanical adapter from gRPC request types to Backend method calls.
All business logic lives in backends.{mock,real}.
"""
from __future__ import annotations

import logging
import secrets
import time

import grpc

from grpc_generated import device_identity_pb2 as pb
from grpc_generated import device_identity_pb2_grpc as pb_grpc

logger = logging.getLogger(__name__)

# Nonce TTL — named constant per the "no guessing" project rule.
# Matches the orchestrator-side require-recent-mfa window (60s) so a
# nonce minted just after MFA can still be redeemed when the request
# reaches the sidecar.
RESEAL_NONCE_TTL_SEC = 60


class DeviceIdentityServicer(pb_grpc.DeviceIdentityServiceServicer):
    """gRPC handler. Holds a Backend + a short-lived nonce table for
    reseal-auth validation."""

    def __init__(self, backend) -> None:
        self._backend = backend
        # nonce → expires_at (unix seconds)
        self._reseal_nonces: dict[str, float] = {}

    def issue_reseal_nonce(self) -> str:
        """Called out-of-band by the orchestrator after MFA re-auth.
        Returns a nonce the orchestrator passes to Reseal()."""
        nonce = secrets.token_urlsafe(32)
        self._reseal_nonces[nonce] = time.time() + RESEAL_NONCE_TTL_SEC
        return nonce

    def _consume_nonce(self, nonce: str) -> bool:
        if not nonce:
            return False
        now = time.time()
        # Expire stale nonces opportunistically
        for k, exp in list(self._reseal_nonces.items()):
            if exp < now:
                del self._reseal_nonces[k]
        exp = self._reseal_nonces.pop(nonce, None)
        return exp is not None and exp >= now

    def Sign(self, request, context):
        if not self._backend.is_provisioned():
            context.set_code(grpc.StatusCode.FAILED_PRECONDITION)
            context.set_details("device not provisioned")
            return pb.SignResponse()
        sig = self._backend.sign(request.payload)
        return pb.SignResponse(signature=sig, algorithm="ECDSA-P256-SHA256")

    def GetCert(self, request, context):
        if not self._backend.is_provisioned():
            context.set_code(grpc.StatusCode.FAILED_PRECONDITION)
            context.set_details("device not provisioned")
            return pb.GetCertResponse()
        return pb.GetCertResponse(cert_pem=self._backend.get_cert_pem().decode())

    def GetStatus(self, request, context):
        s = self._backend.get_status()
        return pb.GetStatusResponse(
            provisioned=s["provisioned"],
            backend=s["backend"],
            cert_subject=s["cert_subject"],
            cert_fingerprint=s["cert_fingerprint"],
            cert_expires_at=s["cert_expires_at"],
            sealing_pcrs=s["sealing_pcrs"],
            seal_valid=s["seal_valid"],
            last_reseal_at=s["last_reseal_at"],
            current_pcr_snapshot={
                int(k): v for k, v in s["current_pcr_snapshot"].items()
            },
        )

    def Reseal(self, request, context):
        if not self._consume_nonce(request.operator_auth_nonce):
            context.set_code(grpc.StatusCode.UNAUTHENTICATED)
            context.set_details("invalid or expired operator auth nonce")
            return pb.ResealResponse()
        if not self._backend.is_provisioned():
            context.set_code(grpc.StatusCode.FAILED_PRECONDITION)
            context.set_details("device not provisioned")
            return pb.ResealResponse()
        result = self._backend.reseal()
        return pb.ResealResponse(
            resealed=result["resealed"],
            sealed_at=result["sealed_at"],
            new_pcr_snapshot_indices=result["new_pcr_snapshot_indices"],
        )
