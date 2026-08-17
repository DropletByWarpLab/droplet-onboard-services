"""WARP-1025 — the signed update-poll (ADR-028's fleet-plane mount).

Ports the discover→download→verify flow of the WARP-538 orchestrator
poller (``apps/orchestrator/src/services/update-agent/poller.ts``) into
the ONE on-device agent, per the ratified ADR-028 decision — as one more
apscheduler job (agent.py), not a second process.

What it does, every ~5 minutes when the operator has opted in:

  1. Discover the newest release for THIS BOX'S CHANNEL
     (``DROPLET_UPDATE_CHANNEL``, WARP-1670). On ``stable`` that is a GET
     of the GitHub Releases ``latest`` endpoint of the ``releases``
     publisher (``DROPLET_OTA_RELEASES_URL`` — same deployment knob the
     orchestrator poller reads). Every other channel publishes as a
     PRERELEASE, which ``latest`` skips by design, so those channels GET
     the releases list instead and take the newest entry tagged
     ``ota-<channel>-*``. That tag match is a cheap pre-filter over
     unsigned metadata; step 4 still decides on the signed manifest.
  2. Download the ``release.json`` + ``release.json.sig`` assets.
  3. Run the full WARP-537 trust chain (release_verify.py): trust anchor
     → cosign signature → schema. An unsigned/tampered/invalid manifest
     is REJECTED and AUDITED: a warn-level ``update.signature_failed`` /
     ``update.verify_failed`` log event plus a fingerprinted report on
     the agent's error queue (drained to the portal by the existing
     errors tick when telemetry is enabled). Unverified data never
     touches the candidate record.
  4. Target: the ratified ADR-028 tag-selector vocabulary. The release
     ``channel`` must equal the box's channel, and every selector in the
     optional ``release.scope`` object (``tier`` / ``channel`` /
     ``customer`` / ``region`` / ``hw``, plus ``device_id`` canary) must
     match the box's tags. An unknown selector key can never match —
     fail-closed targeting.
  5. Record the candidate (``update-candidate.json`` in the state dir)
     and log ``update.candidate_recorded``. Re-seeing the same
     ``gitSha`` is a no-op; a newer release overwrites the record — the
     fleet plane tracks "latest verified candidate", while the
     append-only audit history of updates stays with the orchestrator's
     DeviceUpdate table (WARP-537/538).

What it deliberately does NOT do: apply anything, restart anything,
open any control channel. Observe-only, like every other job in this
agent. Poll failure of any shape — endpoint unreachable, 5xx, TLS
failure — is a typed outcome, never an exception that could reach the
scheduler (and the mounting tick is `_fail_open`-wrapped on top).

EGRESS AUDIT (ADR-012 discipline — everything this module can dial;
the README carries the service-wide table):

    GET {releases}                      ~5 min (opt-in, stable channel) —
                                        release metadata
    GET {releases-list}                 ~5 min (opt-in, non-stable channel)
                                        — same host/path minus `/latest`,
                                        `?per_page=30`
    GET <asset url from that response>  per release — release.json / .sig bytes

``{releases}`` = DROPLET_OTA_RELEASES_URL; ``{releases-list}`` is derived
from it, so this adds no new host. Asset URLs are taken from the
releases endpoint's own response (GitHub Releases asset API + its CDN
redirect), never from the manifest content. Nothing else is ever dialed;
every attempt is logged on the ``fleet_agent.egress`` logger. No payload
is sent beyond the optional Authorization header.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

import httpx

from collectors import utc_now_iso
from config import AgentConfig
from errors import ErrorReporter
from release_verify import verify_and_parse_release
from state import StateStore

logger = logging.getLogger("fleet_agent.update")
egress_logger = logging.getLogger("fleet_agent.egress")

_DEFAULT_TIMEOUT_S = 30.0

# The ratified ADR-028 selector vocabulary (question 3): the portal's
# machine model dimensions, plus the device_id canary.
TARGETING_KEYS = ("device_id", "tier", "channel", "customer", "region", "hw")

# WARP-1670 — how deep to look for a non-stable channel's newest release.
# GitHub returns releases newest-first and the channels interleave, so this
# is "how many releases back a stage box still finds its build". One page
# keeps a poll to a single request.
RELEASES_LIST_PAGE_SIZE = 30


def channel_tag_prefix(channel: str) -> str:
    """The tag prefix a channel's releases carry (publish-release.yml)."""
    return f"ota-{channel}-"


