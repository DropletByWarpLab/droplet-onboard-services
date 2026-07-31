"""WARP-1025 — release_verify is a Python port of the WARP-537 library
and is proven against the SAME golden fixtures the TypeScript tests use
(apps/orchestrator/src/services/update-agent/__fixtures__/), execing the
REAL cosign binary: genuine cryptographic accept/reject, never a mocked
exit code. A missing cosign binary FAILS the signature tests loudly
(surfacing as cosign_unavailable where ok=True is asserted) — it never
skips, because a skipped trust test is a hole. CI installs cosign via
sigstore/cosign-installer; locally install cosign or set
DROPLET_COSIGN_BIN.

Trust-chain order under test (mirrors verify.test.ts + manifest.test.ts):
  1. trust anchor gate  — placeholder/missing key fails closed BEFORE any
     cosign spawn;
  2. signature gate     — tampered bytes and wrong-key signatures are
     `signature_failed`;
  3. parse gate         — only signature-verified bytes reach
     parse_release_manifest; canonical failure reasons asserted exactly.
"""

from __future__ import annotations

import json
from pathlib import Path

from release_verify import (
    SUPPORTED_SCHEMA_VERSION,
    TRUST_ANCHOR_PLACEHOLDER_MARKER,
    default_trust_anchor_path,
    parse_release_manifest,
    verify_and_parse_release,
    verify_release_signature,
)

# The WARP-537 golden fixtures — shared with the TS library on purpose:
# one fixture corpus, two ports, provable agreement.
_FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "orchestrator"
    / "src"
    / "services"
    / "update-agent"
    / "__fixtures__"
)
KEY = _FIXTURES / "TEST-ONLY-signing.pub"


def fx(name: str) -> bytes:
    return (_FIXTURES / name).read_bytes()


# ---------------------------------------------------------------------------
# Signature gate (real cosign)
# ---------------------------------------------------------------------------


async def test_valid_manifest_verifies_and_parses():
    res = await verify_and_parse_release(
        fx("release.valid.json"), fx("release.valid.json.sig"), public_key_path=KEY
    )
    assert res.ok, res.detail
    assert res.manifest is not None
    assert res.manifest["schemaVersion"] == SUPPORTED_SCHEMA_VERSION
    assert res.manifest["release"]["gitSha"] == "0123456789abcdef0123456789abcdef01234567"
    assert res.manifest["release"]["channel"] == "stable"
    assert len(res.manifest["services"]) == 3


async def test_tampered_manifest_rejected_at_signature_gate():
    res = await verify_and_parse_release(
        fx("release.tampered.json"), fx("release.tampered.json.sig"), public_key_path=KEY
    )
    assert not res.ok
    assert res.failure_reason == "signature_failed"


async def test_wrong_key_signature_rejected():
    res = await verify_and_parse_release(
        fx("release.valid.json"),
        fx("release.valid.json.wrong-key.sig"),
        public_key_path=KEY,
    )
    assert not res.ok
    assert res.failure_reason == "signature_failed"


async def test_placeholder_anchor_fails_closed_without_spawning_cosign(tmp_path):
    # If the placeholder gate ever ran cosign first, the nonexistent
    # binary would surface as cosign_unavailable instead — asserting
    # trust_anchor_placeholder proves the anchor verdict dominates.
    res = await verify_and_parse_release(
        fx("release.valid.json"),
        fx("release.valid.json.sig"),
        public_key_path=_FIXTURES / "placeholder-cosign.pub",
        cosign_bin=str(tmp_path / "no-such-cosign-binary"),
    )
    assert not res.ok
    assert res.failure_reason == "trust_anchor_placeholder"


async def test_missing_anchor_fails_closed(tmp_path):
    res = await verify_and_parse_release(
        fx("release.valid.json"),
        fx("release.valid.json.sig"),
        public_key_path=tmp_path / "no-such-key.pub",
    )
    assert not res.ok
    assert res.failure_reason == "trust_anchor_placeholder"


async def test_non_pem_anchor_fails_closed(tmp_path):
    bogus = tmp_path / "bogus.pub"
    bogus.write_text("this is not a key\n", encoding="utf-8")
    res = await verify_and_parse_release(
        fx("release.valid.json"), fx("release.valid.json.sig"), public_key_path=bogus
    )
    assert not res.ok
    assert res.failure_reason == "trust_anchor_placeholder"


async def test_missing_cosign_binary_is_cosign_unavailable(tmp_path):
    res = await verify_release_signature(
        _FIXTURES / "release.valid.json",
        _FIXTURES / "release.valid.json.sig",
        public_key_path=KEY,
        cosign_bin=str(tmp_path / "no-such-cosign-binary"),
    )
    assert not res.ok
    assert res.failure_reason == "cosign_unavailable"


# ---------------------------------------------------------------------------
# Parse gate — signed-with-the-valid-key fixtures, so each rejection is
# provably from the named gate, not an incidental signature failure
# ---------------------------------------------------------------------------


