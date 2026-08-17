"""WARP-1025 — the signed update-poll mount (ADR-028).

GitHub Releases is respx-mocked over the REAL WARP-537 golden fixture
bytes and signature verification execs the REAL cosign binary against
the TEST-ONLY fixture key — the discover→download→verify→record pipeline
runs end to end; only the network transport is mocked.

Acceptance criteria under test (WARP-1025):
  - update-poll lives in the SAME agent process, as one more apscheduler
    job behind its own opt-in gate;
  - fail-open: endpoint unreachable / 5xx / TLS failure / unexpected
    bugs never raise out of the tick and never touch other jobs;
  - signatures are verified BEFORE a candidate is reported; unsigned /
    invalid manifests are rejected + audited (warn event + fingerprinted
    error report) and never recorded;
  - targeting speaks the ratified ADR-028 tag-selector vocabulary
    (tier / channel / customer / region / hw + device_id canary).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
from pathlib import Path

import httpx
import pytest
import respx

from .conftest import FakeCollector, PORTAL_URL, register_response
from agent import FleetAgent
from config import load_config
from errors import ErrorReporter
from portal import PortalClient
from state import StateStore
from update_poll import UpdatePoller, matches_target, releases_list_url

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
SIGNING_KEY = _FIXTURES / "TEST-ONLY-signing.key"
# Deliberately-committed fixture-signing password (__fixtures__/README.md).
FIXTURE_KEY_PASSWORD = "droplet-test-fixtures"

RELEASES_URL = (
    "https://api.github.com/repos/DropletByWarpLab/droplet-onboard-services/releases/latest"
)
MANIFEST_ASSET_URL = "https://api.github.com/assets/release-json"
SIG_ASSET_URL = "https://api.github.com/assets/release-json-sig"

VALID_GIT_SHA = "0123456789abcdef0123456789abcdef01234567"


def fx(name: str) -> bytes:
    return (_FIXTURES / name).read_bytes()


def update_env(state_dir: Path, **extra: str) -> dict:
    env = {
        "DROPLET_UPDATE_POLL_ENABLED": "1",
        "DROPLET_OTA_RELEASES_URL": RELEASES_URL,
        "DROPLET_TELEMETRY_STATE_DIR": str(state_dir),
        "DROPLET_FIRMWARE_VERSION": "0.9.3+pytest",
        "DROPLET_HOSTNAME": "droplet-pytest",
    }
    env.update(extra)
    return env


def build_poller(
    env: dict, errors: ErrorReporter | None = None
) -> tuple[UpdatePoller, StateStore, ErrorReporter]:
    cfg = load_config(env)
    store = StateStore(cfg.state_dir)
    reporter = errors or ErrorReporter()
    poller = UpdatePoller(
        config=cfg, state=store, errors=reporter, public_key_path=KEY
    )
    return poller, store, reporter


def serve_release(tag: str, manifest: bytes, signature: bytes) -> None:
    respx.get(RELEASES_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "tag_name": tag,
                "assets": [
                    {"name": "release.json", "url": MANIFEST_ASSET_URL},
                    {"name": "release.json.sig", "url": SIG_ASSET_URL},
                    {"name": "configs.tar.gz", "url": "https://api.github.com/assets/x"},
                ],
            },
        )
    )
    respx.get(MANIFEST_ASSET_URL).mock(return_value=httpx.Response(200, content=manifest))
    respx.get(SIG_ASSET_URL).mock(return_value=httpx.Response(200, content=signature))


def sign_at_test_time(manifest: bytes, tmp_path: Path) -> bytes:
    """Sign a constructed manifest with the committed TEST-ONLY fixture
    key via the real cosign CLI — same key, same envelope as the golden
    fixtures (the fixtures README explicitly blesses this). Offline:
    --tlog-upload=false, like the publish workflow."""
    manifest_path = tmp_path / "generated-release.json"
    sig_path = tmp_path / "generated-release.json.sig"
    manifest_path.write_bytes(manifest)
    base = [
        os.environ.get("DROPLET_COSIGN_BIN", "cosign"),
        "sign-blob",
        "--yes",
        "--key",
        str(SIGNING_KEY),
        "--tlog-upload=false",
        "--output-signature",
        str(sig_path),
        str(manifest_path),
    ]
    # cosign 3.x defaults to signing-config + bundle output; these two
    # flags restore the detached-signature offline shape. cosign < 2.5
    # doesn't know them, so fall back to the legacy flag set.
    modern = base[:2] + ["--use-signing-config=false", "--new-bundle-format=false"] + base[2:]
    env = {**os.environ, "COSIGN_PASSWORD": FIXTURE_KEY_PASSWORD}
    result = subprocess.run(modern, capture_output=True, env=env)
    if result.returncode != 0:
        subprocess.run(base, check=True, capture_output=True, env=env)
    return sig_path.read_bytes()


# ---------------------------------------------------------------------------
# Happy path: verified candidate recorded; idempotent; superseded by newer
# ---------------------------------------------------------------------------


@respx.mock
async def test_verified_release_records_candidate(state_dir):
    manifest = fx("release.valid.json")
    serve_release("v2026.05.28", manifest, fx("release.valid.json.sig"))
    poller, store, _ = build_poller(update_env(state_dir))

    outcome = await poller.poll_once()

    assert outcome.outcome == "candidate_recorded"
    assert outcome.git_sha == VALID_GIT_SHA
    candidate = store.update_candidate()
    assert candidate is not None
    assert candidate["git_sha"] == VALID_GIT_SHA
    assert candidate["release_tag"] == "v2026.05.28"
    assert candidate["channel"] == "stable"
    assert candidate["manifest_sha256"] == hashlib.sha256(manifest).hexdigest()
    assert {s["name"] for s in candidate["services"]} == {
        "orchestrator",
        "web-dashboard",
        "device-identity-svc",
    }


@respx.mock
async def test_repolling_same_release_is_a_noop(state_dir):
    serve_release("v2026.05.28", fx("release.valid.json"), fx("release.valid.json.sig"))
    poller, store, _ = build_poller(update_env(state_dir))

    first = await poller.poll_once()
    before = store.update_candidate_path.read_text(encoding="utf-8")
    second = await poller.poll_once()

    assert first.outcome == "candidate_recorded"
    assert second.outcome == "already_known"
    assert store.update_candidate_path.read_text(encoding="utf-8") == before


@respx.mock
async def test_newer_release_supersedes_recorded_candidate(state_dir):
    serve_release("v1", fx("release.valid.json"), fx("release.valid.json.sig"))
    poller, store, _ = build_poller(update_env(state_dir))
    assert (await poller.poll_once()).outcome == "candidate_recorded"

    respx.clear()
    serve_release("v2", fx("release.valid-v2.json"), fx("release.valid-v2.json.sig"))
    outcome = await poller.poll_once()

    assert outcome.outcome == "candidate_recorded"
    candidate = store.update_candidate()
    assert candidate is not None
    assert candidate["git_sha"] != VALID_GIT_SHA  # the v2 fixture's sha won
    assert candidate["release_tag"] == "v2"


# ---------------------------------------------------------------------------
# AC: signature verified BEFORE reporting; unsigned/invalid rejected+audited
# ---------------------------------------------------------------------------


@respx.mock
async def test_tampered_manifest_rejected_audited_never_recorded(state_dir, caplog):
    serve_release("v-evil", fx("release.tampered.json"), fx("release.tampered.json.sig"))
    poller, store, reporter = build_poller(update_env(state_dir))

    with caplog.at_level(logging.WARNING, logger="fleet_agent.update"):
        outcome = await poller.poll_once()

    assert outcome.outcome == "verify_failed"
    assert outcome.failure_reason == "signature_failed"
    # Never recorded:
    assert store.update_candidate() is None
    # Audited: warn event with the canonical name + fingerprinted report
    # queued for the portal errors tick.
    assert any("update.signature_failed" in r.message for r in caplog.records)
    assert reporter.pending() == 1


@respx.mock
async def test_schema_invalid_manifest_rejected_audited(state_dir, caplog):
    serve_release(
        "v-bad",
        fx("release.schema-invalid.json"),
        fx("release.schema-invalid.json.sig"),
    )
    poller, store, reporter = build_poller(update_env(state_dir))

    with caplog.at_level(logging.WARNING, logger="fleet_agent.update"):
        outcome = await poller.poll_once()

    assert outcome.outcome == "verify_failed"
    assert outcome.failure_reason == "schema_invalid"
    assert store.update_candidate() is None
    assert any("update.verify_failed" in r.message for r in caplog.records)
    assert reporter.pending() == 1


@respx.mock
async def test_placeholder_trust_anchor_fails_closed_end_to_end(state_dir):
    """With a placeholder anchor — i.e. an image built before the key
    ceremony — even a correctly-signed release is refused and never
    recorded.

    This used to rely on the SHIPPED anchor being the placeholder. The key
    ceremony stamped the real key over it, so the fixture is now injected
    explicitly: the scenario (a box whose baked-in anchor predates the
    ceremony) is still real and still has to fail closed, and pinning it
    to a fixture keeps the coverage from evaporating the moment the repo
    state changed. See test_release_verify.py for the shipped-anchor
    assertions."""
    serve_release("v1", fx("release.valid.json"), fx("release.valid.json.sig"))
    cfg = load_config(update_env(state_dir))
    store = StateStore(cfg.state_dir)
    poller = UpdatePoller(
        config=cfg,
        state=store,
        errors=ErrorReporter(),
        public_key_path=_FIXTURES / "placeholder-cosign.pub",
    )

    outcome = await poller.poll_once()

    assert outcome.outcome == "verify_failed"
    assert outcome.failure_reason == "trust_anchor_placeholder"
    assert store.update_candidate() is None


# ---------------------------------------------------------------------------
# AC: fail-open — unreachable / 5xx / TLS failure never degrade the box
# ---------------------------------------------------------------------------


@respx.mock
async def test_unreachable_endpoint_is_typed_fetch_failed(state_dir):
    respx.get(RELEASES_URL).mock(side_effect=httpx.ConnectError("connection refused"))
    poller, store, _ = build_poller(update_env(state_dir))
    outcome = await poller.poll_once()
    assert outcome.outcome == "fetch_failed"
    assert store.update_candidate() is None


@respx.mock
async def test_server_5xx_is_typed_fetch_failed(state_dir):
    respx.get(RELEASES_URL).mock(return_value=httpx.Response(500, text="boom"))
    poller, _, _ = build_poller(update_env(state_dir))
    outcome = await poller.poll_once()
    assert outcome.outcome == "fetch_failed"
    assert "500" in outcome.detail


@respx.mock
async def test_tls_failure_is_typed_fetch_failed(state_dir):
    # httpx surfaces TLS handshake/verification failures as ConnectError.
    respx.get(RELEASES_URL).mock(
        side_effect=httpx.ConnectError(
            "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"
        )
    )
    poller, _, _ = build_poller(update_env(state_dir))
    outcome = await poller.poll_once()
    assert outcome.outcome == "fetch_failed"


@respx.mock
async def test_asset_download_failure_is_typed_fetch_failed(state_dir):
    serve_release("v1", fx("release.valid.json"), fx("release.valid.json.sig"))
    respx.get(MANIFEST_ASSET_URL).mock(return_value=httpx.Response(502))
    poller, _, _ = build_poller(update_env(state_dir))
    outcome = await poller.poll_once()
    assert outcome.outcome == "fetch_failed"


@respx.mock
async def test_no_release_published_yet_is_quiet(state_dir):
    respx.get(RELEASES_URL).mock(
        return_value=httpx.Response(404, json={"message": "Not Found"})
    )
    poller, _, _ = build_poller(update_env(state_dir))
    outcome = await poller.poll_once()
    assert outcome.outcome == "no_release"


@respx.mock
async def test_tick_swallows_everything_and_other_jobs_keep_working(state_dir):
    """The scheduler-facing AC: a poll failure of ANY shape (here: the
    endpoint down, and then a genuine bug) never raises out of the tick
    and never affects the telemetry half of the agent."""
    respx.get(RELEASES_URL).mock(side_effect=httpx.ConnectError("down"))
    respx.post(f"{PORTAL_URL}/agents/register").mock(
        return_value=httpx.Response(201, json=register_response())
    )
    hb = respx.post(f"{PORTAL_URL}/agents/heartbeat").mock(
        return_value=httpx.Response(204)
    )
    env = update_env(
        state_dir,
        DROPLET_TELEMETRY_ENABLED="1",
        DROPLET_TELEMETRY_PORTAL_URL=PORTAL_URL,
        DROPLET_TELEMETRY_PROVISIONING_CODE="prov-code-123",
    )
    agent = build_update_agent(env)

    await agent.update_poll_tick()  # endpoint down — no raise

    async def bug():
        raise RuntimeError("genuine bug in the poller")

    agent.updates.poll_once = bug  # type: ignore[method-assign]
    await agent.update_poll_tick()  # _fail_open swallows even bugs

    await agent.heartbeat_tick()  # the box's other duties are untouched
    assert hb.call_count == 1


# ---------------------------------------------------------------------------
# ADR-028 tag-selector targeting
# ---------------------------------------------------------------------------


@respx.mock
async def test_channel_mismatch_is_not_targeted(state_dir):
    serve_release(
        "v-beta", fx("release.channel-beta.json"), fx("release.channel-beta.json.sig")
    )
    poller, store, _ = build_poller(update_env(state_dir))  # box channel: stable

    outcome = await poller.poll_once()

    assert outcome.outcome == "not_targeted"
    assert "channel" in outcome.detail
    assert store.update_candidate() is None


def test_matches_target_vocabulary():
    manifest = {"release": {"channel": "stable", "scope": {}}}
    box = {
        "device_id": "01J9MZTEST",
        "tier": "business",
        "channel": "stable",
        "customer": "photo-studio",
        "region": "eu-central",
        "hw": "v2.6",
    }

    # Empty scope → channel gate only.
    assert matches_target(manifest, box)[0]

    # Every ratified dimension matches / mismatches independently.
    for key, value in (
        ("device_id", "01J9MZTEST"),
        ("tier", "business"),
        ("channel", "stable"),
        ("customer", "photo-studio"),
        ("region", "eu-central"),
        ("hw", "v2.6"),
    ):
        scoped = {"release": {"channel": "stable", "scope": {key: value}}}
        assert matches_target(scoped, box)[0], key
        mismatched = {"release": {"channel": "stable", "scope": {key: "other"}}}
        matched, event, _ = matches_target(mismatched, box)
        assert not matched and event == "update.scope_mismatch", key

    # Channel gate dominates.
    beta = {"release": {"channel": "beta"}}
    matched, event, _ = matches_target(beta, box)
    assert not matched and event == "update.channel_mismatch"

    # A selector on a tag the box doesn't carry — including future
    # vocabulary — can never match: targeting fails closed.
    unknown = {"release": {"channel": "stable", "scope": {"fleet_group": "x"}}}
    assert not matches_target(unknown, box)[0]
    untagged_box = {"tier": "home", "channel": "stable"}
    customer_scoped = {
        "release": {"channel": "stable", "scope": {"customer": "photo-studio"}}
    }
    assert not matches_target(customer_scoped, untagged_box)[0]


@respx.mock
async def test_scoped_release_end_to_end_respects_box_tags(state_dir, tmp_path):
    """A runtime-signed manifest carrying the ratified scope selector:
    the same signed bytes are a candidate for a matching box and
    not_targeted for a non-matching one — with REAL signatures."""
    doc = json.loads(fx("release.valid.json"))
    doc["release"]["scope"] = {"tier": "business", "customer": "photo-studio"}
    manifest = json.dumps(doc).encode("utf-8")
    signature = sign_at_test_time(manifest, tmp_path)

    serve_release("v-scoped", manifest, signature)

    matching_env = update_env(
        state_dir, DROPLET_TIER="business", DROPLET_CUSTOMER="photo-studio"
    )
    poller, store, _ = build_poller(matching_env)
    outcome = await poller.poll_once()
    assert outcome.outcome == "candidate_recorded"
    assert store.update_candidate()["scope"] == doc["release"]["scope"]

    other_dir = state_dir.parent / "other-box"
    other_env = update_env(other_dir, DROPLET_TIER="home")
    other_poller, other_store, _ = build_poller(other_env)
    other_outcome = await other_poller.poll_once()
    assert other_outcome.outcome == "not_targeted"
    assert other_store.update_candidate() is None


# ---------------------------------------------------------------------------
# Plumbing: auth header, gate, scheduler mount
# ---------------------------------------------------------------------------


@respx.mock
async def test_github_token_sent_as_bearer_when_configured(state_dir):
    serve_release("v1", fx("release.valid.json"), fx("release.valid.json.sig"))
    poller, _, _ = build_poller(
        update_env(state_dir, DROPLET_OTA_GITHUB_TOKEN="ghp_test_token")
    )
    await poller.poll_once()
    for route in respx.calls:
        assert route.request.headers.get("Authorization") == "Bearer ghp_test_token"


def build_update_agent(env: dict) -> FleetAgent:
    cfg = load_config(env)
    store = StateStore(cfg.state_dir)
    reporter = ErrorReporter()
    poller = UpdatePoller(
        config=cfg, state=store, errors=reporter, public_key_path=KEY
    )
    portal = PortalClient(base_url=cfg.portal_url, firmware_version=cfg.firmware_version)
    return FleetAgent(
        config=cfg,
        state=store,
        portal=portal,
        collector=FakeCollector(),
        errors=reporter,
        updates=poller,
    )


def test_update_gate_requires_explicit_opt_in(state_dir):
    off = build_update_agent(
        {"DROPLET_TELEMETRY_STATE_DIR": str(state_dir)}
    )
    active, reason = off.update_gate()
    assert not active
    assert "DROPLET_UPDATE_POLL_ENABLED" in reason

    on = build_update_agent(update_env(state_dir))
    assert on.update_gate() == (True, "")


def test_scheduler_mounts_update_poll_as_one_more_job(state_dir):
    """AC: the update-poll lives in the SAME agent process — one more
    apscheduler interval job (~5 min default) alongside the six
    telemetry jobs; no second agent."""
    env = update_env(
        state_dir,
        DROPLET_TELEMETRY_ENABLED="1",
        DROPLET_TELEMETRY_PORTAL_URL=PORTAL_URL,
        DROPLET_TELEMETRY_PROVISIONING_CODE="prov-code-123",
    )
    agent = build_update_agent(env)
    scheduler = agent.build_scheduler()
    try:
        jobs = {j.id: j for j in scheduler.get_jobs()}
        assert "warp-1025-update-poll" in jobs
        assert jobs["warp-1025-update-poll"].trigger.interval.total_seconds() == 300
        assert jobs["warp-1025-update-poll"].max_instances == 1
        assert len(jobs) == 7  # six WARP-963 telemetry jobs + this one
    finally:
        if scheduler.running:
            scheduler.shutdown(wait=False)


def test_scheduler_update_poll_runs_without_telemetry_consent(state_dir):
    """The two halves are separate consents: update-poll opt-in with
    telemetry off mounts ONLY the update job (and vice versa)."""
    agent = build_update_agent(update_env(state_dir))  # telemetry off
    scheduler = agent.build_scheduler()
    try:
        assert [j.id for j in scheduler.get_jobs()] == ["warp-1025-update-poll"]
    finally:
        if scheduler.running:
            scheduler.shutdown(wait=False)


# ---------------------------------------------------------------------------
# WARP-1670 — two branches, two channels
# ---------------------------------------------------------------------------

RELEASES_LIST_URL = (
    "https://api.github.com/repos/DropletByWarpLab/droplet-onboard-services"
    "/releases?per_page=30"
)
STAGE_MANIFEST_URL = "https://api.github.com/assets/stage-release-json"
STAGE_SIG_URL = "https://api.github.com/assets/stage-release-json-sig"


def _list_entry(tag: str, manifest_url: str, sig_url: str) -> dict:
    return {
        "tag_name": tag,
        "assets": [
            {"name": "release.json", "url": manifest_url},
            {"name": "release.json.sig", "url": sig_url},
        ],
    }


def serve_releases_list(entries: list[dict]) -> None:
    """GitHub's `GET /releases`, newest-first as the API returns it."""
    respx.get(RELEASES_LIST_URL).mock(return_value=httpx.Response(200, json=entries))


