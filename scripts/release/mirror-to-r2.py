#!/usr/bin/env python3
"""WARP-3502 — mirror the release images and their cosign signatures, BY DIGEST,
from private GHCR into the Cloudflare R2 bucket the fleet HQ registry serves.

The images stay private (Romain, 2026-10-03). A box pulls from the HQ Worker, a
read-only OCI registry in front of R2 (fleet contract v1, section 3), so CI is
the only writer of this layout:

  oci/blobs/sha256/<hex>                config + layer blobs
  oci/manifests/sha256/<hex>            image manifests / indexes, stored with
                                        Content-Type = the manifest media type
  oci/tags/<repo>/sha256-<hex>.sig      text `sha256:<manifest hex>`: the cosign
                                        signature of image digest <hex>

Called by .github/workflows/publish-release.yml. Subcommands:

  decide  read the environment and decide whether this publish mirrors:
          every R2 secret present -> enabled; none present and no
          OTA_REGISTRY_HOST -> skip with a loud warning (publishing keeps working
          before the bucket exists); OTA_REGISTRY_HOST set, only some secrets
          set, or a malformed host -> refuse (exit 1). Writes `enabled=true|false`
          to $GITHUB_OUTPUT.
  check   fail fast, before the ~2 h build: list the bucket and write a probe
          object, so a wrong or read-only key fails in seconds.
  copy    for each image in --digests, copy its manifest tree and its
          `sha256-<hex>.sig` tag, then re-list the bucket and prove every object
          the release needs is there.

Environment: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
(secrets) and OTA_REGISTRY_HOST (repo variable). Tools: `crane` reads GHCR with
the docker login the workflow already did; `aws s3` talks to R2's S3 endpoint.

Properties the release relies on:
  * Fail closed. Any error exits non-zero and the publish job stops before the
    GitHub Release exists, so no release.json can name a digest R2 lacks.
  * Nothing in R2 ever points at missing content: blobs go up first, then
    manifests (children before parents), then tags. A blob is only uploaded
    after its bytes were re-hashed against the digest it is stored under.
  * Content-addressed and idempotent: an object already in the bucket with the
    expected size is skipped, never re-uploaded.
  * Equal multipart parts: R2 rejects uneven parts, so the aws config pins one
    explicit chunk size (equal to the threshold).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json"
DOCKER_LIST = "application/vnd.docker.distribution.manifest.list.v2+json"
MANIFEST_TYPES = {OCI_MANIFEST, DOCKER_MANIFEST}
INDEX_TYPES = {OCI_INDEX, DOCKER_LIST}

R2_VARS = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
DIGEST_RE = re.compile(r"sha256:([0-9a-f]{64})")
# Same pattern as HOST_RE in gen-release-manifest.py (a test pins them equal):
# a malformed OTA_REGISTRY_HOST must fail here, before the build, not at the
# manifest step after it.
HOST_RE = re.compile(r"[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?")
ACCOUNT_RE = re.compile(r"[0-9a-f]{32}")
BUCKET_RE = re.compile(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]")

# One size for threshold and chunks: every part of a multipart upload is equal
# (the last may be shorter), which R2 requires. Same as
# `aws configure set default.s3.multipart_chunksize 64MB`.
PART_SIZE = "64MB"
AWS_CONFIG = (
    "[default]\n"
    "region = auto\n"
    "s3 =\n"
    f"    multipart_threshold = {PART_SIZE}\n"
    f"    multipart_chunksize = {PART_SIZE}\n"
)


class Fail(Exception):
    """Any condition that must stop the publish."""


# ── decide ──────────────────────────────────────────────────────────────────

def decide(env):
    """Return (enabled, message); raise Fail for a config that must not publish."""
    missing = [k for k in R2_VARS if not env.get(k)]
    present = [k for k in R2_VARS if env.get(k)]
    host = env.get("OTA_REGISTRY_HOST", "")
    if host and not HOST_RE.fullmatch(host):
        raise Fail(f"OTA_REGISTRY_HOST must be a lowercase host[:port] with no scheme or "
                   f"path (for example droplet-fleet-hq.rjouffret.workers.dev), got {host!r}")
    if not missing:
        if not ACCOUNT_RE.fullmatch(env["R2_ACCOUNT_ID"]):
            raise Fail("R2_ACCOUNT_ID must be the 32-hex Cloudflare account id "
                       "(no spaces or newline)")
        if not BUCKET_RE.fullmatch(env["R2_BUCKET"]):
            raise Fail("R2_BUCKET must be an R2 bucket name (3-63 chars: lowercase "
                       "letters, digits, hyphens)")
        return True, "R2 mirror enabled"
    if host:
        raise Fail(f"OTA_REGISTRY_HOST is set ({host}), so release.json would point "
                   f"boxes at it, but these R2 secrets are missing: {', '.join(missing)}. "
                   "Set them, or unset OTA_REGISTRY_HOST to keep pulling from ghcr.io.")
    if present:
        raise Fail(f"R2 secrets are only partly configured (set: {', '.join(present)}; "
                   f"missing: {', '.join(missing)}). Set all four or none.")
    return False, ("R2 mirror SKIPPED: no R2 secrets and OTA_REGISTRY_HOST is unset, so "
                   "images are NOT copied to R2 and release.json keeps pointing at ghcr.io. "
                   "Create the bucket and set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, "
                   "R2_SECRET_ACCESS_KEY, R2_BUCKET, then OTA_REGISTRY_HOST.")


# ── subprocess plumbing ─────────────────────────────────────────────────────

def run(cmd, env=None, stdout=subprocess.PIPE):
    try:
        return subprocess.run(cmd, env=env, stdout=stdout, stderr=subprocess.PIPE, check=True)
    except FileNotFoundError:
        raise Fail(f"{cmd[0]} is not installed") from None
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b"").decode(errors="replace").strip()[-500:].replace("\n", " ")
        raise Fail(f"`{' '.join(cmd[:3])}` failed (exit {e.returncode}): {err}") from None


def crane_manifest(ref):
    """Raw manifest bytes for `repo@digest` or `repo:tag`."""
    return run(["crane", "manifest", ref]).stdout


def crane_blob(ref, dest):
    with open(dest, "wb") as fh:
        run(["crane", "blob", ref], stdout=fh)


def aws_env(env, scratch):
    """Environment for the aws CLI: R2 keys mapped to AWS_*, the equal-part
    multipart config in a scratch file (never ~/.aws), and the two knobs that
    stop AWS CLI >= 2.23 sending trailing CRC32 checksums R2 can reject."""
    scratch.mkdir(parents=True, exist_ok=True)
    cfg = scratch / "aws-config"
    cfg.write_text(AWS_CONFIG, encoding="utf-8")
    out = {k: v for k, v in os.environ.items()
           if k not in ("AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_ENDPOINT_URL")}
    out.update(
        AWS_CONFIG_FILE=str(cfg),
        AWS_ACCESS_KEY_ID=env["R2_ACCESS_KEY_ID"],
        AWS_SECRET_ACCESS_KEY=env["R2_SECRET_ACCESS_KEY"],
        AWS_DEFAULT_REGION="auto",
        AWS_REQUEST_CHECKSUM_CALCULATION="when_required",
        AWS_RESPONSE_CHECKSUM_VALIDATION="when_required",
    )
    return out


def parse_listing(text):
    """`list-objects-v2 --query 'Contents[].[Key,Size]'` -> {key: size}. Tolerates
    an empty bucket (`null`) and several JSON documents back to back (one per
    page), so a paginated listing is never silently truncated to its first page."""
    dec, i, listing = json.JSONDecoder(), 0, {}
    text = text.strip()
    while i < len(text):
        rows, i = dec.raw_decode(text, i)
        for key, size in rows or []:
            listing[key] = size
        while i < len(text) and text[i].isspace():
            i += 1
    return listing


class R2:
    def __init__(self, env, scratch):
        self.bucket = env["R2_BUCKET"]
        self.endpoint = f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
        self.env = aws_env(env, scratch)

    def _aws(self, *args):
        return run(["aws", "--endpoint-url", self.endpoint, *args], env=self.env)

    def list(self):
        out = self._aws("s3api", "list-objects-v2", "--bucket", self.bucket,
                        "--prefix", "oci/", "--query", "Contents[].[Key,Size]",
                        "--output", "json").stdout.decode()
        return parse_listing(out)

    def put(self, key, path, content_type):
        self._aws("s3", "cp", str(path), f"s3://{self.bucket}/{key}",
                  "--content-type", content_type, "--only-show-errors")


# ── manifest tree ───────────────────────────────────────────────────────────

def hex_of(digest):
    m = DIGEST_RE.fullmatch(digest) if isinstance(digest, str) else None
    if not m:
        raise Fail(f"malformed digest {digest!r} (want sha256:<64 hex>)")
    return m.group(1)


def walk(fetch_manifest, base, digest, manifests, blobs, hint=None):
    """Collect everything `base@digest` needs. manifests: {hex: (raw, media
    type)}, children before their index; blobs: {hex: (size, base)}."""
    hexd = hex_of(digest)
    if hexd in manifests:
        return
    raw = fetch_manifest(f"{base}@{digest}")
    if hashlib.sha256(raw).hexdigest() != hexd:
        raise Fail(f"{base}@{digest}: manifest bytes do not hash to the digest")
    try:
        doc = json.loads(raw)
        media = doc.get("mediaType") or hint or (OCI_INDEX if "manifests" in doc else OCI_MANIFEST)
        if media in INDEX_TYPES:
            for child in doc["manifests"]:
                walk(fetch_manifest, base, child["digest"], manifests, blobs, child.get("mediaType"))
        elif media in MANIFEST_TYPES:
            for desc in [doc["config"], *doc["layers"]]:
                blobs.setdefault(hex_of(desc["digest"]), (int(desc["size"]), base))
        else:
            raise Fail(f"{base}@{digest}: unsupported manifest media type {media!r}")
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        raise Fail(f"{base}@{digest}: malformed manifest ({type(e).__name__}: {e})") from None
    manifests[hexd] = (raw, media)


def check_file(path, hexd, size):
    h, n = hashlib.sha256(), 0
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
            n += len(chunk)
    if n != size or h.hexdigest() != hexd:
        raise Fail(f"blob sha256:{hexd} downloaded as {n} bytes / sha256:{h.hexdigest()}, "
                   f"want {size} bytes; refusing to store it under that digest")


# ── copy ────────────────────────────────────────────────────────────────────

def mirror(registry, digests, scratch, fetch_manifest, fetch_blob, s3):
    """Copy every image in `digests` ({name: sha256:...}) from `registry`
    (ghcr.io/<owner>) into R2. Returns stats; raises Fail on any problem."""
    started = time.time()
    scratch.mkdir(parents=True, exist_ok=True)
    existing = s3.list()

    manifests, blobs, tags = {}, {}, {}
    for name, digest in digests.items():
        repo = f"droplet-{name}"
        base = f"{registry}/{repo}"
        walk(fetch_manifest, base, digest, manifests, blobs)
        # cosign (keyless, WARP-244) stored the signature at this tag next to the
        # image. Boxes verify it before every pull, so an image without one must
        # not ship: it would be a pull that can never verify.
        sig_tag = f"sha256-{hex_of(digest)}.sig"
        try:
            sig_raw = fetch_manifest(f"{base}:{sig_tag}")
        except Fail as e:
            raise Fail(f"{repo}: no cosign signature tag {sig_tag} in GHCR ({e})") from None
        sig_digest = "sha256:" + hashlib.sha256(sig_raw).hexdigest()
        walk(fetch_manifest, base, sig_digest, manifests, blobs)
        tags[f"oci/tags/{repo}/{sig_tag}"] = sig_digest.encode()

    required = {}
    up = skipped = bytes_up = 0
    for hexd, (size, base) in blobs.items():
        key = f"oci/blobs/sha256/{hexd}"
        required[key] = size
        if existing.get(key) == size:
            skipped += 1
            continue
        tmp = scratch / f"blob-{hexd}"
        try:
            fetch_blob(f"{base}@sha256:{hexd}", tmp)
            check_file(tmp, hexd, size)
            s3.put(key, tmp, "application/octet-stream")
        finally:
            tmp.unlink(missing_ok=True)
        up += 1
        bytes_up += size

    def put_bytes(key, body, content_type):
        tmp = scratch / "upload.tmp"
        try:
            tmp.write_bytes(body)
            s3.put(key, tmp, content_type)
        finally:
            tmp.unlink(missing_ok=True)

    for hexd, (raw, media) in manifests.items():
        key = f"oci/manifests/sha256/{hexd}"
        required[key] = len(raw)
        if existing.get(key) != len(raw):
            put_bytes(key, raw, media)
    # Tags are mutable pointers, always rewritten, and written last.
    for key, body in tags.items():
        required[key] = len(body)
        put_bytes(key, body, "text/plain")

    final = s3.list()
    bad = sorted(k for k, size in required.items() if final.get(k) != size)
    if bad:
        raise Fail(f"{len(bad)} object(s) missing or wrong size in R2 after the copy, "
                   f"e.g. {', '.join(bad[:3])}")
    return {"images": len(digests), "blobs": len(blobs), "blobs_uploaded": up,
            "blobs_skipped": skipped, "bytes_uploaded": bytes_up,
            "manifests": len(manifests), "tags": len(tags),
            "seconds": round(time.time() - started)}


# ── CLI ─────────────────────────────────────────────────────────────────────

def emit(path_var, line):
    path = os.environ.get(path_var)
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("decide")
    chk = sub.add_parser("check")
    chk.add_argument("--scratch", required=True, type=Path)
    cp = sub.add_parser("copy")
    cp.add_argument("--digests", required=True, type=Path)
    cp.add_argument("--registry", required=True)
    cp.add_argument("--scratch", required=True, type=Path)
    args = ap.parse_args(argv)

    try:
        if args.cmd == "decide":
            enabled, msg = decide(os.environ)
            emit("GITHUB_OUTPUT", f"enabled={'true' if enabled else 'false'}")
            if enabled:
                print(msg)
            else:
                print(f"::warning title=R2 mirror skipped::{msg}")
                emit("GITHUB_STEP_SUMMARY", f"**WARNING: {msg}**")
        elif args.cmd == "check":
            r2 = R2(os.environ, args.scratch)
            n = len(r2.list())
            probe = args.scratch / "probe"
            probe.write_text("ok\n", encoding="utf-8")
            r2.put("oci/.write-check", probe, "text/plain")
            print(f"R2 bucket reachable and writable ({n} existing oci/ objects)")
        else:
            digests = json.loads(args.digests.read_text(encoding="utf-8"))
            s = mirror(args.registry, digests, args.scratch, crane_manifest, crane_blob,
                       R2(os.environ, args.scratch))
            line = (f"R2 mirror: {s['images']} images, {s['blobs']} blobs "
                    f"({s['blobs_uploaded']} uploaded, {s['bytes_uploaded'] / 2**20:.0f} MiB; "
                    f"{s['blobs_skipped']} already present), {s['manifests']} manifests, "
                    f"{s['tags']} signature tags, {s['seconds']} s")
            print(line)
            emit("GITHUB_STEP_SUMMARY", line)
    except Fail as e:
        print(f"::error title=R2 mirror::{e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
