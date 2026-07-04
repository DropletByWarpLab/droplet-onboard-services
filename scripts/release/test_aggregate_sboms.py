"""WARP-245 — unit suite for aggregate-sboms.py.

Runs in the publish gate alongside test_gen_release_manifest.py
(`python3 -m pytest scripts/release/ -q`). Pure-stdlib fixtures — no
network, no docker, no external deps beyond pytest.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parent / "aggregate-sboms.py"
GIT_SHA = "a" * 40
DIGEST = "sha256:" + "b" * 64


def run(args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True
    )


def make_inputs(tmp_path, names=("orchestrator", "routing")):
    services = {"services": [
        {"name": n, "context": ".", "dockerfile": "Dockerfile",
         "healthcheck": {"type": "none"}} for n in names
    ]}
    sp = tmp_path / "services.json"
    sp.write_text(json.dumps(services), encoding="utf-8")
    dp = tmp_path / "digests.json"
    dp.write_text(json.dumps({n: DIGEST for n in names}), encoding="utf-8")
    sdir = tmp_path / "sbom"
    sdir.mkdir()
    for n in names:
        (sdir / f"droplet-{n}.cdx.json").write_text(json.dumps({
            "bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
            "components": [{
                "type": "library",
                "bom-ref": "pkg:deb/debian/zlib@1.3",
                "name": "zlib", "version": "1.3",
            }],
            "dependencies": [
                {"ref": "pkg:deb/debian/zlib@1.3", "dependsOn": []},
            ],
        }), encoding="utf-8")
    return sp, dp, sdir


def base_args(sp, dp, sdir, out):
    return ["--services", str(sp), "--digests", str(dp),
            "--sbom-dir", str(sdir), "--git-sha", GIT_SHA, "--out", str(out)]


def test_happy_path_builds_a_device_assembly(tmp_path):
    sp, dp, sdir = make_inputs(tmp_path)
    out = tmp_path / "droplet-device.cdx.json"
    res = run(base_args(sp, dp, sdir, out))
    assert res.returncode == 0, res.stderr
    bom = json.loads(out.read_text(encoding="utf-8"))
    assert bom["bomFormat"] == "CycloneDX"
    assert bom["specVersion"] == "1.5"
    assert bom["metadata"]["component"]["type"] == "device"
    assert bom["metadata"]["component"]["version"] == GIT_SHA
    assert {c["bom-ref"] for c in bom["components"]} == {
        "container:droplet-orchestrator", "container:droplet-routing",
    }
    # The SAME zlib ref from both images must be namespaced apart.
    nested = [cc["bom-ref"] for c in bom["components"] for cc in c["components"]]
    assert sorted(nested) == [
        "droplet-orchestrator:pkg:deb/debian/zlib@1.3",
        "droplet-routing:pkg:deb/debian/zlib@1.3",
    ]
    # Rewritten dependency graph + device root edge.
    refs = {d["ref"] for d in bom["dependencies"]}
    assert "droplet-appliance" in refs
    assert "droplet-orchestrator:pkg:deb/debian/zlib@1.3" in refs


def test_missing_sbom_is_refused(tmp_path):
    sp, dp, sdir = make_inputs(tmp_path)
    (sdir / "droplet-routing.cdx.json").unlink()
    res = run(base_args(sp, dp, sdir, tmp_path / "out.cdx.json"))
    assert res.returncode != 0
    assert "no SBOM for service(s): routing" in res.stderr
    assert not (tmp_path / "out.cdx.json").exists()


def test_unknown_sbom_file_is_refused(tmp_path):
    sp, dp, sdir = make_inputs(tmp_path)
    (sdir / "droplet-ghost.cdx.json").write_text("{}", encoding="utf-8")
    res = run(base_args(sp, dp, sdir, tmp_path / "out.cdx.json"))
    assert res.returncode != 0
    assert "unknown service" in res.stderr


def test_wrong_specversion_is_refused(tmp_path):
    sp, dp, sdir = make_inputs(tmp_path)
    target = sdir / "droplet-routing.cdx.json"
    doc = json.loads(target.read_text(encoding="utf-8"))
    doc["specVersion"] = "1.4"
    target.write_text(json.dumps(doc), encoding="utf-8")
    res = run(base_args(sp, dp, sdir, tmp_path / "out.cdx.json"))
    assert res.returncode != 0
    assert "specVersion" in res.stderr


def test_bom_ref_collision_within_one_input_is_refused(tmp_path):
    sp, dp, sdir = make_inputs(tmp_path)
    target = sdir / "droplet-routing.cdx.json"
    doc = json.loads(target.read_text(encoding="utf-8"))
    doc["components"].append(dict(doc["components"][0]))  # duplicate ref
    target.write_text(json.dumps(doc), encoding="utf-8")
    res = run(base_args(sp, dp, sdir, tmp_path / "out.cdx.json"))
    assert res.returncode != 0
    assert "bom-ref collision" in res.stderr


def test_serial_number_is_deterministic_per_git_sha(tmp_path):
    sp, dp, sdir = make_inputs(tmp_path)
    out1, out2 = tmp_path / "one.cdx.json", tmp_path / "two.cdx.json"
    assert run(base_args(sp, dp, sdir, out1)).returncode == 0
    assert run(base_args(sp, dp, sdir, out2)).returncode == 0
    s1 = json.loads(out1.read_text(encoding="utf-8"))["serialNumber"]
    s2 = json.loads(out2.read_text(encoding="utf-8"))["serialNumber"]
    assert s1 == s2 and s1.startswith("urn:uuid:")