def test_releases_list_url_derivation():
    assert releases_list_url(RELEASES_URL) == RELEASES_LIST_URL
    # Not a `latest` endpoint → the caller must fail loudly, not go quiet.
    assert releases_list_url("https://example.test/some/release.json") is None


@respx.mock
async def test_stage_box_takes_the_newest_stage_tagged_release(state_dir):
    # Newest-first: the stable release is FIRST, so a box that simply took
    # the head of the list would install the wrong build.
    serve_releases_list(
        [
            _list_entry("ota-stable-9-gstable", MANIFEST_ASSET_URL, SIG_ASSET_URL),
            _list_entry("ota-stage-8-gstage", STAGE_MANIFEST_URL, STAGE_SIG_URL),
        ]
    )
    respx.get(STAGE_MANIFEST_URL).mock(
        return_value=httpx.Response(200, content=fx("release.channel-stage.json"))
    )
    respx.get(STAGE_SIG_URL).mock(
        return_value=httpx.Response(200, content=fx("release.channel-stage.json.sig"))
    )
    poller, store, _ = build_poller(
        update_env(state_dir, DROPLET_UPDATE_CHANNEL="stage")
    )

    outcome = await poller.poll_once()

    assert outcome.outcome == "candidate_recorded", outcome.detail
    candidate = store.update_candidate()
    assert candidate["channel"] == "stage"
    assert candidate["release_tag"] == "ota-stage-8-gstage"


