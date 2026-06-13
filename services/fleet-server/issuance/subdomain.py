"""ADR-023 §Decision 2 — opaque per-device subdomain derivation.

    public_label = "d-" + HMAC-SHA256(HQ_LABEL_SECRET, device_id).hexdigest()[:16]
    fqdn         = "<public_label>.<ISSUANCE_DOMAIN_BASE>"

A *keyed* HMAC (not a bare hash) is mandatory: Certificate Transparency
publishes every issued FQDN, so the label must carry no PII and must not
let a CT-log enumerator confirm a guessed device_id. The label is
deterministic per (HQ secret, device_id) and is stored on the device's
first order so it stays stable across renewals.
"""

from __future__ import annotations

import hashlib
import hmac

import config

#: Length of the hex label body (after the "d-" prefix).
_LABEL_HEX_LEN = 16


def public_label(device_id: str) -> str:
    """Return the opaque ``d-<hmac16>`` label for a device.

    Deterministic for a given (HQ_LABEL_SECRET, device_id). Raises
    ValueError on an empty device_id so a misconfigured caller never
    mints a shared/blank label.
    """
    if not device_id:
        raise ValueError("device_id is required to derive a label")
    digest = hmac.new(
        config.hq_label_secret(), device_id.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return "d-" + digest[:_LABEL_HEX_LEN]


def fqdn_for(device_id: str) -> str:
    """Return the full per-device FQDN for a device."""
    return f"{public_label(device_id)}.{config.ISSUANCE_DOMAIN_BASE}"


def fqdn_for_label(label: str) -> str:
    """Return the FQDN for an already-derived label (avoids recomputing)."""
    return f"{label}.{config.ISSUANCE_DOMAIN_BASE}"


def acme_challenge_record_name(device_id: str) -> str:
    """The transient ``_acme-challenge.<fqdn>`` TXT record name.

    This is the ONLY record ever written to public DNS — and it is
    deleted after each order (ADR-023 §Decision 3: no public A/AAAA).
    """
    return f"_acme-challenge.{fqdn_for(device_id)}"
