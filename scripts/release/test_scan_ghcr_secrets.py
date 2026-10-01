"""WARP-3429 — unit tests for scan-ghcr-secrets.py's local (`docker save`) mode.

publish-release.yml scans every freshly built image between `docker build` and
`docker push`, and refuses to push on a finding. The gate only means something
if the scan really reaches every layer and the config, understands both
`docker save` layouts, honours the reviewed baseline, and FAILS CLOSED when it
cannot read what it was handed. gitleaks itself is replaced by a stand-in that
flags a marker string (pinned-binary behaviour is the workflow's job), so the
suite is hermetic; it needs only `tar`.

Run locally / in CI:
    python3 -m pytest scripts/release/ -v
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import sys
import tarfile
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "scan_ghcr_secrets", Path(__file__).parent / "scan-ghcr-secrets.py")
scan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scan)

MARKER = b"FAKE-SECRET"
CREDS = {"app/creds.txt": b"token=" + MARKER + b"\n"}


def fake_gitleaks(binary, target, report):
    """Stand-in for `gitleaks dir`: one finding per line carrying MARKER, with
    an absolute File path like the real thing."""
    findings = []
    for dirpath, _, names in os.walk(target):
        for name in sorted(names):
            path = os.path.join(dirpath, name)
            if os.path.islink(path):
                continue
            with open(path, "rb") as fh:
                for n, line in enumerate(fh, 1):
                    if MARKER in line:
                        findings.append({"RuleID": "fake-rule", "File": path,
                                         "StartLine": n, "Match": "REDACTED"})
    return findings


@pytest.fixture(autouse=True)
def _fake_gitleaks(monkeypatch):
    monkeypatch.setattr(scan, "gitleaks", fake_gitleaks)


def layer_tar(files, gz=False):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz" if gz else "w") as tf:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def docker_save(path, layers, config=None, layout="legacy", drop=()):
    """Write a `docker save` archive. `layout` is the legacy
    `<id>/layer.tar` shape or the OCI `blobs/sha256/<hex>` shape (layers
    gzipped there, as the containerd image store keeps them)."""
    cfg = json.dumps(config if config is not None else {"config": {"Env": ["PATH=/usr/bin"]}}).encode()
    members, layer_paths = {}, []
    for i, files in enumerate(layers):
        # `bytes` stands in for a layer that is not a tar at all.
        data = files if isinstance(files, bytes) else layer_tar(files, gz=layout != "legacy")
        p = (f"{i:064x}/layer.tar" if layout == "legacy"
             else f"blobs/sha256/{hashlib.sha256(data).hexdigest()}")
        members[p] = data
        layer_paths.append(p)
    cfg_path = (f"{hashlib.sha256(cfg).hexdigest()}.json" if layout == "legacy"
                else f"blobs/sha256/{hashlib.sha256(cfg).hexdigest()}")
    members[cfg_path] = cfg
    members["manifest.json"] = json.dumps(
        [{"Config": cfg_path, "RepoTags": ["demo:latest"], "Layers": layer_paths}]).encode()
    with tarfile.open(path, "w") as tf:
        for name, data in members.items():
            if name in drop:
                continue
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return path


@pytest.fixture
def run(monkeypatch, capsys, tmp_path):
    def _run(archive, *extra):
        out = tmp_path / "findings.jsonl"
        monkeypatch.setattr(sys, "argv", [
            "scan-ghcr-secrets", "--package", "droplet-demo", "--gitleaks", "unused",
            "--docker-save", str(archive), "--out", str(out), *extra])
        rc = scan.main()
        records = [json.loads(line) for line in out.read_text().splitlines()] if out.exists() else []
        return rc, capsys.readouterr().out, records
    return _run


@pytest.fixture
def baseline(tmp_path):
    def _write(text):
        path = tmp_path / "baseline.txt"
        path.write_text(text)
        return str(path)
    return _write


@pytest.mark.parametrize("layout", ["legacy", "oci"])
class TestLayers:
    def test_secret_deleted_by_a_later_layer_is_still_found(self, tmp_path, run, layout):
        # The whole point of scanning layer by layer: layer 2 whites the file
        # out, but layer 1 still ships it.
        archive = docker_save(tmp_path / "i.tar", [CREDS, {"app/.wh.creds.txt": b""}], layout=layout)
        rc, out, records = run(archive)
        assert rc == 0
        assert [(r["file"], r["class"], r["rule"]) for r in records] == [("app/creds.txt", "app", "fake-rule")]
        assert records[0]["where"].startswith("layer:")
        assert '"layers": 2' in out

    def test_clean_image_passes_the_gate(self, tmp_path, run, layout):
        archive = docker_save(tmp_path / "i.tar", [{"app/a.txt": b"hello\n"}, {"app/b.txt": b"world\n"}],
                              layout=layout)
        rc, out, records = run(archive, "--fail-on-app")
        assert (rc, records) == (0, [])
        assert '"findings": 0' in out

    def test_app_finding_fails_the_gate(self, tmp_path, run, layout):
        rc, out, _ = run(docker_save(tmp_path / "i.tar", [CREDS], layout=layout), "--fail-on-app")
        assert rc == 1
        assert "::error::droplet-demo:" in out
        # The line to paste into the baseline, if it is a reviewed false positive.
        assert "\nfake-rule app/creds.txt\n" in out


class TestConfig:
    def test_secret_in_the_image_config_is_a_non_vendor_finding(self, tmp_path, run):
        # A build arg / ENV that carries a credential lands in the config, not a layer.
        config = {"config": {"Env": ["API_KEY=" + MARKER.decode()]}}
        rc, out, records = run(docker_save(tmp_path / "i.tar", [{"app/a.txt": b"ok\n"}], config=config),
                               "--fail-on-app")
        assert rc == 1
        assert [(r["file"], r["class"]) for r in records] == [("config.json", "config")]
        assert "\nfake-rule config.json\n" in out


class TestVendorAndBaseline:
    def test_vendor_findings_are_reported_but_never_fail(self, tmp_path, run):
        vendor = {"usr/lib/python3/site-packages/pkg/fixture.txt": b"k=" + MARKER + b"\n"}
        rc, _, records = run(docker_save(tmp_path / "i.tar", [vendor]), "--fail-on-app")
        assert rc == 0
        assert [r["class"] for r in records] == ["vendor"]

    def test_baselined_finding_passes(self, tmp_path, run, baseline):
        rc, _, records = run(docker_save(tmp_path / "i.tar", [CREDS]), "--fail-on-app",
                             "--baseline", baseline("# reviewed\n\nfake-rule app/creds.txt\n"))
        assert rc == 0
        assert len(records) == 1  # still reported, just accepted

    def test_baseline_ignores_line_numbers_and_layer_digests(self, tmp_path, run, baseline):
        # Rebuilt image: the secret moved to line 3 of a different layer.
        moved = {"app/creds.txt": b"a\nb\ntoken=" + MARKER + b"\n"}
        archive = docker_save(tmp_path / "i.tar", [{"app/x.txt": b"y\n"}, moved])
        rc, _, records = run(archive, "--fail-on-app", "--baseline", baseline("fake-rule /app/creds.txt\n"))
        assert (rc, records[0]["line"]) == (0, 3)

    @pytest.mark.parametrize("entry", ["other-rule app/creds.txt", "fake-rule app/other.txt"])
    def test_baseline_entry_must_match_rule_and_path(self, tmp_path, run, baseline, entry):
        rc, _, _ = run(docker_save(tmp_path / "i.tar", [CREDS]), "--fail-on-app", "--baseline", baseline(entry))
        assert rc == 1

    def test_without_fail_on_app_findings_do_not_fail(self, tmp_path, run):
        rc, _, records = run(docker_save(tmp_path / "i.tar", [CREDS]))
        assert (rc, len(records)) == (0, 1)

    def test_malformed_baseline_line_is_an_error(self, tmp_path, baseline):
        with pytest.raises(SystemExit) as e:
            scan.load_baseline(baseline("fake-rule\n"))
        assert "want '<rule> <path>'" in str(e.value)

    def test_shipped_baseline_parses(self):
        # Empty-but-documented today; whatever lands in it must stay parseable.
        scan.load_baseline(str(Path(__file__).parent / "image-secret-baseline.txt"))


class TestFailsClosed:
    """A pre-push scan that could not read the image must never pass."""

    def test_archive_without_manifest(self, tmp_path, run):
        archive = docker_save(tmp_path / "i.tar", [CREDS], drop=("manifest.json",))
        rc, out, _ = run(archive, "--fail-on-app")
        assert rc == 2
        assert "::error::droplet-demo: could not scan" in out

    def test_layer_listed_but_missing_from_the_archive(self, tmp_path, run):
        archive = docker_save(tmp_path / "i.tar", [CREDS], drop=(f"{0:064x}/layer.tar",))
        rc, out, _ = run(archive, "--fail-on-app")
        assert rc == 2
        assert "could not scan" in out

    def test_layer_that_tar_cannot_read(self, tmp_path, run):
        # Extracting it would silently yield nothing, i.e. "clean".
        archive = docker_save(tmp_path / "i.tar", [b"junk" * 150])
        rc, out, _ = run(archive, "--fail-on-app")
        assert rc == 2
        assert "could not scan" in out

    def test_not_a_tar_at_all(self, tmp_path, run):
        junk = tmp_path / "junk.tar"
        junk.write_bytes(b"this is not a tarball")
        rc, out, _ = run(junk, "--fail-on-app")
        assert rc == 2
        assert "could not scan" in out

    def test_manifest_listing_no_images(self, tmp_path, run):
        archive = tmp_path / "i.tar"
        data = b"[]"
        with tarfile.open(archive, "w") as tf:
            info = tarfile.TarInfo("manifest.json")
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        rc, out, _ = run(archive, "--fail-on-app")
        assert rc == 2
        assert "no images" in out


def test_path_class():
    assert scan.path_class("app/server.js") == "app"
    assert scan.path_class("app/node_modules/x/test/key.pem") == "vendor"
    assert scan.path_class("usr/lib/python3/site-packages/x.py") == "vendor"
