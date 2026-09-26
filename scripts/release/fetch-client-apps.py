#!/usr/bin/env python3
"""WARP-3120 — fetch the client installers an OTA release carries.

Called by .github/workflows/publish-release.yml BEFORE any image is built,
so a bad lock or a missing token costs seconds, not a two-hour run.

  --lock     data/app-downloads/clients.lock.json (tracked; the trust root)
  --out-dir  where the installers and clients.json land (dist/clients)
  --check    validate the lock only; download nothing (CI, tests)

For each lock entry it runs `gh release download <tag> -R <repo> -p <file>`
with the token in GH_TOKEN (secret DROPLET_CLIENT_APPS_TOKEN: a fine-grained
PAT, contents:read on DropletAgent only; the workflow's own GITHUB_TOKEN
cannot read another private repo), then refuses the file unless its size and
sha256 equal the lock's. It writes `clients.json`, the list
gen-release-manifest.py puts in the signed release.json.

Fails closed: a malformed lock, a missing token while the lock lists an
entry, a download error or a mismatch all exit non-zero and nothing is
published. An EMPTY lock needs no token: the release carries no client app
and the step says so with a warning, so releases keep working before the
secret exists.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Platforms the box can serve as an installer (gen-catalog.mjs; ios is
# store-only and never a file the box hands out).
PLATFORMS = {"windows", "macos", "linux", "android"}
# The catalog parser's own ASSET_NAME_RE (apps/orchestrator/.../catalog.ts).
ASSET_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
VERSION_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# Only this org's repos: the lock must not become a way to ship a stranger's bytes.
REPO_RE = re.compile(r"^DropletByWarpLab/[A-Za-z0-9._-]+$")
TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
# Names already taken by the OTA release's own assets.
RESERVED = {"release.json", "release.json.sig", "configs.tar.gz",
            "image-signatures.json", "cosign.pub", "clients.json"}


def die(msg: str) -> None:
    print(f"::error::fetch-client-apps: {msg}", file=sys.stderr)
    sys.exit(1)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_lock(path: Path) -> list[dict]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        die(f"cannot read {path}: {exc}")
    if not isinstance(doc, dict) or doc.get("schemaVersion") != 1:
        die(f"{path}: schemaVersion must be 1")
    clients = doc.get("clients")
    if not isinstance(clients, list):
        die(f"{path}: clients must be an array")
    seen: set[str] = set()
    for i, c in enumerate(clients):
        where = f"{path}: clients[{i}]"
        if not isinstance(c, dict):
            die(f"{where} must be an object")
        src = c.get("source")
        checks = [
            (c.get("platform") in PLATFORMS, f"platform must be one of {sorted(PLATFORMS)}"),
            (isinstance(c.get("version"), str) and VERSION_RE.match(c["version"]), "version must be x.y.z"),
            (isinstance(c.get("file"), str) and ASSET_NAME_RE.match(c["file"])
             and c["file"] not in RESERVED, "file must be a plain asset name (letters, digits, . _ + -) and not an OTA asset name"),
            (isinstance(c.get("size"), int) and not isinstance(c["size"], bool) and c["size"] > 0, "size must be a positive integer"),
            (isinstance(c.get("sha256"), str) and SHA256_RE.match(c["sha256"]), "sha256 must be 64 lowercase hex"),
            (isinstance(src, dict) and isinstance(src.get("repo"), str) and REPO_RE.match(src["repo"]),
             "source.repo must be DropletByWarpLab/<repo>"),
            (isinstance(src, dict) and isinstance(src.get("tag"), str) and TAG_RE.match(src["tag"]), "source.tag must be a plain tag name"),
        ]
        for ok, msg in checks:
            if not ok:
                die(f"{where}: {msg}")
        if c["platform"] in seen:
            die(f"{where}: platform {c['platform']} is listed twice")
        seen.add(c["platform"])
    return clients


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lock", required=True, type=Path)
    ap.add_argument("--out-dir", type=Path)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    clients = load_lock(args.lock)
    if args.check:
        print(f"fetch-client-apps: {args.lock} is valid ({len(clients)} client(s))")
        return
    if args.out_dir is None:
        die("--out-dir is required unless --check")
    args.out_dir.mkdir(parents=True, exist_ok=True)

    if not clients:
        print("::warning::fetch-client-apps: the lock pins no client app, so this "
              "release carries none (boxes keep what they have staged)")
    elif not os.environ.get("GH_TOKEN"):
        die("the lock pins " + ", ".join(c["platform"] for c in clients)
            + " but the DROPLET_CLIENT_APPS_TOKEN secret is empty. Add it "
            "(fine-grained PAT, contents:read on the source repo; "
            "`gh secret set DROPLET_CLIENT_APPS_TOKEN -R DropletByWarpLab/droplet-onboard-services`), "
            "or empty the lock's clients to publish without them")

    entries = []
    for c in clients:
        dest = args.out_dir / c["file"]
        dest.unlink(missing_ok=True)
        proc = subprocess.run(
            ["gh", "release", "download", c["source"]["tag"],
             "-R", c["source"]["repo"], "-p", c["file"], "-D", str(args.out_dir)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            die(f"gh release download {c['source']['tag']} -R {c['source']['repo']} "
                f"-p {c['file']} failed: {proc.stderr.strip()[:500]}")
        if not dest.is_file():
            die(f"{c['file']} is not in release {c['source']['repo']}@{c['source']['tag']}")
        size = dest.stat().st_size
        if size != c["size"]:
            die(f"{c['file']} is {size} bytes, the lock says {c['size']}; refusing to publish")
        digest = sha256_file(dest)
        if digest != c["sha256"]:
            die(f"{c['file']} sha256 {digest} != lock {c['sha256']}; refusing to publish")
        print(f"fetch-client-apps: {c['platform']} {c['version']} {c['file']} verified ({size} bytes)")
        entries.append({k: c[k] for k in ("platform", "version", "file", "size", "sha256")})

    (args.out_dir / "clients.json").write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
