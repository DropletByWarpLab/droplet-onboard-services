"""WARP-3429 — unit tests for scan-ghcr-secrets.py (local `docker save` mode,
baseline gate, per-key config fingerprints, gitleaks config, shard/digests).

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

import argparse
import hashlib
import importlib.util
import io
import json
import os
import re
import sys
import tarfile
import types
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "scan_ghcr_secrets", Path(__file__).parent / "scan-ghcr-secrets.py")
scan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scan)
_REAL_GITLEAKS = scan.gitleaks  # the autouse fixture below swaps scan.gitleaks for a stub

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


SECRET = MARKER.decode()


def secret_config():
    """An image config whose Env, labels and build history all carry a credential."""
    return {
        "config": {"Env": ["PATH=/usr/bin", f"API_KEY={SECRET}", f"DB_PASS={SECRET}"],
                   "Labels": {"build.token": SECRET}, "Cmd": ["serve"]},
        "history": [{"created_by": f"ENV TOKEN={SECRET}"}, {"created_by": "RUN true"}],
    }


class TestConfig:
    def test_findings_are_fingerprinted_per_key(self, tmp_path, run):
        # A build arg / ENV that carries a credential lands in the config, not a layer.
        archive = docker_save(tmp_path / "i.tar", [{"app/a.txt": b"ok\n"}], config=secret_config())
        rc, out, records = run(archive, "--fail-on-app")
        assert rc == 1
        assert {r["class"] for r in records} == {"config"}
        files = [r["file"] for r in records]
        assert [f for f in files if not f.startswith("config.json#history.")] == [
            "config.json#Env.API_KEY", "config.json#Env.DB_PASS", "config.json#Labels.build_token"]
        history = [f for f in files if f.startswith("config.json#history.")]
        assert len(history) == 1 and re.fullmatch(r"config\.json#history\.[0-9a-f]{12}", history[0])
        assert "config.json" not in files  # never one fingerprint for the whole config
        # The lines the failing step prints for the baseline name the key.
        assert "\nfake-rule config.json#Env.API_KEY\n" in out
        assert "\nfake-rule config.json#Env.DB_PASS\n" in out

    def test_baselining_one_key_does_not_excuse_another(self, tmp_path, run, baseline):
        archive = docker_save(tmp_path / "i.tar", [{"app/a.txt": b"ok\n"}], config=secret_config())
        rc, out, _ = run(archive, "--fail-on-app", "--baseline", baseline("fake-rule config.json#Env.API_KEY\n"))
        assert rc == 1
        assert "\nfake-rule config.json#Env.DB_PASS\n" in out
        assert "\nfake-rule config.json#Env.API_KEY\n" not in out

    @pytest.mark.parametrize("entry", ["fake-rule config.json", "other-rule config.json#Env.API_KEY"])
    def test_no_baseline_line_covers_the_whole_config(self, tmp_path, run, baseline, entry):
        config = {"config": {"Env": [f"API_KEY={SECRET}"]}}
        archive = docker_save(tmp_path / "i.tar", [{"app/a.txt": b"ok\n"}], config=config)
        rc, _, _ = run(archive, "--fail-on-app", "--baseline", baseline(entry))
        assert rc == 1

    def test_every_config_key_baselined_passes(self, tmp_path, run, baseline):
        config = {"config": {"Env": [f"API_KEY={SECRET}"]}}
        archive = docker_save(tmp_path / "i.tar", [{"app/a.txt": b"ok\n"}], config=config)
        rc, _, records = run(archive, "--fail-on-app", "--baseline", baseline("fake-rule config.json#Env.API_KEY\n"))
        assert (rc, len(records)) == (0, 1)

    def test_split_names_and_merging(self):
        blobs = {"manifest.json": b"[]"}
        scan.add_config_blobs(blobs, json.dumps({
            "architecture": "amd64",
            "config": {"Env": ["A=1", "A=2", "B.C=3", "../x=4"], "Cmd": ["run"], "Labels": {"l": "v"}},
            "container_config": {"Env": ["A=9"]},
            "history": [{"created_by": "ENV A=1"}, {"created_by": "ENV A=1"}],
            "rootfs": {"diff_ids": ["sha256:x"]},
        }).encode())
        history = [k for k in blobs if k.startswith("config.json#history.")]
        assert len(history) == 1 and blobs[history[0]] == b"ENV A=1\nENV A=1\n"
        assert {k: v for k, v in blobs.items() if k not in history} == {
            "manifest.json": b"[]",
            "config.json#architecture": b'"amd64"\n',
            "config.json#Env.A": b"A=1\nA=2\nA=9\n",  # same key: kept, not overwritten
            "config.json#Env.B_C": b"B.C=3\n",
            "config.json#Env.___x": b"../x=4\n",
            "config.json#config.Cmd": b'["run"]\n',
            "config.json#Labels.l": b"l=v\n",
            "config.json#rootfs.diff_ids": b'["sha256:x"]\n',
        }
        assert all("/" not in k for k in blobs)

    @pytest.mark.parametrize("raw", [b"not json", b"[1, 2]", b'"text"'])
    def test_a_config_that_is_not_an_object_is_scanned_whole(self, raw):
        blobs = {}
        scan.add_config_blobs(blobs, raw)
        assert blobs == {"config.json": raw}


class TestGitleaksConfig:
    def test_gitleaks_runs_with_the_image_config(self, monkeypatch, tmp_path):
        calls = []

        def fake_run(cmd, **kw):
            calls.append(cmd)
            Path(cmd[cmd.index("--report-path") + 1]).write_text("[]")

        monkeypatch.setattr(scan.subprocess, "run", fake_run)
        assert _REAL_GITLEAKS("gitleaks-bin", str(tmp_path), str(tmp_path / "r.json")) == []
        cmd = calls[0]
        # Both the registry walk and the docker-save scan reach gitleaks only through this call.
        assert cmd[cmd.index("--config") + 1] == scan.GITLEAKS_CONFIG
        assert Path(scan.GITLEAKS_CONFIG).name == "gitleaks-images.toml"
        assert Path(scan.GITLEAKS_CONFIG).is_file()

    def _config(self):
        tomllib = pytest.importorskip("tomllib")
        return tomllib.loads(Path(scan.GITLEAKS_CONFIG).read_text())

    def test_one_tight_allowlist_on_the_default_rules(self):
        cfg = self._config()
        assert set(cfg) == {"extend", "allowlist"}
        assert cfg["extend"] == {"useDefault": True}
        # `match`, not `line`: a config blob is one line, so a line match would
        # excuse every other finding in the same config.
        assert cfg["allowlist"]["regexTarget"] == "match"
        assert len(cfg["allowlist"]["regexes"]) == 1
        assert not {"paths", "commits", "stopwords"} & set(cfg["allowlist"])

    def test_allowlist_regex_excuses_only_the_python_gpg_key(self):
        rx = re.compile(self._config()["allowlist"]["regexes"][0])
        fp = "0123456789ABCDEF0123456789ABCDEF01234567"  # 40 uppercase hex, not a real key
        assert len(fp) == 40
        for excused in (f"GPG_KEY={fp}", f'GPG_KEY={fp}"', f"GPG_KEY={fp};", f"GPG_KEY={fp} ",
                        f"GPG_KEY={fp}\n", "GPG_KEY=" + fp + "\\n"):
            assert rx.search(excused), excused
        for kept in (f"GPG_KEY={fp.lower()}", f"GPG_KEY={fp[:-1]}", f"GPG_KEY={fp}0", f"GPG_KEY={fp}A",
                     f"GPG_KEY={fp}=x", f'GPG_KEY={fp}"more', f"MY_GPG_KEY={fp}", f"gpg_key={fp}",
                     f"API_KEY={fp}", f"GPG_KEY= {fp}", f' GPG_KEY={fp}', "GPG_KEY=REDACTED"):
            assert not rx.search(kept), kept


V = [{"digest": f"sha256:{i:02x}" + "f" * 62, "tags": []} for i in range(10)]


class TestVersionSelection:
    def test_shards_partition_the_versions(self):
        slices = [scan.select_versions(V, (k, 3), []) for k in range(3)]
        assert slices == [V[0::3], V[1::3], V[2::3]]
        assert sorted(v["digest"] for s in slices for v in s) == sorted(v["digest"] for v in V)

    def test_digest_prefixes_with_or_without_the_algorithm(self):
        assert scan.select_versions(V, (0, 1), ["sha256:03"]) == [V[3]]
        assert scan.select_versions(V, (0, 1), ["04"]) == [V[4]]
        assert scan.select_versions(V, (0, 1), ["sha256:05", "02"]) == [V[2], V[5]]  # registry order

    def test_digests_are_selected_before_sharding(self):
        assert scan.select_versions(V, (1, 2), ["01", "02", "03"]) == [V[2]]

    def test_a_prefix_that_matches_nothing_is_an_error_not_an_empty_pass(self):
        with pytest.raises(SystemExit) as e:
            scan.select_versions(V, (0, 1), ["03", "zz"])
        assert "zz" in str(e.value)

    @pytest.mark.parametrize("text,want", [("0/1", (0, 1)), ("7/8", (7, 8))])
    def test_parse_shard(self, text, want):
        assert scan.parse_shard(text) == want

    @pytest.mark.parametrize("text", ["8/8", "1/0", "x", "-1/2", "1/2/3", ""])
    def test_parse_shard_rejects(self, text):
        with pytest.raises(argparse.ArgumentTypeError):
            scan.parse_shard(text)

    def test_parse_digests(self):
        assert scan.parse_digests("sha256:ab, cd ,") == ["sha256:ab", "cd"]
        for bad in ("", ",", "sha256:../x", "a b"):
            with pytest.raises(argparse.ArgumentTypeError):
                scan.parse_digests(bad)

    @pytest.mark.parametrize("shard,digests,want", [((1, 3), [], V[1::3]), ((0, 1), ["04"], [V[4]])])
    def test_registry_scan_visits_only_the_selected_versions(self, monkeypatch, capsys, tmp_path,
                                                             shard, digests, want):
        def no_network(*a, **k):
            raise RuntimeError("no network")

        monkeypatch.setattr(scan, "list_versions", lambda org, package: V)
        monkeypatch.setattr(scan, "registry_token", lambda owner, package: "t")
        monkeypatch.setattr(scan, "_get", no_network)
        args = types.SimpleNamespace(owner="o", org="O", package="droplet-demo", gitleaks="x",
                                     shard=shard, digests=digests)
        stats = {"versions": 0, "images": 0, "other": 0, "layers": 0, "layers_reused": 0,
                 "findings": 0, "errors": 0}
        scan.scan_registry(args, str(tmp_path), stats, lambda *a: None)
        out = capsys.readouterr().out
        assert stats["versions"] == stats["errors"] == len(want)
        for v in V:  # each visited version fails once, and is named in its warning
            assert (v["digest"][:19] in out) == (v in want)

    @pytest.mark.parametrize("flags", [["--shard", "0/2"], ["--digests", "ab"]])
    def test_selection_flags_do_not_apply_to_docker_save(self, tmp_path, run, flags):
        with pytest.raises(SystemExit) as e:
            run(docker_save(tmp_path / "i.tar", [CREDS]), *flags)
        assert e.value.code == 2

    def test_bad_shard_is_a_usage_error(self, tmp_path, run):
        with pytest.raises(SystemExit) as e:
            run(docker_save(tmp_path / "i.tar", [CREDS]), "--shard", "3/3")
        assert e.value.code == 2


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