async def test_signed_but_malformed_manifest_rejected():
    res = await verify_and_parse_release(
        fx("release.malformed.json"), fx("release.malformed.json.sig"), public_key_path=KEY
    )
    assert not res.ok
    assert res.failure_reason == "malformed_manifest"


async def test_signed_schema_downgrade_rejected():
    res = await verify_and_parse_release(
        fx("release.schema-downgrade.json"),
        fx("release.schema-downgrade.json.sig"),
        public_key_path=KEY,
    )
    assert not res.ok
    assert res.failure_reason == "schema_downgrade"


async def test_signed_schema_invalid_rejected_with_actionable_detail():
    res = await verify_and_parse_release(
        fx("release.schema-invalid.json"),
        fx("release.schema-invalid.json.sig"),
        public_key_path=KEY,
    )
    assert not res.ok
    assert res.failure_reason == "schema_invalid"
    # The detail must name at least one offending path so the audit
    # log event is actionable (mirrors manifest.test.ts).
    assert any(token in res.detail for token in ("gitSha", "services", "sha256"))


# ---------------------------------------------------------------------------
# parse_release_manifest — pure-function gates (mirrors manifest.test.ts)
# ---------------------------------------------------------------------------


def _valid_doc() -> dict:
    return json.loads(fx("release.valid.json"))


def test_parse_rejects_newer_schema_version_as_unsupported():
    doc = _valid_doc()
    doc["schemaVersion"] = SUPPORTED_SCHEMA_VERSION + 1
    res = parse_release_manifest(json.dumps(doc))
    assert not res.ok
    assert res.failure_reason == "schema_unsupported"


def test_parse_rejects_non_integer_schema_version():
    doc = _valid_doc()
    doc["schemaVersion"] = True  # bool is not an acceptable "integer"
    res = parse_release_manifest(json.dumps(doc))
    assert not res.ok
    assert res.failure_reason == "schema_invalid"


def test_parse_rejects_unpinned_image():
    doc = _valid_doc()
    doc["services"][0]["image"] = "ghcr.io/dropletbywarplab/droplet-orchestrator:latest"
    res = parse_release_manifest(json.dumps(doc))
    assert not res.ok
    assert res.failure_reason == "schema_invalid"


def test_parse_rejects_duplicate_service_names():
    doc = _valid_doc()
    doc["services"][1]["name"] = doc["services"][0]["name"]
    res = parse_release_manifest(json.dumps(doc))
    assert not res.ok
    assert res.failure_reason == "schema_invalid"


def test_parse_accepts_adr028_scope_selector_and_preserves_it():
    doc = _valid_doc()
    doc["release"]["scope"] = {"tier": "business", "region": "eu-central"}
    res = parse_release_manifest(json.dumps(doc))
    assert res.ok, res.detail
    assert res.manifest is not None
    assert res.manifest["release"]["scope"] == {"tier": "business", "region": "eu-central"}


def test_parse_rejects_non_string_scope_values():
    doc = _valid_doc()
    doc["release"]["scope"] = {"tier": 3}
    res = parse_release_manifest(json.dumps(doc))
    assert not res.ok
    assert res.failure_reason == "schema_invalid"
    assert "scope" in res.detail


def test_parse_does_not_gate_min_orchestrator_schema():
    """Deliberate divergence from the TS library (documented in the
    module + the WARP-1025 PR): the orchestrator-schema gate protects
    the APPLY step and compares against the orchestrator's own build
    constant. This service only reports candidates; the applier keeps
    enforcing its gate."""
    doc = _valid_doc()
    doc["release"]["minOrchestratorSchema"] = 999
    res = parse_release_manifest(json.dumps(doc))
    assert res.ok, res.detail


# ---------------------------------------------------------------------------
# Shipped trust anchor
# ---------------------------------------------------------------------------


def test_shipped_anchor_is_the_real_key_and_matches_the_orchestrator():
    """The committed services/fleet-agent/cosign.pub carries the REAL OTA
    signing key: the human key ceremony (scripts/README.md, "OTA release
    signing") stamped it over the WARP-535 placeholder on both copies.
    This test was inverted at that moment — the placeholder tripwire it
    used to be is what forced the edit.

    It stays as a REVERSE tripwire. A merge, a bad revert or a rebase that
    restores the placeholder would make every release fail closed on the
    box with no other signal; this catches that in CI. The byte-identical
    check is the other half: the two copies MUST stay in lockstep, because
    the fleet-agent poll and the orchestrator applier have to agree on
    what a valid release is. The placeholder-detection code path itself is
    still covered by the placeholder-cosign.pub fixture cases above."""
    anchor = default_trust_anchor_path()
    assert anchor.exists()
    content = anchor.read_text(encoding="utf-8")
    assert TRUST_ANCHOR_PLACEHOLDER_MARKER not in content
    assert "-----BEGIN PUBLIC KEY-----" in content
    orchestrator_anchor = (
        _FIXTURES.parent / "cosign.pub"
    )  # apps/orchestrator/src/services/update-agent/cosign.pub
    assert anchor.read_bytes() == orchestrator_anchor.read_bytes()