@respx.mock
async def test_stable_box_never_reads_the_releases_list(state_dir):
    # Only `latest` is mocked. respx fails any unmocked call, so this
    # asserts by construction that a stable box's discovery is unchanged
    # — and therefore that stage prereleases stay invisible to it.
    serve_release("ota-stable-9-gstable", fx("release.valid.json"), fx("release.valid.json.sig"))
    poller, store, _ = build_poller(update_env(state_dir))  # box channel: stable

    outcome = await poller.poll_once()

    assert outcome.outcome == "candidate_recorded", outcome.detail
    assert store.update_candidate()["channel"] == "stable"


@respx.mock
async def test_stage_tagged_release_still_obeys_the_signed_manifest(state_dir):
    # The tag is unsigned repo metadata — discovery may be fooled by it,
    # the trust decision may not.
    serve_releases_list(
        [_list_entry("ota-stage-7-gliar", STAGE_MANIFEST_URL, STAGE_SIG_URL)]
    )
    respx.get(STAGE_MANIFEST_URL).mock(
        return_value=httpx.Response(200, content=fx("release.channel-beta.json"))
    )
    respx.get(STAGE_SIG_URL).mock(
        return_value=httpx.Response(200, content=fx("release.channel-beta.json.sig"))
    )
    poller, store, _ = build_poller(
        update_env(state_dir, DROPLET_UPDATE_CHANNEL="stage")
    )

    outcome = await poller.poll_once()

    assert outcome.outcome == "not_targeted"
    assert "channel" in outcome.detail
    assert store.update_candidate() is None


@respx.mock
async def test_stage_box_with_no_stage_release_is_quiet(state_dir):
    serve_releases_list(
        [_list_entry("ota-stable-9-gstable", MANIFEST_ASSET_URL, SIG_ASSET_URL)]
    )
    poller, store, _ = build_poller(
        update_env(state_dir, DROPLET_UPDATE_CHANNEL="stage")
    )

    outcome = await poller.poll_once()

    assert outcome.outcome == "no_release"
    assert store.update_candidate() is None


@respx.mock
async def test_underivable_list_endpoint_is_fetch_failed_not_no_release(state_dir):
    # A box that can never discover must say so on every tick, not report
    # "nothing published" and look healthy.
    poller, store, _ = build_poller(
        update_env(
            state_dir,
            DROPLET_UPDATE_CHANNEL="stage",
            DROPLET_OTA_RELEASES_URL="https://example.test/some/release.json",
        )
    )

    outcome = await poller.poll_once()

    assert outcome.outcome == "fetch_failed"
    assert "list endpoint" in outcome.detail
    assert store.update_candidate() is None
