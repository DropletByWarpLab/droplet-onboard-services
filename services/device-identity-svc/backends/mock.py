"""WARP-230 — Mock TPM backend for dev + CI.

Pure-Python in-memory implementation that persists artifacts (cert,
sealed blob, provisioned marker) to /var/lib/droplet/tpm/ exactly like
the real backend. Indistinguishable at the gRPC boundary from the real
implementation.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import secrets
from pathlib import Path
from typing import Optional

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from storage import Storage

# Cert validity window — kept as a named constant per the "no guessing"
# project rule. Self-signed certs live 5 years; renewal is a future ticket.
DEVICE_CERT_VALIDITY_DAYS = 365 * 5


def _make_pcr_state(seed: bytes = b"") -> dict[int, bytes]:
    """Mock PCR state — deterministic per seed so reseal tests can compare.

    Eight PCRs (0..7) is enough to cover the canonical sealing set
    [0, 2, 4, 7] plus a few extras for future test scenarios.
    """
    out: dict[int, bytes] = {}
    for idx in range(8):
        h = hashlib.sha256(seed + idx.to_bytes(1, "big")).digest()
        out[idx] = h
    return out


def _digest_bytes_to_hex_map(pcrs: dict[int, bytes]) -> dict[int, str]:
    return {idx: digest.hex() for idx, digest in pcrs.items()}


class MockBackend:
    """In-memory mock backend. Persists artifacts to disk for cross-process
    interchangeability with the real backend."""

    name = "mock"

    def __init__(self, *, storage_root: Path) -> None:
        self._storage = Storage(Path(storage_root))
        # In-memory state. The persistent artifacts on disk are the source
        # of truth for "is provisioned"; the private key is hydrated from
        # the persisted sealed blob on instance creation.
        self._private_key: Optional[ec.EllipticCurvePrivateKey] = None
        self._public_pem: Optional[bytes] = None
        self._cert_pem: Optional[bytes] = None
        self._sealing_pcrs: list[int] = []
        self._sealed_pcr_snapshot: dict[int, bytes] = {}
        self._pcr_state: dict[int, bytes] = _make_pcr_state()
        self._device_id: str = ""
        self._last_reseal_at: str = ""
        # If already provisioned on disk, hydrate.
        if self._storage.is_provisioned():
            self._hydrate_from_disk()

    # ─── Backend protocol ─────────────────────────────────────────────

    def is_provisioned(self) -> bool:
        return self._storage.is_provisioned()

    def provision(self, *, device_id: str, sealing_pcrs: list[int]) -> None:
        if self.is_provisioned():
            # Idempotent — re-provision with same args is a no-op.
            return
        self._device_id = device_id
        self._sealing_pcrs = list(sealing_pcrs)
        # Generate ECC P-256 key (FIPS 140-3 approved).
        self._private_key = ec.generate_private_key(ec.SECP256R1())
        self._public_pem = self._private_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        # Self-sign a 5-year cert.
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, device_id),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Droplet"),
        ])
        now = dt.datetime.now(dt.timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(self._private_key.public_key())
            .serial_number(secrets.randbits(64))
            .not_valid_before(now)
            .not_valid_after(now + dt.timedelta(days=DEVICE_CERT_VALIDITY_DAYS))
            .sign(self._private_key, hashes.SHA256())
        )
        self._cert_pem = cert.public_bytes(serialization.Encoding.PEM)
        # Snapshot the current PCRs.
        self._sealed_pcr_snapshot = {
            idx: self._pcr_state[idx] for idx in sealing_pcrs
        }
        # Persist artifacts. The "EK cert" and "SRK pub" PEMs are
        # placeholder constants in the mock; the real backend writes
        # the actual TPM-derived values.
        self._storage.write(
            "ek-cert.pem",
            b"-----BEGIN CERTIFICATE-----\nMOCK_EK\n-----END CERTIFICATE-----\n",
        )
        self._storage.write(
            "srk-pub.pem",
            b"-----BEGIN PUBLIC KEY-----\nMOCK_SRK\n-----END PUBLIC KEY-----\n",
        )
        self._storage.write("device-id-pub.pem", self._public_pem)
        self._storage.write("device-id-cert.pem", self._cert_pem)
        priv_pem = self._private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        # Sealed = JSON envelope with the private-key PEM + PCR snapshot.
        # The real backend uses the TPM's sealing primitive; the mock
        # uses this stand-in so persistence + reseal flow exercise the
        # same code path.
        sealed = json.dumps({
            "priv_pem": priv_pem.decode(),
            "pcrs": {str(k): v.hex() for k, v in self._sealed_pcr_snapshot.items()},
        }).encode()
        self._storage.write("device-id.sealed", sealed)
        fingerprint = hashlib.sha256(self._cert_pem).hexdigest()
        self._storage.write_provisioned({
            "at": now.isoformat(),
            "device_id": device_id,
            "pcrs": list(sealing_pcrs),
            "cert_fingerprint": f"sha256:{fingerprint}",
        })

    def sign(self, payload: bytes) -> bytes:
        if not self.is_provisioned():
            raise RuntimeError("not provisioned")
        if self._private_key is None:
            self._hydrate_from_disk()
        assert self._private_key is not None
        return self._private_key.sign(payload, ec.ECDSA(hashes.SHA256()))

    def get_cert_pem(self) -> bytes:
        if not self.is_provisioned():
            raise RuntimeError("not provisioned")
        if self._cert_pem is None:
            self._hydrate_from_disk()
        assert self._cert_pem is not None
        return self._cert_pem

    def get_public_key_pem(self) -> bytes:
        if not self.is_provisioned():
            raise RuntimeError("not provisioned")
        if self._public_pem is None:
            self._hydrate_from_disk()
        assert self._public_pem is not None
        return self._public_pem

    def get_status(self) -> dict:
        provisioned = self.is_provisioned()
        if not provisioned:
            return {
                "provisioned": False,
                "backend": self.name,
                "cert_subject": "",
                "cert_fingerprint": "",
                "cert_expires_at": "",
                "sealing_pcrs": [],
                "seal_valid": False,
                "last_reseal_at": "",
                "current_pcr_snapshot": _digest_bytes_to_hex_map(self._pcr_state),
            }
        info = self._storage.read_provisioned() or {}
        cert = x509.load_pem_x509_certificate(self.get_cert_pem())
        seal_valid = all(
            self._pcr_state.get(idx) == self._sealed_pcr_snapshot.get(idx)
            for idx in self._sealing_pcrs
        )
        return {
            "provisioned": True,
            "backend": self.name,
            "cert_subject": cert.subject.rfc4514_string(),
            "cert_fingerprint": info.get("cert_fingerprint", ""),
            "cert_expires_at": cert.not_valid_after_utc.isoformat(),
            "sealing_pcrs": list(self._sealing_pcrs),
            "seal_valid": seal_valid,
            "last_reseal_at": self._last_reseal_at,
            "current_pcr_snapshot": _digest_bytes_to_hex_map(self._pcr_state),
        }

    def reseal(self) -> dict:
        if not self.is_provisioned():
            raise RuntimeError("not provisioned")
        if self._private_key is None:
            self._hydrate_from_disk()
        assert self._private_key is not None
        self._sealed_pcr_snapshot = {
            idx: self._pcr_state[idx] for idx in self._sealing_pcrs
        }
        priv_pem = self._private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        sealed = json.dumps({
            "priv_pem": priv_pem.decode(),
            "pcrs": {str(k): v.hex() for k, v in self._sealed_pcr_snapshot.items()},
        }).encode()
        self._storage.write("device-id.sealed", sealed)
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        self._last_reseal_at = now
        info = self._storage.read_provisioned() or {}
        info["last_reseal_at"] = now
        self._storage.write_provisioned(info)
        return {
            "resealed": True,
            "sealed_at": now,
            "new_pcr_snapshot_indices": list(self._sealing_pcrs),
        }

    # ─── Test-only helpers ────────────────────────────────────────────

    def simulate_kernel_update(self) -> None:
        """Bump PCR 4 to a new value so seal_valid flips to False.

        Real TPMs extend PCR 4 (IPL/bootloader) every time the kernel
        image changes. We emulate that by hashing the current value with
        a tag.
        """
        self._pcr_state[4] = hashlib.sha256(
            self._pcr_state[4] + b"kernel-update"
        ).digest()

    # ─── Internals ────────────────────────────────────────────────────

    def _hydrate_from_disk(self) -> None:
        """Reconstruct in-memory state from persisted artifacts. Called on
        instance creation when a previous provision is detected, and lazily
        when state is needed."""
        info = self._storage.read_provisioned()
        if not info:
            return
        self._device_id = info.get("device_id", "")
        self._sealing_pcrs = list(info.get("pcrs", []))
        self._last_reseal_at = info.get("last_reseal_at", "")
        self._cert_pem = self._storage.read("device-id-cert.pem")
        self._public_pem = self._storage.read("device-id-pub.pem")
        sealed = json.loads(self._storage.read("device-id.sealed"))
        key = serialization.load_pem_private_key(
            sealed["priv_pem"].encode(), password=None
        )
        assert isinstance(key, ec.EllipticCurvePrivateKey)
        self._private_key = key
        self._sealed_pcr_snapshot = {
            int(k): bytes.fromhex(v) for k, v in sealed["pcrs"].items()
        }