def releases_list_url(releases_url: str, per_page: int = RELEASES_LIST_PAGE_SIZE):
    """``…/releases/latest`` → ``…/releases?per_page=<n>``.

    Returns None when the configured URL is not a ``latest`` endpoint (a
    file-served test fake, say), which callers must surface as a
    configuration failure rather than "no release"."""
    parsed = urlsplit(releases_url)
    if not parsed.path.endswith("/releases/latest"):
        return None
    path = parsed.path[: -len("/latest")]
    return urlunsplit(
        (parsed.scheme, parsed.netloc, path, f"per_page={per_page}", "")
    )


@dataclass(frozen=True)
class PollOutcome:
    """Typed result of one poll tick — mirrors the WARP-538 poller's
    CheckForUpdateResult vocabulary, with `not_targeted` generalizing its
    channel gate to the full selector vocabulary and `candidate_recorded`
    in place of the DB-backed `pending_created`."""

    outcome: str  # no_release | fetch_failed | verify_failed | not_targeted
    #             # | already_known | candidate_recorded
    detail: str = ""
    failure_reason: Optional[str] = None
    git_sha: Optional[str] = None


def matches_target(manifest: dict, box_tags: dict) -> tuple[bool, str, str]:
    """ADR-028 tag-selector match: (matched, event, detail).

    The release channel must equal the box channel (the WARP-538 channel
    gate, unchanged), and every key present in the optional
    ``release.scope`` selector must equal the box's tag of the same name.
    A selector key the box has no tag for — including a future vocabulary
    key this build doesn't know — can never match: targeting fails
    closed."""
    release = manifest["release"]
    channel = release["channel"]
    box_channel = box_tags.get("channel")
    if channel != box_channel:
        return (
            False,
            "update.channel_mismatch",
            f"release channel {channel!r} != device channel {box_channel!r}",
        )
    scope = release.get("scope") or {}
    for key, value in scope.items():
        if box_tags.get(key) != value:
            return (
                False,
                "update.scope_mismatch",
                f"scope selector {key}={value!r} does not match device tag "
                f"{key}={box_tags.get(key)!r}",
            )
    return True, "", ""


