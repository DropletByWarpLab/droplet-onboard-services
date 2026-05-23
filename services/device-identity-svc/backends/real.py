"""WARP-230 — Real TPM 2.0 backend via tpm2-pytss.

Generates an ECC P-256 device-identity key in the TPM, seals to PCR
indices [0, 2, 4, 7] (or whatever sealing_pcrs the provisioner passes),
and exposes Sign / GetCert / GetStatus / Reseal through the TPM's
primitives.

The private key never leaves the TPM in plaintext. The orchestrator
talks to this backend via the gRPC sidecar; no host process besides
this one has /dev/tpm0 access.

**Scaffold status:** the method bodies that touch tpm2-pytss are
intentionally placeholder. The contract-tests file
``tests/test_backend_real.py`` is skip-gated by
``RUN_TPM_INTEGRATION=1`` so CI doesn't break. The agent finishing the
real-TPM wiring fills in the tss2 calls following the library's
examples; the surface that the gRPC handler depends on (the public
methods + their return shapes) is already pinned by the mock backend's
contract.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from storage import Storage

logger = logging.getLogger(__name__)

# Cert validity window — must match MockBackend so behavior is
# observationally identical at the gRPC boundary.
DEVICE_CERT_VALIDITY_DAYS = 365 * 5

# SRK persistent handle — TCG-recommended location for the Storage
# Root Key derived from the Owner hierarchy.
SRK_PERSISTENT_HANDLE = 0x81000001

# NV index where Infineon-style EK certs are stored. Jetson modules
# typically don't ship a pre-loaded EK cert; we synthesize one when
# absent.
EK_CERT_NV_INDEX = 0x01C00002


class RealBackend:
    """tpm2-pytss-backed implementation. Imports tss2 lazily so the
    module can be imported on systems without the library installed
    (e.g., dev machines pinning DROPLET_TPM_BACKEND=mock).

    The placeholder method bodies are flagged in their docstrings; each
    one references the corresponding tpm2-pytss example file the agent
    completing the real-TPM wiring should consult.
    """

    name = "real"

    def __init__(self, *, storage_root: Path) -> None:
        # Lazy import — fails closed if tpm2-pytss is missing.
        from tpm2_pytss import ESAPI  # type: ignore[import-not-found]

        self._ESAPI = ESAPI
        self._storage = Storage(Path(storage_root))
        self._device_id: str = ""
        self._sealing_pcrs: list[int] = []
        self._last_reseal_at: str = ""
        if self._storage.is_provisioned():
            info = self._storage.read_provisioned() or {}
            self._device_id = info.get("device_id", "")
            self._sealing_pcrs = list(info.get("pcrs", []))
            self._last_reseal_at = info.get("last_reseal_at", "")

    # ─── Backend protocol ─────────────────────────────────────────────

    def is_provisioned(self) -> bool:
        return self._storage.is_provisioned()

    def provision(self, *, device_id: str, sealing_pcrs: list[int]) -> None:
        if self.is_provisioned():
            return  # idempotent
        with self._ESAPI() as esapi:
            ek_cert_pem = self._read_or_synth_ek_cert(esapi)
            self._storage.write("ek-cert.pem", ek_cert_pem)

            srk_pub_pem = self._ensure_srk(esapi)
            self._storage.write("srk-pub.pem", srk_pub_pem)

            device_pub, sealed_blob = self._create_and_seal_device_key(
                esapi, sealing_pcrs
            )

        self._device_id = device_id
        self._sealing_pcrs = list(sealing_pcrs)
        device_pub_pem = device_pub.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        self._storage.write("device-id-pub.pem", device_pub_pem)

        cert_pem = self._self_sign_cert(device_id, device_pub)
        self._storage.write("device-id-cert.pem", cert_pem)
        self._storage.write("device-id.sealed", sealed_blob)

        fingerprint = hashlib.sha256(cert_pem).hexdigest()
        self._storage.write_provisioned({
            "at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "device_id": device_id,
            "pcrs": list(sealing_pcrs),
            "cert_fingerprint": f"sha256:{fingerprint}",
        })

    def sign(self, payload: bytes) -> bytes:
        if not self.is_provisioned():
            raise RuntimeError("not provisioned")
        # Load the sealed key into TPM volatile memory, sign, evict.
        with self._ESAPI() as esapi:
            handle = self._unseal_into_tpm(esapi)
            try:
                return self._tpm_sign(esapi, handle, payload)
            finally:
                esapi.flush_context(handle)

    def get_cert_pem(self) -> bytes:
        if not self.is_provisioned():
            raise RuntimeError("not provisioned")
        return self._storage.read("device-id-cert.pem")

    def get_public_key_pem(self) -> bytes:
        if not self.is_provisioned():
            raise RuntimeError("not provisioned")
        return self._storage.read("device-id-pub.pem")

    def get_status(self) -> dict:
        provisioned = self.is_provisioned()
        pcr_snapshot = self._read_pcr_snapshot()
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
                "current_pcr_snapshot": pcr_snapshot,
            }
        info = self._storage.read_provisioned() or {}
        cert = x509.load_pem_x509_certificate(self.get_cert_pem())
        seal_valid = self._verify_seal_against_current_pcrs()
        return {
            "provisioned": True,
            "backend": self.name,
            "cert_subject": cert.subject.rfc4514_string(),
            "cert_fingerprint": info.get("cert_fingerprint", ""),
            "cert_expires_at": cert.not_valid_after_utc.isoformat(),
            "sealing_pcrs": list(self._sealing_pcrs),
            "seal_valid": seal_valid,
            "last_reseal_at": self._last_reseal_at,
            "current_pcr_snapshot": pcr_snapshot,
        }

    def reseal(self) -> dict:
        if not self.is_provisioned():
            raise RuntimeError("not provisioned")
        with self._ESAPI() as esapi:
            handle = self._unseal_into_tpm(esapi)
            try:
                sealed_blob = self._seal_against_current_pcrs(esapi, handle)
            finally:
                esapi.flush_context(handle)
        self._storage.write("device-id.sealed", sealed_blob)
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

    # ─── Helpers (TPM operations) ────────────────────────────────────
    # Split into separate methods to keep provision/sign/reseal readable.
    # The actual tss2 API calls are nontrivial — each docstring points
    # at the canonical tpm2-pytss example file to consult when filling
    # the placeholder bodies in.

    def _read_or_synth_ek_cert(self, esapi) -> bytes:
        """Read NV index ``EK_CERT_NV_INDEX`` (0x01C00002) for an
        Infineon-style EK cert; if absent, generate a self-signed cert
        over the EK public key derived from the standard EK template.

        Reference: tpm2-pytss/examples/ek_provisioning.py
        Placeholder body returns a synthetic PEM so the rest of the
        provisioning code path runs end-to-end during the scaffold phase.
        """
        return (
            b"-----BEGIN CERTIFICATE-----\n"
            b"# WARP-230 synth EK cert placeholder - replace via tpm2-pytss\n"
            b"-----END CERTIFICATE-----\n"
        )

    def _ensure_srk(self, esapi) -> bytes:
        """Re-derive SRK from owner hierarchy if not persistent. Make
        persistent at handle ``SRK_PERSISTENT_HANDLE`` (0x81000001) if
        newly created. Return PEM-encoded public key.

        Reference: tpm2-pytss/examples/srk.py
        """
        return (
            b"-----BEGIN PUBLIC KEY-----\n"
            b"# WARP-230 SRK pub placeholder\n"
            b"-----END PUBLIC KEY-----\n"
        )

    def _create_and_seal_device_key(self, esapi, sealing_pcrs):
        """Generate ECC P-256 device key inside TPM; seal to ``sealing_pcrs``.

        Returns (public_key, sealed_blob). The TPM template uses:
          - ``TPM2_ALG_ECC`` + ``TPM2_ECC_NIST_P256``
          - Scheme ``TPM2_ALG_ECDSA`` + ``TPM2_ALG_SHA256``
          - Attributes: ``sign | fixedTPM | fixedParent | sensitiveDataOrigin``

        The ``fixedTPM | fixedParent`` flags make the key non-extractable
        (cannot be duplicated to another TPM).

        Reference: tpm2-pytss/examples/keys.py + policy_pcr usage in
        examples/sealing.py.
        """
        # Placeholder — returns a deterministic public key + sealed blob
        # so the gRPC + storage layers can be smoke-tested end-to-end
        # before the tss2 wiring lands.
        public_key = ec.generate_private_key(ec.SECP256R1()).public_key()
        sealed_blob = b"# WARP-230 TPM2B_PRIVATE blob placeholder"
        return public_key, sealed_blob

    def _unseal_into_tpm(self, esapi):
        """Load ``device-id.sealed`` under SRK, satisfy PCR policy, return
        loaded transient handle. Caller must ``flush_context`` after use.

        Reference: tpm2-pytss/examples/sealing.py (load + policy_pcr).
        """
        return 0x80000001  # placeholder transient handle

    def _tpm_sign(self, esapi, handle, payload: bytes) -> bytes:
        """Sign with the loaded device key. Returns DER-encoded ECDSA
        signature.

        Reference: tpm2-pytss/examples/sign.py.
        """
        hashlib.sha256(payload).digest()  # ECDSA pre-hash
        return b""  # placeholder DER signature

    def _seal_against_current_pcrs(self, esapi, handle) -> bytes:
        """Re-derive PCR policy from current PCR values + re-export the
        private blob bound to the new policy. Returns updated
        ``TPM2B_PRIVATE`` blob bytes.

        Reference: tpm2-pytss/examples/sealing.py (re-sealing pattern).
        """
        return b"# WARP-230 updated TPM2B_PRIVATE placeholder"

    def _read_pcr_snapshot(self) -> dict[str, str]:
        """Read every PCR we care about. Returns ``{idx_str: hex_digest}``.

        Real implementation calls ``esapi.pcr_read`` for each index in
        ``self._sealing_pcrs`` or the canonical default set.
        """
        pcrs = self._sealing_pcrs or [0, 2, 4, 7]
        # Placeholder — returns all-zero digests so the status surface
        # still reports a deterministic shape during the scaffold phase.
        return {str(i): "0" * 64 for i in pcrs}

    def _verify_seal_against_current_pcrs(self) -> bool:
        """Attempt to unseal; True if successful, False if PCR policy
        rejects (i.e., the sealing PCRs have drifted since provision)."""
        try:
            with self._ESAPI() as esapi:
                handle = self._unseal_into_tpm(esapi)
                esapi.flush_context(handle)
            return True
        except Exception:  # noqa: BLE001 — tpm2-pytss raises many types
            return False

    def _self_sign_cert(self, device_id: str, public_key) -> bytes:
        """Build + self-sign a 5-year X.509 cert. Real implementation
        signs via :py:meth:`sign` (TPM-mediated) so the host never sees
        the private key during cert issuance.

        Reference: tpm2-pytss/examples/cert.py + cryptography.x509's
        ``CertificateBuilder.sign`` extension hook.
        """
        # Build the cert structure for the persisted artifact. The
        # signature on a TPM-backed cert must come from the TPM Sign
        # primitive; this scaffold returns the placeholder so the
        # storage + status paths still validate.
        now = dt.datetime.now(dt.timezone.utc)
        _ = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, device_id),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Droplet"),
        ])
        _ = now + dt.timedelta(days=DEVICE_CERT_VALIDITY_DAYS)
        return (
            b"-----BEGIN CERTIFICATE-----\n"
            b"# WARP-230 real-backend cert placeholder - TPM-signed body fills in\n"
            b"-----END CERTIFICATE-----\n"
        )
