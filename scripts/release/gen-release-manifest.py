#!/usr/bin/env python3
"""WARP-536 — generate the OTA `release.json` manifest (design schema v1).

Called by .github/workflows/publish-release.yml after every app image has
been built and pushed by digest. Inputs:

  --services  scripts/release/services.json (canonical service list +
              per-service healthcheck the update agent probes post-swap)
  --digests   JSON map {service-name: "sha256:<64 hex>"} captured from the
              pushed images
  --configs   the packed configs.tar.gz (sha256 recorded in the manifest)
  --git-sha   the commit the release was built from
  --channel   release channel — `stable` (main) or `stage` (WARP-1670)
  --registry  image registry/namespace prefix (lowercase; GHCR requires it)
  --out       where to write release.json

Every image reference is pinned BY DIGEST (`@sha256:...`), never by tag
alone — tags are mutable, digests are the contract the device-side update
agent (WARP-537/538) verifies and applies.

Fails LOUDLY (non-zero, nothing written) on any drift between the service
list and the digest map: a service without a digest means an image was not
pushed; a digest without a service means the build loop and services.json
disagree. Both are release-blocking, not warnings.

Sibling of scripts/image/gen-manifest.py (ADR-020 appliance-ISO manifest);
the two manifests are different trust domains and are signed with
different keys — see scripts/README.md "OTA release signing".
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# Bump when the device-side orchestrator gains schema-relevant behavior
# the release depends on. The update agent refuses manifests demanding a
# newer orchestrator schema than it understands (forward-compat gate) and
# refuses schemaVersion downgrades outright (WARP-537).
SCHEMA_VERSION = 1
MIN_ORCHESTRATOR_SCHEMA = 1

# The release channels a manifest may claim. Growing this set is a design
# change, not a workflow flag — every value here needs a matching release
# branch (publish-release.yml derives the channel from the dispatch ref),
# a device-side discovery rule (poller.ts / update_poll.py), and an entry
# in the cosign identity policy (scripts/lib/apply-update.sh).
#
#   stable — refs/heads/main,  the release every box eventually gets
#   stage  — refs/heads/stage, the pre-flight channel (WARP-1670)
ALLOWED_CHANNELS = {"stable", "stage"}

DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def die(msg: str) -> None:
    print(f"gen-release-manifest: ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--services", required=True, type=Path)
    ap.add_argument("--digests", required=True, type=Path)
    ap.add_argument("--configs", required=True, type=Path)
    ap.add_argument("--git-sha", required=True)
    ap.add_argument("--channel", default="stable")
    ap.add_argument("--registry", default="ghcr.io/dropletbywarplab")
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    if args.channel not in ALLOWED_CHANNELS:
        die(f"unknown channel {args.channel!r}; allowed: {sorted(ALLOWED_CHANNELS)}")
    if not re.fullmatch(r"[0-9a-f]{40}", args.git_sha):
        die(f"--git-sha must be a full 40-hex commit sha, got {args.git_sha!r}")
    if not args.configs.is_file():
        die(f"configs bundle not found: {args.configs}")

    services = json.loads(args.services.read_text(encoding="utf-8"))["services"]
    digests = json.loads(args.digests.read_text(encoding="utf-8"))

    names = [s["name"] for s in services]
    missing = [n for n in names if n not in digests]
    if missing:
        die(f"no pushed digest for service(s): {', '.join(missing)} — "
            "image build/push did not complete; refusing to publish")
    extra = [n for n in digests if n not in names]
    if extra:
        die(f"digest(s) for unknown service(s): {', '.join(extra)} — "
            "build loop and scripts/release/services.json have drifted")
    bad = {n: d for n, d in digests.items() if not DIGEST_RE.match(d)}
    if bad:
        die(f"malformed digest(s) (want sha256:<64 hex>): {bad}")

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "release": {
            "gitSha": args.git_sha,
            "builtAt": datetime.now(timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%SZ"),
            "channel": args.channel,
            "minOrchestratorSchema": MIN_ORCHESTRATOR_SCHEMA,
        },
        "services": [
            {
                "name": s["name"],
                "image": f"{args.registry}/droplet-{s['name']}@{digests[s['name']]}",
                "digest": digests[s["name"]],
                "healthcheck": s["healthcheck"],
            }
            for s in services
        ],
        "configs": {
            "file": args.configs.name,
            "sha256": sha256_file(args.configs),
        },
    }

    args.out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"gen-release-manifest: wrote {args.out} "
          f"({len(services)} services, channel={args.channel})")


if __name__ == "__main__":
    main()
