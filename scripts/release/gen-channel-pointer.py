#!/usr/bin/env python3
"""WARP-3429 — generate the OTA channel pointer (`channel-<channel>.json`).

Called by .github/workflows/publish-release.yml AFTER the GitHub Release and
all its assets exist. The pointer is a tiny document saying "the newest
release for this channel is <tag>, and its release.json hashes to <sha256>".
The workflow cosign-signs it exactly as it signs release.json and uploads
both files to the rolling `ota-index` release, whose asset URLs never change,
so a box can find the newest release with one anonymous download instead of
listing releases through the (rate-limited, token-hungry) GitHub API.

The pointer is a hint plus an integrity pin, never the trust decision: the
box still verifies release.json's own signature and re-checks the channel
inside it. Pinning manifestSha256 only stops a pointer from being replayed
against a different manifest.

  --manifest  the dist/release.json that was uploaded to the release
  --channel   `stage` or `stable`; must equal the manifest's release.channel
  --tag       the release tag, `ota-<channel>-<run>-g<sha7>`; its channel and
              sha7 must agree with the manifest
  --out       where to write the pointer
  --published-at  UTC `YYYY-MM-DDTHH:MM:SSZ` (default: now). Tests only.

The bytes are deterministic: fixed key order, compact separators, UTF-8, one
trailing newline. builtAt is copied verbatim from the manifest and
manifestSha256 is taken over the exact bytes of --manifest (never a
re-serialisation), because both are what a verifier compares.

Fails LOUDLY (non-zero, nothing written) when the manifest, channel and tag
disagree: a pointer that is signed is a pointer that ships.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
KIND = "droplet-ota-channel-pointer"
TAG_RE = re.compile(r"^ota-([a-z]+)-[0-9]+-g([0-9a-f]{7})$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
TIMESTAMP_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")


def die(msg: str) -> None:
    print(f"gen-channel-pointer: ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def build_pointer(manifest_bytes: bytes, channel: str, tag: str, published_at: str) -> bytes:
    try:
        release = json.loads(manifest_bytes)["release"]
        git_sha, built_at, manifest_channel = release["gitSha"], release["builtAt"], release["channel"]
    except (ValueError, KeyError, TypeError) as e:
        die(f"manifest is not a release.json with release.gitSha/builtAt/channel: {e!r}")
    if not isinstance(built_at, str) or not built_at:
        die(f"manifest release.builtAt must be a non-empty string, got {built_at!r}")
    if not isinstance(git_sha, str) or not SHA_RE.fullmatch(git_sha):
        die(f"manifest release.gitSha must be a full 40-hex commit sha, got {git_sha!r}")
    if manifest_channel != channel:
        die(f"--channel {channel!r} but the manifest says release.channel {manifest_channel!r}")
    m = TAG_RE.match(tag)
    if not m:
        die(f"--tag must look like ota-<channel>-<run>-g<sha7>, got {tag!r}")
    if m.group(1) != channel:
        die(f"--tag {tag!r} names channel {m.group(1)!r}, not {channel!r}")
    if m.group(2) != git_sha[:7]:
        die(f"--tag {tag!r} names sha {m.group(2)}, the manifest was built from {git_sha[:7]}")
    if not TIMESTAMP_RE.match(published_at):
        die(f"--published-at must be YYYY-MM-DDTHH:MM:SSZ, got {published_at!r}")

    pointer = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": KIND,
        "channel": channel,
        "tag": tag,
        "gitSha": git_sha,
        "builtAt": built_at,
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "publishedAt": published_at,
    }
    return (json.dumps(pointer, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--channel", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--published-at",
                    default=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    args = ap.parse_args()

    if not args.manifest.is_file():
        die(f"manifest not found: {args.manifest}")
    data = build_pointer(args.manifest.read_bytes(), args.channel, args.tag, args.published_at)
    args.out.write_bytes(data)
    print(f"gen-channel-pointer: wrote {args.out} (channel={args.channel}, tag={args.tag})")


if __name__ == "__main__":
    main()
