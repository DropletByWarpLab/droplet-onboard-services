"""WARP-3502 — unit tests for mirror-to-r2.py (the GHCR -> R2 registry mirror).

publish-release.yml runs this script between "images signed and self-verified"
and "create the GitHub Release". The release must never name a digest the HQ
registry cannot serve, so these tests pin: the exact R2 layout the Worker reads
(fleet contract v1, section 3), the manifest media types stored as Content-Type,
the cosign `sha256-<hex>.sig` tag, idempotent skips, the order (blobs, manifests,
tags), every fail-closed path, and the skip / refuse decision for missing
secrets. GHCR and R2 are replaced by in-memory fakes; one end-to-end test also
runs the real subprocess code against stand-in `crane` and `aws` executables.
No network, no cloud credentials.

Run locally / in CI:
    python3 -m pytest scripts/release/ -v
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

HERE = Path(__file__).parent
SCRIPT = HERE / "mirror-to-r2.py"


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mirror = _load("mirror_to_r2", "mirror-to-r2.py")

ALL = {
    "R2_ACCOUNT_ID": "0123456789abcdef0123456789abcdef",
    "R2_ACCESS_KEY_ID": "key-id",
    "R2_SECRET_ACCESS_KEY": "key-secret",
    "R2_BUCKET": "droplet-ota",
}
HOST = "droplet-fleet-hq.rjouffret.workers.dev"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def hexof(digest):
    return digest.split(":", 1)[1]


class FakeRegistry:
    """GHCR stand-in: raw manifests and blobs by ref, the way `crane` serves them."""

    BASE = "ghcr.io/dropletbywarplab"

    def __init__(self):
        self.manifests = {}  # "sha256:<hex>" -> raw bytes
        self.blobs = {}      # "sha256:<hex>" -> bytes
        self.tags = {}       # "<repo ref>:<tag>" -> raw bytes
        self.blob_fetches = []

    def blob(self, data):
        digest = "sha256:" + sha(data)
        self.blobs[digest] = data
        return {"digest": digest, "size": len(data)}

    def manifest(self, doc):
        raw = json.dumps(doc, sort_keys=True).encode()
        digest = "sha256:" + sha(raw)
        self.manifests[digest] = raw
        return digest

    def image(self, seed, layers, media=mirror.OCI_MANIFEST):
        return self.manifest({
            "schemaVersion": 2,
            "mediaType": media,
            "config": {"mediaType": "application/vnd.oci.image.config.v1+json",
                       **self.blob(b"config-" + seed)},
            "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                        **self.blob(layer)} for layer in layers],
        })

    def sign(self, repo, image_digest, seed):
        """What `cosign sign` leaves behind: a manifest at tag sha256-<hex>.sig."""
        sig = self.manifest({
            "schemaVersion": 2,
            "mediaType": mirror.OCI_MANIFEST,
            "config": {"mediaType": "application/vnd.dev.cosign.artifact.sig.v1+json",
                       **self.blob(b"sig-config-" + seed)},
            "layers": [{"mediaType": "application/vnd.dev.cosign.simplesigning.v1+json",
                        **self.blob(b"sig-payload-" + seed)}],
        })
        self.tags[f"{self.BASE}/{repo}:sha256-{hexof(image_digest)}.sig"] = self.manifests[sig]
        return sig

    def fetch_manifest(self, ref):
        if "@" in ref:
            digest = ref.split("@", 1)[1]
            if digest in self.manifests:
                return self.manifests[digest]
        elif ref in self.tags:
            return self.tags[ref]
        raise mirror.Fail(f"manifest unknown: {ref}")

    def fetch_blob(self, ref, dest):
        digest = ref.split("@", 1)[1]
        self.blob_fetches.append(digest)
        Path(dest).write_bytes(self.blobs[digest])


class FakeS3:
    """R2 stand-in: key -> (bytes, content type), with the put order recorded."""

    def __init__(self):
        self.objects = {}
        self.put_keys = []

    def list(self):
        return {k: len(v[0]) for k, v in self.objects.items()}

    def put(self, key, path, content_type):
        self.put_keys.append(key)
        self.objects[key] = (Path(path).read_bytes(), content_type)


def run_mirror(reg, digests, s3, tmp_path, fetch_blob=None):
    return mirror.mirror(reg.BASE, digests, tmp_path / "scratch", reg.fetch_manifest,
                         fetch_blob or reg.fetch_blob, s3)


# ── the R2 layout ───────────────────────────────────────────────────────────

class TestLayout:
    def test_image_signature_blobs_and_tag_land_where_the_worker_reads_them(self, tmp_path):
        reg, s3 = FakeRegistry(), FakeS3()
        img = reg.image(b"orch", [b"layer-a", b"layer-b"])
        sig = reg.sign("droplet-orchestrator", img, b"orch")

        stats = run_mirror(reg, {"orchestrator": img}, s3, tmp_path)

        # manifests, stored with the manifest media type as Content-Type
        assert s3.objects[f"oci/manifests/sha256/{hexof(img)}"] == (
            reg.manifests[img], mirror.OCI_MANIFEST)
        assert s3.objects[f"oci/manifests/sha256/{hexof(sig)}"] == (
            reg.manifests[sig], mirror.OCI_MANIFEST)
        # every config and layer blob, of the image and of the signature
        for digest, data in reg.blobs.items():
            assert s3.objects[f"oci/blobs/sha256/{hexof(digest)}"] == (
                data, "application/octet-stream")
        # the cosign tag is a text object holding the signature manifest digest
        assert s3.objects[f"oci/tags/droplet-orchestrator/sha256-{hexof(img)}.sig"] == (
            sig.encode(), "text/plain")
        assert all(k.startswith("oci/") for k in s3.objects)
        assert stats["images"] == 1 and stats["blobs"] == len(reg.blobs)
        assert stats["manifests"] == 2 and stats["tags"] == 1
        # the scratch dir is left empty: a multi-GB layer never outlives its upload
        assert list((tmp_path / "scratch").iterdir()) == []

    def test_multi_arch_index_copies_every_child_before_the_index(self, tmp_path):
        reg, s3 = FakeRegistry(), FakeS3()
        amd = reg.image(b"amd", [b"a1"])
        arm = reg.image(b"arm", [b"r1"], media=mirror.DOCKER_MANIFEST)
        index = reg.manifest({
            "schemaVersion": 2, "mediaType": mirror.OCI_INDEX,
            "manifests": [
                {"mediaType": mirror.OCI_MANIFEST, "digest": amd, "size": 1},
                {"mediaType": mirror.DOCKER_MANIFEST, "digest": arm, "size": 1},
            ]})
        reg.sign("droplet-x", index, b"x")

        run_mirror(reg, {"x": index}, s3, tmp_path)

        for digest, media in ((amd, mirror.OCI_MANIFEST), (arm, mirror.DOCKER_MANIFEST),
                              (index, mirror.OCI_INDEX)):
            assert s3.objects[f"oci/manifests/sha256/{hexof(digest)}"][1] == media
        order = s3.put_keys
        index_at = order.index(f"oci/manifests/sha256/{hexof(index)}")
        assert order.index(f"oci/manifests/sha256/{hexof(amd)}") < index_at
        assert order.index(f"oci/manifests/sha256/{hexof(arm)}") < index_at

    def test_media_type_comes_from_the_descriptor_when_the_manifest_has_none(self, tmp_path):
        reg, s3 = FakeRegistry(), FakeS3()
        child = reg.manifest({
            "schemaVersion": 2,
            "config": {"mediaType": "application/vnd.docker.container.image.v1+json",
                       **reg.blob(b"cfg")},
            "layers": [{"mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip",
                        **reg.blob(b"lay")}]})
        index = reg.manifest({
            "schemaVersion": 2,
            "manifests": [{"mediaType": mirror.DOCKER_MANIFEST, "digest": child, "size": 1}]})
        reg.sign("droplet-x", index, b"x")

        run_mirror(reg, {"x": index}, s3, tmp_path)

        assert s3.objects[f"oci/manifests/sha256/{hexof(child)}"][1] == mirror.DOCKER_MANIFEST
        assert s3.objects[f"oci/manifests/sha256/{hexof(index)}"][1] == mirror.OCI_INDEX

    def test_blobs_go_up_before_manifests_and_tags_go_last(self, tmp_path):
        reg, s3 = FakeRegistry(), FakeS3()
        img = reg.image(b"o", [b"l1", b"l2"])
        reg.sign("droplet-orchestrator", img, b"o")

        run_mirror(reg, {"orchestrator": img}, s3, tmp_path)

        kinds = [k.split("/")[1] for k in s3.put_keys]  # blobs / manifests / tags
        assert kinds == sorted(kinds, key={"blobs": 0, "manifests": 1, "tags": 2}.get)
        assert kinds[-1] == "tags"


# ── idempotence ─────────────────────────────────────────────────────────────

class TestSkipExisting:
    def test_second_run_downloads_and_uploads_nothing_but_the_mutable_tag(self, tmp_path):
        reg, s3 = FakeRegistry(), FakeS3()
        img = reg.image(b"o", [b"l1", b"l2"])
        reg.sign("droplet-orchestrator", img, b"o")
        run_mirror(reg, {"orchestrator": img}, s3, tmp_path)
        reg.blob_fetches.clear()
        s3.put_keys.clear()

        stats = run_mirror(reg, {"orchestrator": img}, s3, tmp_path)

        assert reg.blob_fetches == []
        assert stats["blobs_uploaded"] == 0 and stats["blobs_skipped"] == stats["blobs"]
        assert s3.put_keys == [f"oci/tags/droplet-orchestrator/sha256-{hexof(img)}.sig"]

    def test_blob_with_the_wrong_size_is_replaced(self, tmp_path):
        reg, s3 = FakeRegistry(), FakeS3()
        img = reg.image(b"o", [b"layer-a"])
        reg.sign("droplet-orchestrator", img, b"o")
        run_mirror(reg, {"orchestrator": img}, s3, tmp_path)
        key = f"oci/blobs/sha256/{sha(b'layer-a')}"
        s3.objects[key] = (b"trunc", "application/octet-stream")

        run_mirror(reg, {"orchestrator": img}, s3, tmp_path)

        assert s3.objects[key][0] == b"layer-a"

    def test_a_blob_shared_by_two_images_is_copied_once(self, tmp_path):
        reg, s3 = FakeRegistry(), FakeS3()
        a = reg.image(b"a", [b"base-layer", b"a-only"])
        b = reg.image(b"b", [b"base-layer", b"b-only"])
        reg.sign("droplet-a", a, b"a")
        reg.sign("droplet-b", b, b"b")

        run_mirror(reg, {"a": a, "b": b}, s3, tmp_path)

        shared = sha(b"base-layer")
        assert reg.blob_fetches.count("sha256:" + shared) == 1
        assert s3.put_keys.count(f"oci/blobs/sha256/{shared}") == 1
        assert f"oci/tags/droplet-a/sha256-{hexof(a)}.sig" in s3.objects
        assert f"oci/tags/droplet-b/sha256-{hexof(b)}.sig" in s3.objects


# ── fail closed ─────────────────────────────────────────────────────────────

class TestFailClosed:
    def test_a_failed_blob_download_stops_before_any_manifest_or_tag(self, tmp_path):
        reg, s3 = FakeRegistry(), FakeS3()
        img = reg.image(b"o", [b"l1"])
        reg.sign("droplet-orchestrator", img, b"o")

        def boom(ref, dest):
            raise mirror.Fail("registry unreachable")

        with pytest.raises(mirror.Fail, match="registry unreachable"):
            run_mirror(reg, {"orchestrator": img}, s3, tmp_path, fetch_blob=boom)
        assert not [k for k in s3.objects if k.startswith(("oci/manifests/", "oci/tags/"))]

    def test_a_blob_that_does_not_hash_to_its_digest_is_never_stored(self, tmp_path):
        reg, s3 = FakeRegistry(), FakeS3()
        img = reg.image(b"o", [b"layer-a"])
        reg.sign("droplet-orchestrator", img, b"o")
        reg.blobs["sha256:" + sha(b"layer-a")] = b"tampered"

        with pytest.raises(mirror.Fail, match="refusing to store"):
            run_mirror(reg, {"orchestrator": img}, s3, tmp_path)
        assert f"oci/blobs/sha256/{sha(b'layer-a')}" not in s3.objects
        assert list((tmp_path / "scratch").glob("blob-*")) == []

    def test_an_image_without_a_cosign_signature_tag_fails(self, tmp_path):
        reg, s3 = FakeRegistry(), FakeS3()
        img = reg.image(b"o", [b"l1"])

        with pytest.raises(mirror.Fail, match="no cosign signature tag"):
            run_mirror(reg, {"orchestrator": img}, s3, tmp_path)
        assert not [k for k in s3.objects if k.startswith("oci/tags/")]

    def test_a_manifest_that_does_not_hash_to_its_digest_fails(self, tmp_path):
        reg, s3 = FakeRegistry(), FakeS3()
        img = reg.image(b"o", [b"l1"])
        reg.sign("droplet-orchestrator", img, b"o")
        reg.manifests[img] += b" "

        with pytest.raises(mirror.Fail, match="do not hash"):
            run_mirror(reg, {"orchestrator": img}, s3, tmp_path)

    def test_an_unsupported_media_type_fails(self, tmp_path):
        reg, s3 = FakeRegistry(), FakeS3()
        odd = reg.manifest({"schemaVersion": 2, "mediaType": "application/vnd.example+json"})

        with pytest.raises(mirror.Fail, match="unsupported manifest media type"):
            run_mirror(reg, {"x": odd}, s3, tmp_path)

    def test_a_malformed_digest_fails(self, tmp_path):
        with pytest.raises(mirror.Fail, match="malformed digest"):
            run_mirror(FakeRegistry(), {"orchestrator": "sha256:xyz"}, FakeS3(), tmp_path)

    def test_the_final_listing_catches_an_upload_that_silently_vanished(self, tmp_path):
        class Lossy(FakeS3):
            def put(self, key, path, content_type):
                if "/manifests/" in key:
                    return
                super().put(key, path, content_type)

        reg = FakeRegistry()
        img = reg.image(b"o", [b"l1"])
        reg.sign("droplet-orchestrator", img, b"o")

        with pytest.raises(mirror.Fail, match="missing or wrong size"):
            run_mirror(reg, {"orchestrator": img}, Lossy(), tmp_path)


# ── missing secrets: skip, or refuse ────────────────────────────────────────

class TestDecide:
    def test_all_secrets_enable_the_mirror(self):
        assert mirror.decide(dict(ALL))[0] is True

    def test_all_secrets_and_the_host_enable_the_mirror(self):
        assert mirror.decide({**ALL, "OTA_REGISTRY_HOST": HOST})[0] is True

    def test_no_secrets_and_no_host_skips_loudly(self):
        enabled, msg = mirror.decide({})
        assert enabled is False
        assert "SKIPPED" in msg and "ghcr" in msg  # a message, not a URL (CodeQL py/incomplete-url-substring-sanitization)

    def test_unset_github_values_arrive_as_empty_strings_and_count_as_absent(self):
        env = {k: "" for k in ALL}
        env["OTA_REGISTRY_HOST"] = ""
        assert mirror.decide(env)[0] is False

    def test_the_host_without_secrets_is_a_hard_failure(self):
        with pytest.raises(mirror.Fail, match="OTA_REGISTRY_HOST is set"):
            mirror.decide({"OTA_REGISTRY_HOST": HOST})

    def test_the_host_with_one_secret_missing_is_a_hard_failure(self):
        env = {**ALL, "OTA_REGISTRY_HOST": HOST}
        del env["R2_BUCKET"]
        with pytest.raises(mirror.Fail, match="R2_BUCKET"):
            mirror.decide(env)

    def test_partly_configured_secrets_are_refused_even_without_the_host(self):
        with pytest.raises(mirror.Fail, match="partly configured"):
            mirror.decide({"R2_BUCKET": "droplet-ota"})

    @pytest.mark.parametrize("account", ["abc", ALL["R2_ACCOUNT_ID"] + "\n", ALL["R2_ACCOUNT_ID"].upper()])
    def test_a_malformed_account_id_is_refused(self, account):
        with pytest.raises(mirror.Fail, match="R2_ACCOUNT_ID"):
            mirror.decide({**ALL, "R2_ACCOUNT_ID": account})

    @pytest.mark.parametrize("bucket", ["Droplet", "a", "x_y", "droplet-ota\n"])
    def test_a_malformed_bucket_name_is_refused(self, bucket):
        with pytest.raises(mirror.Fail, match="R2_BUCKET"):
            mirror.decide({**ALL, "R2_BUCKET": bucket})

    @pytest.mark.parametrize("host", ["https://hq.example.test", "HQ.example.test", "hq.example.test/p"])
    def test_a_malformed_host_is_refused_before_the_build(self, host):
        with pytest.raises(mirror.Fail, match="OTA_REGISTRY_HOST must be"):
            mirror.decide({**ALL, "OTA_REGISTRY_HOST": host})

    def test_the_host_pattern_is_the_one_the_manifest_generator_enforces(self):
        gen = _load("gen_release_manifest", "gen-release-manifest.py")
        assert gen.HOST_RE.pattern == mirror.HOST_RE.pattern


# ── aws CLI wiring ──────────────────────────────────────────────────────────

class TestAws:
    def test_equal_multipart_parts_and_r2_keys(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AWS_PROFILE", "must-not-leak")
        env = mirror.aws_env(ALL, tmp_path / "r2")
        cfg = Path(env["AWS_CONFIG_FILE"]).read_text()
        # R2 needs equal-sized parts: one explicit size, threshold = chunk size
        assert "multipart_chunksize = 64MB" in cfg
        assert "multipart_threshold = 64MB" in cfg
        assert env["AWS_ACCESS_KEY_ID"] == "key-id"
        assert env["AWS_SECRET_ACCESS_KEY"] == "key-secret"
        assert env["AWS_REQUEST_CHECKSUM_CALCULATION"] == "when_required"
        assert env["AWS_RESPONSE_CHECKSUM_VALIDATION"] == "when_required"
        assert "AWS_PROFILE" not in env

    def test_list_and_put_call_aws_against_the_r2_endpoint(self, tmp_path, monkeypatch):
        calls = []

        def fake_run(cmd, env=None, stdout=None):
            calls.append(cmd)
            return types.SimpleNamespace(stdout=b'[["oci/blobs/sha256/aa", 5]]')

        monkeypatch.setattr(mirror, "run", fake_run)
        r2 = mirror.R2(ALL, tmp_path / "r2")

        assert r2.list() == {"oci/blobs/sha256/aa": 5}
        r2.put("oci/tags/droplet-x/t", tmp_path / "f", "text/plain")

        endpoint = f"https://{ALL['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
        assert calls[0][:4] == ["aws", "--endpoint-url", endpoint, "s3api"]
        assert "list-objects-v2" in calls[0] and "droplet-ota" in calls[0]
        assert calls[1][:5] == ["aws", "--endpoint-url", endpoint, "s3", "cp"]
        assert "s3://droplet-ota/oci/tags/droplet-x/t" in calls[1]
        assert calls[1][calls[1].index("--content-type") + 1] == "text/plain"

    @pytest.mark.parametrize("text,want", [
        ("", {}),
        ("null", {}),
        ('[["a", 1]]', {"a": 1}),
        ('[["a", 1]]\n[["b", 2]]\n', {"a": 1, "b": 2}),
        ('null\n[["b", 2]]', {"b": 2}),
    ])
    def test_listing_parser_survives_empty_and_paged_output(self, text, want):
        assert mirror.parse_listing(text) == want


# ── CLI ─────────────────────────────────────────────────────────────────────

FAKE_CRANE = """#!PYTHON
import os, sys
cmd, ref = sys.argv[1], sys.argv[2]
key = ref.split("@", 1)[1].replace(":", "-") if "@" in ref else "tag-" + ref.rsplit(":", 1)[1]
path = os.path.join(os.environ["FAKE_REG"], cmd + "-" + key)
if not os.path.exists(path):
    sys.stderr.write("NAME_UNKNOWN " + ref + "\\n")
    sys.exit(1)
