"""WARP-230 — Backend contract.

Two implementations:
  - backends.mock.MockBackend     — pure-Python in-memory (dev + CI)
  - backends.real.RealBackend     — tpm2-pytss + /dev/tpm0 (the appliance)

Both satisfy the same Protocol so the gRPC handler is implementation-
agnostic.
"""
from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable


@runtime_checkable
class Backend(Protocol):
    """Contract every device-identity backend satisfies."""

    @property
    def name(self) -> str:
        """'real' or 'mock'."""
        ...

    def is_provisioned(self) -> bool: ...

    def provision(self, *, device_id: str, sealing_pcrs: list[int]) -> None:
        """Generate EK, SRK, device-id key, self-sign cert, seal to PCRs."""
        ...

    def sign(self, payload: bytes) -> bytes:
        """Sign with the device-id key. Returns DER-encoded ECDSA signature."""
        ...

    def get_cert_pem(self) -> bytes:
        """PEM-encoded device-id X.509 cert."""
        ...

    def get_status(self) -> dict:
        """Status dict matching the GetStatusResponse proto fields."""
        ...

    def reseal(self) -> dict:
        """Re-bind the sealed blob to current PCR values. Returns
        {resealed, sealed_at, new_pcr_snapshot_indices}."""
        ...


import os


def make_backend(backend_name: str, *, storage_root: Path) -> Backend:
    """Factory — DROPLET_TPM_BACKEND env value selects the implementation."""
    if backend_name == "mock":
        from .mock import MockBackend
        return MockBackend(storage_root=storage_root)
    if backend_name == "real":
        from .real import RealBackend
        # IDX-002: RealBackend is an unfinished scaffold — its crypto methods
        # return PLACEHOLDER bytes (empty signatures, a literal "placeholder"
        # cert) with no error, so selecting it in production yields a
        # cryptographically void device identity with no boot signal. Refuse to
        # construct it unless the operator explicitly opts into the scaffold,
        # until the tss2 path is wired. NEEDS SECURITY SIGN-OFF on the posture.
        if os.environ.get("DROPLET_TPM_ALLOW_SCAFFOLD", "").lower() not in ("1", "true", "yes", "on"):
            raise RuntimeError(
                "DROPLET_TPM_BACKEND=real selects an unimplemented scaffold "
                "(placeholder signatures/certs). Set DROPLET_TPM_ALLOW_SCAFFOLD=1 "
                "to run it knowingly, or use the mock backend until the TPM path lands."
            )
        return RealBackend(storage_root=storage_root)
    raise ValueError(f"Unknown DROPLET_TPM_BACKEND: {backend_name!r}")
