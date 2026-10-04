"""WARP-3429 — unit tests for the OTA channel-pointer generator.

The pointer (`channel-<channel>.json`) is the file a box fetches first, from
the rolling `ota-index` release, so its schema and bytes are a wire contract
with the box-side poller. These tests pin the exact schema, the deterministic
byte form, the "hash the exact uploaded bytes" rule, and the loud-failure
paths that stop a mismatched pointer from being signed.

Run locally / in CI:
    python3 -m pytest scripts/release/ -v
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parent / "gen-channel-pointer.py"
MANIFEST_SCRIPT = Path(__file__).parent / "gen-release-manifest.py"

SHA = "0123456789abcdef0123456789abcdef01234567"
BUILT_AT = "2026-10-01T12:34:56Z"
PUBLISHED_AT = "2026-10-01T13:00:00Z"
TAG = "ota-stage-412-g0123456"
KEYS = ["schemaVersion", "kind", "channel", "tag", "gitSha", "builtAt",
        "manifestSha256", "publishedAt"]


def write_manifest(tmp_path, channel="stage", git_sha=SHA, built_at=BUILT_AT, raw=None):
    """A release.json-shaped file; `raw` overrides the exact bytes."""
    path = tmp_path / "release.json"
    if raw is None:
        raw = json.dumps({
            "schemaVersion": 1,
            "release": {"gitSha": git_sha, "builtAt": built_at, "channel": channel,
                        "minOrchestratorSchema": 1},
            "services": [],
        }, indent=2).encode() + b"\n"
    path.write_bytes(raw)
    return path


def run_gen(tmp_path, manifest, channel="stage", tag=TAG, published_at=PUBLISHED_AT):
    out = tmp_path / "channel-stage.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPT),
         "--manifest", str(manifest), "--channel", channel, "--tag", tag,
         "--published-at", published_at, "--out", str(out)],
        capture_output=True, text=True,
    )
    return proc, out


class TestSchema:
    def test_exact_bytes(self, tmp_path):
        manifest = write_manifest(tmp_path)
        proc, out = run_gen(tmp_path, manifest)
        assert proc.returncode == 0, proc.stderr
        sha = hashlib.sha256(manifest.read_bytes()).hexdigest()
        # Compact, fixed key order, one trailing newline: the bytes the
        # workflow signs and the box verifies.
        assert out.read_bytes() == (
            '{"schemaVersion":1,"kind":"droplet-ota-channel-pointer","channel":"stage",'
            f'"tag":"{TAG}","gitSha":"{SHA}","builtAt":"{BUILT_AT}",'
            f'"manifestSha256":"{sha}","publishedAt":"{PUBLISHED_AT}"}}\n'
        ).encode("utf-8")

    def test_keys_are_in_contract_order(self, tmp_path):
        proc, out = run_gen(tmp_path, write_manifest(tmp_path))
        assert proc.returncode == 0, proc.stderr
        assert list(json.loads(out.read_text())) == KEYS

    def test_built_at_is_copied_verbatim(self, tmp_path):
        # Not a timestamp this script could have produced: it must be passed
        # through, never reformatted.
        proc, out = run_gen(tmp_path, write_manifest(tmp_path, built_at="2026-10-01T12:34:56.789+00:00"))
        assert proc.returncode == 0, proc.stderr
        assert json.loads(out.read_text())["builtAt"] == "2026-10-01T12:34:56.789+00:00"

    def test_manifest_sha256_is_over_the_exact_uploaded_bytes(self, tmp_path):
        # Same JSON, unusual whitespace and CRLF: a re-serialising generator
        # would hash different bytes than the ones attached to the release.
        raw = (b'{ "schemaVersion":1,\r\n "release":{"gitSha":"' + SHA.encode()
               + b'","builtAt":"' + BUILT_AT.encode()
               + b'","channel":"stage"} }')
        manifest = write_manifest(tmp_path, raw=raw)
        proc, out = run_gen(tmp_path, manifest)
        assert proc.returncode == 0, proc.stderr
        ptr = json.loads(out.read_text())
        assert ptr["manifestSha256"] == hashlib.sha256(raw).hexdigest()
        assert ptr["manifestSha256"] == ptr["manifestSha256"].lower()
        assert len(ptr["manifestSha256"]) == 64

    def test_stable_channel(self, tmp_path):
        manifest = write_manifest(tmp_path, channel="stable")
        proc, out = run_gen(tmp_path, manifest, channel="stable", tag="ota-stable-7-g0123456")
        assert proc.returncode == 0, proc.stderr
        ptr = json.loads(out.read_text())
        assert (ptr["channel"], ptr["tag"]) == ("stable", "ota-stable-7-g0123456")

    def test_default_published_at_is_utc_iso8601(self, tmp_path):
        manifest = write_manifest(tmp_path)
        out = tmp_path / "p.json"
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), "--manifest", str(manifest), "--channel", "stage",
             "--tag", TAG, "--out", str(out)],
            capture_output=True, text=True,
        )
        assert proc.returncode == 0, proc.stderr
        published = json.loads(out.read_text())["publishedAt"]
        assert len(published) == 20 and published.endswith("Z") and published[10] == "T"

    def test_accepts_a_real_generated_manifest(self, tmp_path):
        """Drift guard: the field names this reads are the ones
        gen-release-manifest.py actually emits."""
        services = tmp_path / "services.json"
        services.write_text(json.dumps({"services": [
            {"name": "orchestrator", "context": ".", "dockerfile": "apps/orchestrator/Dockerfile",
             "healthcheck": {"type": "none"}}]}))
        digests = tmp_path / "digests.json"
        digests.write_text(json.dumps({"orchestrator": "sha256:" + "b" * 64}))
        configs = tmp_path / "configs.tar.gz"
        configs.write_bytes(b"x")
        manifest = tmp_path / "release.json"
        gen = subprocess.run(
            [sys.executable, str(MANIFEST_SCRIPT), "--services", str(services),
             "--digests", str(digests), "--configs", str(configs),
             "--git-sha", SHA, "--channel", "stage", "--out", str(manifest)],
            capture_output=True, text=True,
        )
        assert gen.returncode == 0, gen.stderr
        proc, out = run_gen(tmp_path, manifest)
        assert proc.returncode == 0, proc.stderr
        ptr = json.loads(out.read_text())
        built = json.loads(manifest.read_text())["release"]["builtAt"]
        assert ptr["builtAt"] == built
        assert ptr["gitSha"] == SHA


class TestLoudFailures:
    def _fails(self, tmp_path, manifest, needle, **kw):
        proc, out = run_gen(tmp_path, manifest, **kw)
        assert proc.returncode != 0
        assert needle in proc.stderr
        assert not out.exists()

    def test_channel_must_match_the_manifest(self, tmp_path):
        self._fails(tmp_path, write_manifest(tmp_path, channel="stable"), "the manifest says")

    def test_tag_channel_must_match(self, tmp_path):
        self._fails(tmp_path, write_manifest(tmp_path), "names channel", tag="ota-stable-412-g0123456")

    def test_tag_sha_must_match_the_manifest(self, tmp_path):
        self._fails(tmp_path, write_manifest(tmp_path), "names sha", tag="ota-stage-412-gfffffff")

    def test_tag_must_be_an_ota_release_tag(self, tmp_path):
        # In particular the rolling index tag is never a valid pointer target.
        self._fails(tmp_path, write_manifest(tmp_path), "--tag must look like", tag="ota-index")

    def test_git_sha_must_be_full_length(self, tmp_path):
        self._fails(tmp_path, write_manifest(tmp_path, git_sha="0123456"), "40-hex")

    def test_manifest_without_release_block(self, tmp_path):
        self._fails(tmp_path, write_manifest(tmp_path, raw=b'{"schemaVersion":1}'), "release.gitSha")

    def test_manifest_that_is_not_json(self, tmp_path):
        self._fails(tmp_path, write_manifest(tmp_path, raw=b"not json"), "release.gitSha")

    def test_missing_manifest_file(self, tmp_path):
        self._fails(tmp_path, tmp_path / "nope.json", "manifest not found")

    def test_bad_published_at(self, tmp_path):
        self._fails(tmp_path, write_manifest(tmp_path), "--published-at", published_at="yesterday")
