"""CSR validation + fingerprinting for the issuance contract (ADR-023).

The box generates its own keypair + CSR; the private key NEVER leaves the
box (ADR-023 §Decision 1). HQ receives only the CSR PEM. Before kicking
off the ACME dance we enforce:

  * the CSR parses and its embedded self-signature verifies (proof the
    requester holds the corresponding private key);
  * its SubjectAlternativeName set contains EXACTLY one DNS name, equal to
    the device's derived fqdn — no extra SANs, no wildcard smuggling.

We also derive a stable ``csr_fingerprint`` (sha256 of the DER) used as
the idempotency key on (device_id, csr_fingerprint).
"""

from __future__ import annotations

import hashlib

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePublicKey
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey


class CsrValidationError(ValueError):
    """Raised when a submitted CSR is invalid or its SAN != fqdn."""


# Accepted box keypair policy (ADR-023 §Decision 1 — the box serving key is a
# TPM ECC P-256 key). We pin the acceptable key types HERE rather than letting
# a weak key fall through to Let's Encrypt: relying on the upstream CA to
# reject a weak key is a fail-open posture. EC P-256/P-384 (the TPM curves) or
# RSA >= 2048 are allowed; everything else is rejected.
_ALLOWED_EC_CURVES = frozenset({"secp256r1", "secp384r1"})
_MIN_RSA_BITS = 2048


def _assert_key_policy(req: x509.CertificateSigningRequest) -> None:
    """Raise CsrValidationError unless the CSR's public key meets policy."""
    pub = req.public_key()
    if isinstance(pub, EllipticCurvePublicKey):
        curve = pub.curve.name.lower()
        if curve not in _ALLOWED_EC_CURVES:
            raise CsrValidationError(f"disallowed EC curve {curve!r}")
        return
    if isinstance(pub, RSAPublicKey):
        if pub.key_size < _MIN_RSA_BITS:
            raise CsrValidationError(
                f"RSA key too small ({pub.key_size} bits, min {_MIN_RSA_BITS})"
            )
        return
    raise CsrValidationError(
        f"disallowed CSR key type {type(pub).__name__}"
    )


def _load(csr_pem: str) -> x509.CertificateSigningRequest:
    try:
        return x509.load_pem_x509_csr(csr_pem.encode("utf-8"))
    except (ValueError, TypeError) as exc:
        raise CsrValidationError(f"CSR did not parse: {exc}") from exc


def validate_csr(csr_pem: str, *, expected_fqdn: str) -> x509.CertificateSigningRequest:
    """Validate the CSR and assert its only SAN == ``expected_fqdn``.

    Returns the parsed CSR on success; raises :class:`CsrValidationError`
    otherwise.
    """
    req = _load(csr_pem)

    # The CSR is self-signed by the box's private key. A failed check
    # means the requester does not hold the key for this CSR.
    if not req.is_signature_valid:
        raise CsrValidationError("CSR self-signature is invalid")

    # Pin the box keypair policy (EC P-256/P-384 or RSA>=2048) — never fall
    # open to the upstream CA for key strength.
    _assert_key_policy(req)

    try:
        san_ext = req.extensions.get_extension_for_class(
            x509.SubjectAlternativeName
        )
    except x509.ExtensionNotFound as exc:
        raise CsrValidationError("CSR has no SubjectAlternativeName") from exc

    dns_names = san_ext.value.get_values_for_type(x509.DNSName)
    if len(dns_names) != 1:
        raise CsrValidationError(
            f"CSR must carry exactly one DNS SAN, got {len(dns_names)}"
        )
    if dns_names[0] != expected_fqdn:
        raise CsrValidationError(
            f"CSR SAN {dns_names[0]!r} != expected fqdn {expected_fqdn!r}"
        )
    return req


def csr_fingerprint(csr_pem: str) -> str:
    """Return the sha256 hex of the CSR's DER encoding — the idempotency
    key. Stable for byte-identical CSRs, distinct otherwise."""
    req = _load(csr_pem)
    der = req.public_bytes(serialization.Encoding.DER)
    return hashlib.sha256(der).hexdigest()