class UpdatePoller:
    """Fail-open by construction: `poll_once()` returns a typed outcome
    for every expected failure shape; only genuine bugs raise (and the
    agent's `_fail_open` tick wrapper swallows those too)."""

    def __init__(
        self,
        config: AgentConfig,
        state: StateStore,
        errors: ErrorReporter,
        client: Optional[httpx.AsyncClient] = None,
        public_key_path: Optional[Path] = None,
        cosign_bin: Optional[str] = None,
    ) -> None:
        self._config = config
        self._state = state
        self._errors = errors
        # follow_redirects: GitHub asset downloads 302 to a CDN URL.
        self._client = client or httpx.AsyncClient(
            timeout=_DEFAULT_TIMEOUT_S, follow_redirects=True
        )
        # Test-only overrides, mirroring the TS library: production uses
        # the baked-in trust anchor + the vendored cosign binary.
        self._public_key_path = public_key_path
        self._cosign_bin = cosign_bin

    async def aclose(self) -> None:
        await self._client.aclose()

    def box_tags(self) -> dict:
        """This box's targeting tags in the ratified vocabulary. Unset
        dimensions are OMITTED (a selector on them then never matches —
        fail-closed). device_id is the portal machine_id and exists only
        once the box has registered (WARP-963)."""
        cfg = self._config
        tags = {"tier": cfg.tier, "channel": cfg.update_channel}
        if cfg.customer:
            tags["customer"] = cfg.customer
        if cfg.geo_region:
            tags["region"] = cfg.geo_region
        if cfg.hardware_revision:
            tags["hw"] = cfg.hardware_revision
        identity = self._state.identity()
        if identity:
            tags["device_id"] = identity.machine_id
        return tags

    async def _discover_latest(self, headers: dict):
        """`stable` discovery: GitHub's `latest` release. Returns the
        release metadata dict, or a terminal PollOutcome."""
        url = self._config.releases_url
        try:
            response = await self._client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            detail = f"releases latest endpoint unreachable: {exc}"
            egress_logger.warning("egress GET %s failed: %s", url, exc)
            logger.warning("update.check_failed — %s", detail)
            return PollOutcome(outcome="fetch_failed", detail=detail)
        egress_logger.debug("egress GET %s -> %d", url, response.status_code)
        if response.status_code == 404:
            # No release published yet — normal on a fresh repo.
            logger.debug("update.no_release — no OTA release published yet")
            return PollOutcome(outcome="no_release")
        if response.status_code < 200 or response.status_code >= 300:
            detail = f"releases latest endpoint returned HTTP {response.status_code}"
            logger.warning("update.check_failed — %s", detail)
            return PollOutcome(outcome="fetch_failed", detail=detail)
        try:
            release_meta = response.json()
        except ValueError:
            detail = "releases latest endpoint returned non-JSON body"
            logger.warning("update.check_failed — %s", detail)
            return PollOutcome(outcome="fetch_failed", detail=detail)
        return release_meta if isinstance(release_meta, dict) else {}

    async def _discover_for_channel(self, channel: str, headers: dict):
        """Non-stable discovery: the newest listed release whose tag
        carries this channel's prefix. Returns the release metadata dict,
        or a terminal PollOutcome.

        The tag match is a CHEAP PRE-FILTER over unsigned repo metadata.
        The channel that decides whether this box installs anything is the
        one inside the cosign-verified manifest, checked in step 4 exactly
        as it is for stable."""
        url = releases_list_url(self._config.releases_url)
        if not url:
            # Misconfiguration, not absence — a box that can never discover
            # must say so, not report "no release" every five minutes.
            detail = (
                f"channel {channel!r} needs a releases list endpoint, and none "
                f"could be derived from {self._config.releases_url}"
            )
            logger.warning("update.check_failed — %s", detail)
            return PollOutcome(outcome="fetch_failed", detail=detail)
        try:
            response = await self._client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            detail = f"releases list endpoint unreachable: {exc}"
            egress_logger.warning("egress GET %s failed: %s", url, exc)
            logger.warning("update.check_failed — %s", detail)
            return PollOutcome(outcome="fetch_failed", detail=detail)
        egress_logger.debug("egress GET %s -> %d", url, response.status_code)
        if response.status_code < 200 or response.status_code >= 300:
            detail = f"releases list endpoint returned HTTP {response.status_code}"
            logger.warning("update.check_failed — %s", detail)
            return PollOutcome(outcome="fetch_failed", detail=detail)
        try:
            listed = response.json()
        except ValueError:
            detail = "releases list endpoint returned non-JSON body"
            logger.warning("update.check_failed — %s", detail)
            return PollOutcome(outcome="fetch_failed", detail=detail)
        if not isinstance(listed, list):
            detail = "releases list endpoint did not return an array"
            logger.warning("update.check_failed — %s", detail)
            return PollOutcome(outcome="fetch_failed", detail=detail)
        # GitHub returns releases newest-first.
        prefix = channel_tag_prefix(channel)
        for entry in listed:
            if not isinstance(entry, dict):
                continue
            if str(entry.get("tag_name") or "").startswith(prefix):
                return entry
        logger.debug(
            "update.no_release — no OTA release published yet for channel %s", channel
        )
        return PollOutcome(outcome="no_release")

    async def poll_once(self) -> PollOutcome:
        logger.debug("update.check_started — OTA release check started")

        # ── 1. discover the newest release FOR THIS BOX'S CHANNEL ──
        # WARP-1670: `stable` reads GitHub's `latest` endpoint, which
        # already skips prereleases. Every other channel publishes AS a
        # prerelease (so it stays invisible to stable boxes), so `latest`
        # would never return it — those channels list releases and take
        # the newest carrying the channel's tag prefix.
        headers = {"Accept": "application/vnd.github+json"}
        if self._config.github_token:
            headers["Authorization"] = f"Bearer {self._config.github_token}"
        channel = self._config.update_channel
        if channel == "stable":
            outcome_or_meta = await self._discover_latest(headers)
        else:
            outcome_or_meta = await self._discover_for_channel(channel, headers)
        if isinstance(outcome_or_meta, PollOutcome):
            return outcome_or_meta
        release_meta = outcome_or_meta

        release_tag = str(release_meta.get("tag_name") or "(untagged)")
        assets = release_meta.get("assets")
        assets = assets if isinstance(assets, list) else []
        by_name = {
            a.get("name"): a.get("url")
            for a in assets
            if isinstance(a, dict) and isinstance(a.get("url"), str)
        }
        manifest_url = by_name.get("release.json")
        sig_url = by_name.get("release.json.sig")
        if not manifest_url or not sig_url:
            detail = f"release {release_tag} is missing release.json/.sig assets"
            logger.warning("update.check_failed — %s", detail)
            return PollOutcome(outcome="fetch_failed", detail=detail)

        # ── 2. download the manifest + signature bytes ──
        try:
            manifest_bytes = await self._download(manifest_url)
            sig_bytes = await self._download(sig_url)
        except httpx.HTTPError as exc:
            detail = f"release asset download failed: {exc}"
            logger.warning("update.check_failed — %s", detail)
            return PollOutcome(outcome="fetch_failed", detail=detail)

        # ── 3. WARP-537 trust chain over the downloaded bytes ──
        verified = await verify_and_parse_release(
            manifest_bytes,
            sig_bytes,
            public_key_path=self._public_key_path,
            cosign_bin=self._cosign_bin,
        )
        if not verified.ok:
            # Rejected + audited (AC): warn log event (the event name
            # distinguishes cryptographic refusal from schema refusals so
            # alerting can treat tampering as its own signal) + a
            # fingerprinted error report the errors tick pushes to the
            # portal when telemetry is on. No candidate is recorded.
            event = (
                "update.signature_failed"
                if verified.failure_reason == "signature_failed"
                else "update.verify_failed"
            )
            logger.warning(
                "%s — OTA release %s failed verification (%s): %s — rejected, "
                "no candidate recorded",
                event,
                release_tag,
                verified.failure_reason,
                verified.detail,
            )
            self._errors.report(
                severity="error",
                service="fleet-agent",
                title="OTA release manifest rejected",
                message=f"{verified.failure_reason}: release {release_tag}: {verified.detail[:400]}",
            )
            return PollOutcome(
                outcome="verify_failed",
                failure_reason=verified.failure_reason,
                detail=verified.detail,
            )
        manifest = verified.manifest
        assert manifest is not None  # ok=True always carries the manifest

        # ── 4. ADR-028 tag-selector targeting ──
        matched, event, detail = matches_target(manifest, self.box_tags())
        if not matched:
            logger.info("%s — OTA release %s not for this box: %s", event, release_tag, detail)
            return PollOutcome(
                outcome="not_targeted",
                detail=detail,
                git_sha=manifest["release"]["gitSha"],
            )

        # ── 5. record the candidate ──
        git_sha = manifest["release"]["gitSha"]
        existing = self._state.update_candidate()
        if existing and existing.get("git_sha") == git_sha:
            logger.debug(
                "update.already_known — latest OTA release %s already recorded", git_sha
            )
            return PollOutcome(outcome="already_known", git_sha=git_sha)

        candidate = {
            "git_sha": git_sha,
            "release_tag": release_tag,
            "channel": manifest["release"]["channel"],
            "built_at": manifest["release"]["builtAt"],
            "scope": manifest["release"].get("scope") or {},
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "services": [
                {"name": s["name"], "digest": s["digest"]} for s in manifest["services"]
            ],
            "discovered_at": utc_now_iso(),
        }
        self._state.save_update_candidate(candidate)
        logger.info(
            "update.candidate_recorded — verified OTA release %s (tag %s) recorded "
            "as the update candidate",
            git_sha,
            release_tag,
        )
        return PollOutcome(outcome="candidate_recorded", git_sha=git_sha)

    async def _download(self, url: str) -> bytes:
        headers = {"Accept": "application/octet-stream"}
        if self._config.github_token:
            headers["Authorization"] = f"Bearer {self._config.github_token}"
        try:
            response = await self._client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            egress_logger.warning("egress GET %s failed: %s", url, exc)
            raise
        egress_logger.debug("egress GET %s -> %d", url, response.status_code)
        if response.status_code < 200 or response.status_code >= 300:
            raise httpx.HTTPStatusError(
                f"asset download failed: HTTP {response.status_code}",
                request=response.request,
                response=response,
            )
        return response.content