with open(path, "rb") as fh:
    sys.stdout.buffer.write(fh.read())
"""

FAKE_AWS = """#!PYTHON
import json, os, shutil, sys
args = sys.argv[1:]
if args[0] == "--endpoint-url":
    args = args[2:]
root = os.environ["FAKE_R2"]
if args[:2] == ["s3api", "list-objects-v2"]:
    rows = []
    for dirpath, _, names in os.walk(root):
        for name in names:
            p = os.path.join(dirpath, name)
            rows.append([os.path.relpath(p, root), os.path.getsize(p)])
    print(json.dumps(rows) if rows else "null")
elif args[:2] == ["s3", "cp"]:
    key = args[3].split("/", 3)[3]
    dest = os.path.join(root, key)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copyfile(args[2], dest)
    with open(os.environ["FAKE_LOG"], "a") as log:
        log.write(json.dumps({"key": key, "ct": args[args.index("--content-type") + 1]}) + "\\n")
else:
    sys.exit(2)
"""


def run_cli(tmp_path, env_extra, *argv):
    out = tmp_path / "gh-output"
    env = {"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(out),
           "GITHUB_STEP_SUMMARY": str(tmp_path / "gh-summary"), **env_extra}
    proc = subprocess.run([sys.executable, str(SCRIPT), *argv], env=env,
                          capture_output=True, text=True)
    return proc, (out.read_text() if out.exists() else "")


class TestCli:
    def test_decide_skip_warns_exits_zero_and_says_so_in_the_summary(self, tmp_path):
        proc, out = run_cli(tmp_path, {}, "decide")
        assert proc.returncode == 0, proc.stderr
        assert out.strip() == "enabled=false"
        assert "::warning" in proc.stdout
        assert "SKIPPED" in (tmp_path / "gh-summary").read_text()

    def test_decide_enabled(self, tmp_path):
        proc, out = run_cli(tmp_path, dict(ALL), "decide")
        assert proc.returncode == 0, proc.stderr
        assert out.strip() == "enabled=true"

    def test_decide_refuses_the_host_without_secrets(self, tmp_path):
        proc, out = run_cli(tmp_path, {"OTA_REGISTRY_HOST": HOST}, "decide")
        assert proc.returncode == 1
        assert "::error" in proc.stderr
        assert out == ""

    def test_copy_end_to_end_with_stand_in_crane_and_aws(self, tmp_path):
        reg = FakeRegistry()
        img = reg.image(b"o", [b"layer-a"])
        sig = reg.sign("droplet-orchestrator", img, b"o")

        bin_dir, reg_dir, r2_dir = tmp_path / "bin", tmp_path / "reg", tmp_path / "r2"
        for d in (bin_dir, reg_dir, r2_dir):
            d.mkdir()
        for name, body in (("crane", FAKE_CRANE), ("aws", FAKE_AWS)):
            tool = bin_dir / name
            tool.write_text(body.replace("PYTHON", sys.executable, 1))
            tool.chmod(0o755)
        for digest, raw in reg.manifests.items():
            (reg_dir / ("manifest-" + digest.replace(":", "-"))).write_bytes(raw)
        for digest, data in reg.blobs.items():
            (reg_dir / ("blob-" + digest.replace(":", "-"))).write_bytes(data)
        for ref, raw in reg.tags.items():
            (reg_dir / ("manifest-tag-" + ref.rsplit(":", 1)[1])).write_bytes(raw)
        digests = tmp_path / "digests.json"
        digests.write_text(json.dumps({"orchestrator": img}))
        log = tmp_path / "aws-calls.jsonl"

        proc, _ = run_cli(
            tmp_path,
            {**ALL, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
             "FAKE_REG": str(reg_dir), "FAKE_R2": str(r2_dir), "FAKE_LOG": str(log)},
            "copy", "--digests", str(digests), "--registry", reg.BASE,
            "--scratch", str(tmp_path / "scratch"))

        assert proc.returncode == 0, proc.stderr
        assert "R2 mirror: 1 images" in proc.stdout
        assert (r2_dir / "oci" / "manifests" / "sha256" / hexof(img)).read_bytes() == reg.manifests[img]
        assert (r2_dir / "oci" / "tags" / "droplet-orchestrator" /
                f"sha256-{hexof(img)}.sig").read_text() == sig
        for digest, data in reg.blobs.items():
            assert (r2_dir / "oci" / "blobs" / "sha256" / hexof(digest)).read_bytes() == data
        uploaded = {row["key"]: row["ct"] for row in map(json.loads, log.read_text().splitlines())}
        assert uploaded[f"oci/manifests/sha256/{hexof(img)}"] == mirror.OCI_MANIFEST
        assert uploaded[f"oci/tags/droplet-orchestrator/sha256-{hexof(img)}.sig"] == "text/plain"

    def test_copy_fails_closed_when_crane_cannot_read_the_image(self, tmp_path):
        bin_dir, r2_dir = tmp_path / "bin", tmp_path / "r2"
        bin_dir.mkdir()
        r2_dir.mkdir()
        for name, body in (("crane", FAKE_CRANE), ("aws", FAKE_AWS)):
            tool = bin_dir / name
            tool.write_text(body.replace("PYTHON", sys.executable, 1))
            tool.chmod(0o755)
        (tmp_path / "reg").mkdir()
        digests = tmp_path / "digests.json"
        digests.write_text(json.dumps({"orchestrator": "sha256:" + "a" * 64}))

        proc, _ = run_cli(
            tmp_path,
            {**ALL, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
             "FAKE_REG": str(tmp_path / "reg"), "FAKE_R2": str(r2_dir),
             "FAKE_LOG": str(tmp_path / "aws-calls.jsonl")},
            "copy", "--digests", str(digests), "--registry", FakeRegistry.BASE,
            "--scratch", str(tmp_path / "scratch"))

        assert proc.returncode == 1
        assert "::error" in proc.stderr and "NAME_UNKNOWN" in proc.stderr
        assert list(r2_dir.rglob("*")) == []
