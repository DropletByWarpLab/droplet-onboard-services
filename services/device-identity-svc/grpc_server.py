"""WARP-230 — gRPC handler for the device-identity sidecar.

Pure-mechanical adapter from gRPC request types to Backend method calls.
All business logic lives in backends.{mock,real}.
"""
from __future__ import annotations

import logging
import secrets
import time
from typing import Optional

import grpc

from grpc_generated import device_identity_pb2 as pb
from grpc_generated import device_identity_pb2_grpc as pb_grpc

logger = logging.getLogger(__name__)

# Nonce TTL — named constant per the "no guessing" project rule.
# Matches the orchestrator-side require-recent-mfa window (60s) so a
# nonce minted just after MFA can still be redeemed when the request
# reaches the sidecar.
RESEAL_NONCE_TTL_SEC = 60

# IDX-08 — hard cap on the nonce table. Nonces were only swept inside
# _consume_nonce, so nonces that are issued but never redeemed (a Reseal that
# never arrives) accumulated forever. Sweeping on issue + a size cap keeps the
# table bounded. The cap is generous relative to the 60s TTL — under any sane
# issue rate it's never reached; it's a backstop, not a tuning knob.
_MAX_RESEAL_NONCES = 1024


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
        # Sweep on issue too (not just on consume) so unredeemed nonces don't
        # accumulate, and bound the table as a backstop (IDX-08).
        self._sweep_expired_nonces()
        self._reseal_nonces[nonce] = time.time() + RESEAL_NONCE_TTL_SEC
        if len(self._reseal_nonces) > _MAX_RESEAL_NONCES:
            # dict is insertion-ordered → drop the oldest. Never drops the
            # nonce we just minted (it's newest).
            oldest = next(iter(self._reseal_nonces))
            del self._reseal_nonces[oldest]
        return nonce

    def _sweep_expired_nonces(self, now: Optional[float] = None) -> None:
        """Drop every nonce whose TTL has elapsed."""
        now = time.time() if now is None else now
        for k, exp in list(self._reseal_nonces.items()):
            if exp < now:
                del self._reseal_nonces[k]

    def _consume_nonce(self, nonce: str) -> bool:
        if not nonce:
            return False
        now = time.time()
        self._sweep_expired_nonces(now)
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
