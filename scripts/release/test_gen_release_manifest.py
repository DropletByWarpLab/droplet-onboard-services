"""WARP-536 — unit tests for the OTA release-manifest generator.

The generator is the single place `release.json` (design schema v1) is
produced; publish-release.yml calls it after the image builds. These
tests pin the schema shape and the loud-failure paths so a workflow edit
can't silently ship a manifest the device-side update agent (WARP-537)
would reject — or worse, accept with missing services.

Run locally / in CI:
    python3 -m pytest scripts/release/ -v
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent / "gen-release-manifest.py"
SERVICES_JSON = Path(__file__).parent / "services.json"


def run_gen(tmp_path, services, digests, git_sha="a" * 40, channel="stable",
            registry="ghcr.io/dropletbywarplab", extra_args=None):
    """Invoke the generator as the workflow does (subprocess, real argv)."""
    services_file = tmp_path / "services.json"
    services_file.write_text(json.dumps({"services": services}))
    digests_file = tmp_path / "digests.json"
    digests_file.write_text(json.dumps(digests))
    configs = tmp_path / "configs.tar.gz"
    configs.write_bytes(b"not-a-real-tarball-but-hashable")
    out = tmp_path / "release.json"
    cmd = [
        sys.executable, str(SCRIPT),
        "--services", str(services_file),
        "--digests", str(digests_file),
        "--configs", str(configs),
        "--git-sha", git_sha,
        "--channel", channel,
        "--registry", registry,
        "--out", str(out),
    ] + (extra_args or [])
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc, out, configs


ORCH = {
    "name": "orchestrator",
    "context": ".",
    "dockerfile": "apps/orchestrator/Dockerfile",
    "healthcheck": {"type": "http", "port": 3000, "path": "/api/orchestrator/health"},
}
OPENWRT = {
    "name": "openwrt",
    "context": "openwrt",
    "dockerfile": "singlebox-image/Dockerfile",
    "healthcheck": {"type": "none"},
}


class TestSchemaV1Shape:
    def test_happy_path_emits_design_schema_v1(self, tmp_path):
        digest = "sha256:" + "b" * 64
        proc, out, configs = run_gen(
            tmp_path, [ORCH, OPENWRT],
            {"orchestrator": digest, "openwrt": "sha256:" + "c" * 64},
        )
        assert proc.returncode == 0, proc.stderr
        m = json.loads(out.read_text())

        assert m["schemaVersion"] == 1
        assert m["release"]["gitSha"] == "a" * 40
        assert m["release"]["channel"] == "stable"
        # builtAt is RFC3339 UTC
        assert m["release"]["builtAt"].endswith("Z")
        assert isinstance(m["release"]["minOrchestratorSchema"], int)

        orch = next(s for s in m["services"] if s["name"] == "orchestrator")
        # Image reference is pinned BY DIGEST — a tag alone is mutable.
        assert orch["image"] == f"ghcr.io/dropletbywarplab/droplet-orchestrator@{digest}"
        assert orch["digest"] == digest
        assert orch["healthcheck"] == {
            "type": "http", "port": 3000, "path": "/api/orchestrator/health",
        }

        expected_sha = hashlib.sha256(configs.read_bytes()).hexdigest()
        assert m["configs"] == {"file": "configs.tar.gz", "sha256": expected_sha}

    def test_checked_in_services_json_is_valid_input(self, tmp_path):
        """The committed services.json must itself satisfy the generator."""
        services = json.loads(SERVICES_JSON.read_text())["services"]
        digests = {s["name"]: "sha256:" + "d" * 64 for s in services}
        digests_file = tmp_path / "digests.json"
        digests_file.write_text(json.dumps(digests))
        configs = tmp_path / "configs.tar.gz"
        configs.write_bytes(b"x")
        out = tmp_path / "release.json"
        proc = subprocess.run(
            [sys.executable, str(SCRIPT),
             "--services", str(SERVICES_JSON),
             "--digests", str(digests_file),
             "--configs", str(configs),
             "--git-sha", "e" * 40,
             "--out", str(out)],
            capture_output=True, text=True,
        )
        assert proc.returncode == 0, proc.stderr
        m = json.loads(out.read_text())
        names = {s["name"] for s in m["services"]}
        # The core always-on stack must be present in every release.
        assert {"orchestrator", "web-dashboard", "mcp-server",
                "ai-gateway", "routing"} <= names
        # The evaluation harness is NOT an appliance service.
        assert "rag-eval" not in names


class TestLoudFailures:
    def test_missing_digest_fails(self, tmp_path):
        proc, out, _ = run_gen(tmp_path, [ORCH, OPENWRT],
                               {"orchestrator": "sha256:" + "b" * 64})
        assert proc.returncode != 0
        assert "openwrt" in proc.stderr
        assert not out.exists()

    def test_malformed_digest_fails(self, tmp_path):
        proc, out, _ = run_gen(tmp_path, [ORCH], {"orchestrator": "b" * 64})
        assert proc.returncode != 0
        assert "sha256:" in proc.stderr
        assert not out.exists()

    def test_unknown_extra_digest_fails(self, tmp_path):
        """An image built but absent from services.json means the metadata
        and the build loop have drifted — refuse to publish."""
        proc, out, _ = run_gen(
            tmp_path, [ORCH],
            {"orchestrator": "sha256:" + "b" * 64, "ghost": "sha256:" + "c" * 64},
        )
        assert proc.returncode != 0
        assert "ghost" in proc.stderr
        assert not out.exists()

    def test_bad_channel_fails(self, tmp_path):
        """Two channels today (stable/stage) — anything else is a typo
        until the design grows more."""
        proc, out, _ = run_gen(tmp_path, [ORCH],
                               {"orchestrator": "sha256:" + "b" * 64},
                               channel="stabel")
        assert proc.returncode != 0
        assert not out.exists()

    def test_stage_channel_is_allowed(self, tmp_path):
        """WARP-1670 — the stage branch publishes `channel: stage`, and the
        device-side channel gate compares against exactly this field."""
        proc, out, _ = run_gen(tmp_path, [ORCH],
                               {"orchestrator": "sha256:" + "b" * 64},
                               channel="stage")
        assert proc.returncode == 0, proc.stderr
        assert json.loads(out.read_text())["release"]["channel"] == "stage"
