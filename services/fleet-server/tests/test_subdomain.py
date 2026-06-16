"""ADR-023 §Decision 2 — opaque per-device subdomain label.

label = "d-" + HMAC-SHA256(HQ_LABEL_SECRET, device_id).hexdigest()[:16]
fqdn  = "<label>.<ISSUANCE_DOMAIN_BASE>"

Deterministic per (secret, device_id). Carries NO PII (keyed HMAC, not a
bare hash, so a CT-log enumerator can't confirm a guessed device_id).
"""

from __future__ import annotations

import hashlib
import hmac

import pytest

from issuance import subdomain


def test_label_is_deterministic_for_same_device():
    a = subdomain.public_label("device-abc")
    b = subdomain.public_label("device-abc")
    assert a == b


def test_label_differs_per_device():
    assert subdomain.public_label("device-abc") != subdomain.public_label("device-xyz")


def test_label_shape_d_prefix_16_hex():
    label = subdomain.public_label("device-abc")
    assert label.startswith("d-")
    body = label[2:]
    assert len(body) == 16
    assert all(c in "0123456789abcdef" for c in body)


def test_label_matches_keyed_hmac_exactly():
    secret = "pytest-fixed-label-secret"
    device_id = "device-abc"
    expected = "d-" + hmac.new(
        secret.encode("utf-8"), device_id.encode("utf-8"), hashlib.sha256
    ).hexdigest()[:16]
    assert subdomain.public_label(device_id) == expected


def test_label_is_keyed_not_bare_hash():
    # A bare sha256 of the device_id must NOT equal the label body — that
    # would let a CT-log enumerator confirm a guessed device_id.
    device_id = "device-abc"
    bare = hashlib.sha256(device_id.encode("utf-8")).hexdigest()[:16]
    assert subdomain.public_label(device_id)[2:] != bare


def test_fqdn_appends_domain_base():
    fqdn = subdomain.fqdn_for("device-abc")
    assert fqdn == subdomain.public_label("device-abc") + ".devices.warp-lab.ai"


def test_acme_challenge_record_name():
    # The transient TXT record the Cloudflare worker creates/deletes.
    name = subdomain.acme_challenge_record_name("device-abc")
    assert name == "_acme-challenge." + subdomain.fqdn_for("device-abc")


def test_empty_device_id_rejected():
    with pytest.raises(ValueError):
        subdomain.public_label("")
