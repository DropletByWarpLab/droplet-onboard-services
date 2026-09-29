"""WARP-3120 — fetch-client-apps.py: the lock is the trust root.

A fake `gh` on PATH plays `gh release download`: it copies $FAKE_ASSET to
<dir>/<pattern> and records its argv, so every test runs the real script.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent / "fetch-client-apps.py"
REAL_LOCK = Path(__file__).resolve().parents[2] / "data" / "app-downloads" / "clients.lock.json"
BODY = b"a notarized dmg, honestly"

FAKE_GH = """#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
[ -n "$FAKE_GH_FAIL" ] && { echo "HTTP 404: Not Found" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in -p) pat="$2"; shift 2 ;; -D) dir="$2"; shift 2 ;; *) shift ;; esac
done
cp "$FAKE_ASSET" "$dir/$pat"
"""


def entry(**over):
    e = {"platform": "macos", "version": "0.2.0",
         "source": {"repo": "DropletByWarpLab/DropletAgent", "tag": "mac-v0.2.0"},
         "file": "Droplet-0.2.0.dmg", "size": len(BODY),
         "sha256": hashlib.sha256(BODY).hexdigest()}
    e.update(over)
    return e


def run(tmp_path, clients, token="t0ken", check=False, fail=False, body=BODY):
    lock = tmp_path / "clients.lock.json"
    lock.write_text(json.dumps({"schemaVersion": 1, "clients": clients}))
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    gh = bin_dir / "gh"
    gh.write_text(FAKE_GH)
    gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
    asset = tmp_path / "asset"
    asset.write_bytes(body)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "GH_TOKEN": token,
           "FAKE_ASSET": str(asset), "FAKE_GH_LOG": str(tmp_path / "gh.log"),
           "FAKE_GH_FAIL": "1" if fail else ""}
    out = tmp_path / "dist"
    argv = [sys.executable, str(SCRIPT), "--lock", str(lock)]
    argv += ["--check"] if check else ["--out-dir", str(out)]
    return subprocess.run(argv, capture_output=True, text=True, env=env), out


def test_tracked_lock_is_valid():
    proc = subprocess.run([sys.executable, str(SCRIPT), "--lock", str(REAL_LOCK), "--check"],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_empty_lock_needs_no_token_and_warns(tmp_path):
    proc, out = run(tmp_path, [], token="")
    assert proc.returncode == 0, proc.stderr
    assert "::warning::" in proc.stdout
    assert json.loads((out / "clients.json").read_text()) == []
    assert not (tmp_path / "gh.log").exists()


def test_pinned_entry_without_token_fails_closed(tmp_path):
    proc, _ = run(tmp_path, [entry()], token="")
    assert proc.returncode != 0
    assert "DROPLET_CLIENT_APPS_TOKEN" in proc.stderr
    assert not (tmp_path / "gh.log").exists()


def test_happy_path_downloads_verifies_and_lists(tmp_path):
    proc, out = run(tmp_path, [entry()])
    assert proc.returncode == 0, proc.stderr
    assert (out / "Droplet-0.2.0.dmg").read_bytes() == BODY
    listed = json.loads((out / "clients.json").read_text())
    assert listed == [{k: entry()[k] for k in ("platform", "version", "file", "size", "sha256")}]
    log = (tmp_path / "gh.log").read_text()
    assert "release download mac-v0.2.0 -R DropletByWarpLab/DropletAgent -p Droplet-0.2.0.dmg" in log


@pytest.mark.parametrize("body,needle", [
    (BODY[:-1] + b"X", "sha256"),   # same size, different bytes
    (BODY + b"!", "bytes"),          # different size
])
def test_mismatch_refuses(tmp_path, body, needle):
    proc, out = run(tmp_path, [entry()], body=body)
    assert proc.returncode != 0
    assert needle in proc.stderr
    assert not (out / "clients.json").exists()


def test_download_failure_refuses(tmp_path):
    proc, _ = run(tmp_path, [entry()], fail=True)
    assert proc.returncode != 0
    assert "404" in proc.stderr


@pytest.mark.parametrize("bad", [
    {"platform": "ios"},
    {"version": "0.2"},
    {"version": "v0.2.0"},
    {"file": "../Droplet.dmg"},
    {"file": "release.json"},
    {"sha256": "ABC"},
    {"size": 0},
    {"size": True},
    {"source": {"repo": "someone/else", "tag": "v1"}},
    {"source": {"repo": "DropletByWarpLab/DropletAgent", "tag": "-x"}},
])
def test_malformed_lock_entry_refuses(tmp_path, bad):
    proc, _ = run(tmp_path, [entry(**bad)], check=True)
    assert proc.returncode != 0, bad


def test_duplicate_platform_refuses(tmp_path):
    proc, _ = run(tmp_path, [entry(), entry(file="Droplet-0.2.1.dmg")], check=True)
    assert proc.returncode != 0
    assert "twice" in proc.stderr
