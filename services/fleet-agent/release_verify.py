"""WARP-1025 — signed OTA release-manifest verification.

Python port of the WARP-537 verification library
(``apps/orchestrator/src/services/update-agent/manifest.ts`` +
``verify.ts``). The TypeScript library is the reference implementation;
this module mirrors its trust chain, canonical failure-reason strings,
and fail-closed posture, and its tests run against the SAME golden
fixtures (``__fixtures__/release.*.json`` + ``.sig``) so the two ports
prove cryptographic agreement rather than drifting.

Trust chain (same order as the TS library):

  1. **Trust anchor gate** — the baked-in ``cosign.pub`` next to this
     module. Fails closed on the WARP-535 placeholder marker, a missing
     file, or a non-PEM key, BEFORE any cosign spawn
     (``trust_anchor_placeholder``).
  2. **Signature gate** — exec the vendored ``cosign verify-blob``
     binary (pinned + checksum-verified in this service's Dockerfile,
     mirroring apps/orchestrator/Dockerfile) with
     ``--insecure-ignore-tlog=true``: private releases are signed with
     ``--tlog-upload=false`` (offline key-based verify, no Rekor entry
     to check — the public key IS the trust root). No crypto is
     reimplemented here; cosign is the verifier, exactly as in the TS
     library. A missing binary is ``cosign_unavailable`` (distinct from
     ``signature_failed`` so operators can tell "broken image" from
     "attack/corruption").
  3. **Parse gate** — pure validation of the signature-verified bytes
     against the schema-v1 shape ``scripts/release/gen-release-manifest.py``
     emits: ``malformed_manifest`` / ``schema_invalid`` /
     ``schema_downgrade`` (anti-rollback) / ``schema_unsupported``
     (forward-compat).

Deliberate divergences from the TS library (both documented in the
WARP-1025 PR):

  - ``release.minOrchestratorSchema`` is validated for SHAPE but NOT
    gated: that gate protects the orchestrator's *apply* step (prisma
    migrations, WARP-539) and compares against the orchestrator's own
    build constant, which this service does not have. The fleet-agent
    only reports candidates; the applier keeps enforcing its gate.
  - ``release.scope`` (optional) is accepted: the ratified ADR-028
    tag-selector object (``tier``/``channel``/``customer``/``region``/
    ``hw`` + ``device_id`` canary). The TS schema is non-strict and
    already passes it through untyped; here it is validated as a
    string→string mapping because update_poll.py targets on it.

TOCTOU guard (ported from the WARP-537 review fix, #798): callers hand
over the manifest BYTES, which are written once to a private ``mkdtemp``
path for cosign and parsed from the same in-memory buffer — no shared
path is ever re-read between verify and parse.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

# Bump when the manifest format itself changes shape (mirrors
# SUPPORTED_SCHEMA_VERSION in the TS library and SCHEMA_VERSION in
# scripts/release/gen-release-manifest.py — change them together).
SUPPORTED_SCHEMA_VERSION = 1

# Marker string in the WARP-535 placeholder cosign.pub. Its presence —
# or the absence of a PEM PUBLIC KEY block — means the key ceremony has
# not run and verification must refuse everything.
TRUST_ANCHOR_PLACEHOLDER_MARKER = "DROPLET-OTA-PLACEHOLDER"

# Canonical failure-reason vocabulary — identical strings to the TS
# library's UpdateFailureReason union so log/audit events speak one
# language across both ports ("orchestrator_schema_unsupported" is
# deliberately absent, see the module docstring).
FAILURE_REASONS = frozenset(
    {
        "trust_anchor_placeholder",
        "cosign_unavailable",
        "signature_failed",
        "malformed_manifest",
        "schema_invalid",
        "schema_downgrade",
        "schema_unsupported",
    }
)

_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")
_SERVICE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

_COSIGN_TIMEOUT_S = 30.0


@dataclass(frozen=True)
class VerifyResult:
    """Outcome of any gate in the chain. ``ok=True`` carries the parsed
    manifest (composed flow) or nothing (signature-only flow); every
    refusal carries a canonical ``failure_reason`` + human detail."""

    ok: bool
    manifest: Optional[dict] = None
    failure_reason: Optional[str] = None
    detail: str = ""


def default_trust_anchor_path() -> Path:
    """The baked-in trust anchor shipped next to this module
    (``services/fleet-agent/cosign.pub`` — COPY'd into the image with the
    rest of the service). Deliberately NOT env-overridable: tests inject
    a key path per-call, production always uses the baked-in file
    (mirrors the TS library)."""
    return Path(__file__).resolve().parent / "cosign.pub"


def _check_trust_anchor(public_key_path: Path) -> Optional[VerifyResult]:
    """Trust-anchor gate. None when the anchor is a real PEM public key;
    otherwise the fail-closed refusal."""
    try:
        content = public_key_path.read_text(encoding="utf-8")
    except OSError:
        return VerifyResult(
            ok=False,
            failure_reason="trust_anchor_placeholder",
            detail=(
                f"trust anchor missing at {public_key_path} — the fleet-agent "
                "image must bake in cosign.pub (WARP-1025); refusing to verify anything"
            ),
        )
    if TRUST_ANCHOR_PLACEHOLDER_MARKER in content:
        return VerifyResult(
            ok=False,
            failure_reason="trust_anchor_placeholder",
            detail=(
                "cosign.pub is the WARP-535 placeholder — run the key ceremony "
                '(scripts/README.md, "OTA release signing") before any OTA '
                "release can verify"
            ),
        )
    if "-----BEGIN PUBLIC KEY-----" not in content:
        return VerifyResult(
            ok=False,
            failure_reason="trust_anchor_placeholder",
            detail=f"trust anchor at {public_key_path} is not a PEM public key — refusing to verify",
        )
    return None


async def verify_release_signature(
    manifest_path: Path,
    signature_path: Path,
    public_key_path: Optional[Path] = None,
    cosign_bin: Optional[str] = None,
) -> VerifyResult:
    """Verify the detached cosign signature over the manifest bytes at
    ``manifest_path``. Spawns ``cosign verify-blob``; never interprets the
    manifest content. ``public_key_path``/``cosign_bin`` overrides are for
    tests only — production uses the baked-in anchor and the vendored
    binary (``cosign`` on PATH; DROPLET_COSIGN_BIN for dev hosts is
    resolved by the caller-facing default below)."""
    anchor = Path(public_key_path) if public_key_path else default_trust_anchor_path()
    refusal = _check_trust_anchor(anchor)
    if refusal:
        return refusal

    bin_ = cosign_bin or os.environ.get("DROPLET_COSIGN_BIN") or "cosign"
    args = [
        "verify-blob",
        "--key",
        str(anchor),
        "--signature",
        str(signature_path),
        # Private releases signed with --tlog-upload=false have no Rekor
        # entry; offline key-based verification is the design (WARP-536).
        "--insecure-ignore-tlog=true",
        str(manifest_path),
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            bin_,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (FileNotFoundError, PermissionError) as exc:
        return VerifyResult(
            ok=False,
            failure_reason="cosign_unavailable",
            detail=(
                f"could not exec cosign at {bin_} ({type(exc).__name__}) — the "
                "fleet-agent image vendors it at /usr/local/bin/cosign; set "
                "DROPLET_COSIGN_BIN in dev"
            ),
        )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=_COSIGN_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        return VerifyResult(
            ok=False,
            failure_reason="signature_failed",
            detail=f"cosign verify-blob timed out after {_COSIGN_TIMEOUT_S:.0f}s",
        )
    if proc.returncode == 0:
        return VerifyResult(ok=True)
    return VerifyResult(
        ok=False,
        failure_reason="signature_failed",
        detail=(
            "cosign verify-blob rejected the signature: "
            f"{stderr.decode('utf-8', 'replace').strip() or f'exit {proc.returncode}'}"
        ),
    )


def _validate_scope(scope: object, issues: list[str]) -> None:
    """``release.scope`` — the optional ADR-028 tag-selector object. Shape
    only (string→string); vocabulary matching is update_poll.py's job so
    a future selector key fails TARGETING (not-in-scope), not parsing."""
    if not isinstance(scope, dict):
        issues.append("release.scope: must be an object of string selectors")
        return
    for key, value in scope.items():
        if not isinstance(key, str) or not isinstance(value, str) or not value:
            issues.append(
                f"release.scope.{key}: selector values must be non-empty strings"
            )


def _validate_healthcheck(hc: object, prefix: str, issues: list[str]) -> None:
    if not isinstance(hc, dict):
        issues.append(f"{prefix}: healthcheck must be an object")
        return
    hc_type = hc.get("type")
    if hc_type == "none":
        return
    if hc_type != "http":
        issues.append(f"{prefix}.type: healthcheck type must be 'http' or 'none'")
        return
    port = hc.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or not (1 <= port <= 65535):
        issues.append(f"{prefix}.port: must be an integer between 1 and 65535")
    path_value = hc.get("path")
    if not isinstance(path_value, str) or not path_value.startswith("/"):
        issues.append(f"{prefix}.path: healthcheck path must start with /")


def parse_release_manifest(raw: bytes | str) -> VerifyResult:
    """Parse + schema-validate a ``release.json`` body. Pure function over
    the raw bytes; the caller is responsible for having verified the
    cosign signature over these exact bytes first."""
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw

    try:
        doc = json.loads(text)
    except ValueError as exc:
        return VerifyResult(
            ok=False,
            failure_reason="malformed_manifest",
            detail=f"release.json is not valid JSON: {exc}",
        )
    if not isinstance(doc, dict):
        return VerifyResult(
            ok=False,
            failure_reason="malformed_manifest",
            detail="release.json must be a JSON object",
        )

    # Version gates BEFORE full shape validation: a downgraded/newer
    # manifest may legitimately differ in shape, and the version verdict
    # is the actionable one.
    schema_version = doc.get("schemaVersion")
    if isinstance(schema_version, bool) or not isinstance(schema_version, int):
        return VerifyResult(
            ok=False,
            failure_reason="schema_invalid",
            detail="schemaVersion must be an integer",
        )
    if schema_version < SUPPORTED_SCHEMA_VERSION:
        return VerifyResult(
            ok=False,
            failure_reason="schema_downgrade",
            detail=(
                f"manifest schemaVersion {schema_version} is older than supported "
                f"version {SUPPORTED_SCHEMA_VERSION} — refusing downgrade"
            ),
        )
    if schema_version > SUPPORTED_SCHEMA_VERSION:
        return VerifyResult(
            ok=False,
            failure_reason="schema_unsupported",
            detail=(
                f"manifest schemaVersion {schema_version} is newer than supported "
                f"version {SUPPORTED_SCHEMA_VERSION} — update the agent first"
            ),
        )

    issues: list[str] = []

    release = doc.get("release")
    if not isinstance(release, dict):
        issues.append("release: must be an object")
        release = {}
    git_sha = release.get("gitSha")
    if not isinstance(git_sha, str) or not _GIT_SHA_RE.match(git_sha):
        issues.append("release.gitSha: gitSha must be a full 40-hex commit sha")
    built_at = release.get("builtAt")
    if not isinstance(built_at, str) or not _parseable_timestamp(built_at):
        issues.append("release.builtAt: builtAt must be an ISO-8601 timestamp")
    channel = release.get("channel")
    if not isinstance(channel, str) or not channel:
        issues.append("release.channel: must be a non-empty string")
    min_schema = release.get("minOrchestratorSchema")
    if isinstance(min_schema, bool) or not isinstance(min_schema, int) or min_schema < 1:
        issues.append("release.minOrchestratorSchema: must be an integer >= 1")
    if "scope" in release and release["scope"] is not None:
        _validate_scope(release["scope"], issues)

    services = doc.get("services")
    if not isinstance(services, list) or not services:
        issues.append("services: must be a non-empty array")
        services = []
    names: list[str] = []
    for i, svc in enumerate(services):
        prefix = f"services.{i}"
        if not isinstance(svc, dict):
            issues.append(f"{prefix}: must be an object")
            continue
        name = svc.get("name")
        if not isinstance(name, str) or not _SERVICE_NAME_RE.match(name):
            issues.append(f"{prefix}.name: invalid service name")
        else:
            names.append(name)
        digest = svc.get("digest")
        if not isinstance(digest, str) or not _DIGEST_RE.match(digest):
            issues.append(f"{prefix}.digest: digest must be sha256:<64 hex>")
        image = svc.get("image")
        if not isinstance(image, str) or not image:
            issues.append(f"{prefix}.image: must be a non-empty string")
        elif isinstance(digest, str) and not image.endswith(f"@{digest}"):
            issues.append(
                f"{prefix}.image: image must be pinned by its own digest (…@sha256:<64 hex>)"
            )
        _validate_healthcheck(svc.get("healthcheck"), f"{prefix}.healthcheck", issues)
    if len(set(names)) != len(names):
        issues.append("services: services must have unique names")

    configs = doc.get("configs")
    if not isinstance(configs, dict):
        issues.append("configs: must be an object")
    else:
        file_value = configs.get("file")
        if not isinstance(file_value, str) or not file_value:
            issues.append("configs.file: must be a non-empty string")
        sha = configs.get("sha256")
        if not isinstance(sha, str) or not _SHA256_HEX_RE.match(sha):
            issues.append("configs.sha256: configs.sha256 must be 64 hex chars")

    if issues:
        return VerifyResult(
            ok=False, failure_reason="schema_invalid", detail="; ".join(issues)
        )
    return VerifyResult(ok=True, manifest=doc)


def _parseable_timestamp(value: str) -> bool:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


async def verify_and_parse_release(
    manifest_bytes: bytes,
    signature_bytes: bytes,
    public_key_path: Optional[Path] = None,
    cosign_bin: Optional[str] = None,
) -> VerifyResult:
    """The full trust chain: trust anchor → cosign signature → parse.
    Only signature-verified bytes ever reach the parser.

    TOCTOU guard (ported from WARP-537 #798): the caller hands over BYTES;
    they are written once to a private ``mkdtemp`` directory only this
    process knows (cosign needs file paths), and the SAME in-memory bytes
    are parsed afterwards — no shared path is ever re-read between verify
    and parse. (The signature needs no such treatment: whatever bytes are
    there, verification only succeeds if they are a valid signature by the
    trusted key over the exact bytes we parse.)"""
    private_dir = Path(tempfile.mkdtemp(prefix="droplet-ota-verify-"))
    try:
        manifest_path = private_dir / "release.json"
        signature_path = private_dir / "release.json.sig"
        manifest_path.touch(mode=0o600)
        manifest_path.write_bytes(manifest_bytes)
        signature_path.write_bytes(signature_bytes)
        sig = await verify_release_signature(
            manifest_path,
            signature_path,
            public_key_path=public_key_path,
            cosign_bin=cosign_bin,
        )
        if not sig.ok:
            return sig
    finally:
        shutil.rmtree(private_dir, ignore_errors=True)

    return parse_release_manifest(manifest_bytes)
