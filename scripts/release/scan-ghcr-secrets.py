#!/usr/bin/env python3
"""WARP-3423 — secret-scan every published version of one first-party GHCR
package before (and after) it is public.

Making a GHCR package public exposes EVERY version it holds and cannot be
undone, so this walks all of them, not just the newest:

  * image manifests  -> the config blob (Env, history: build args land there)
                        and every layer, extracted and scanned one by one, so
                        a secret written in one layer and deleted in a later
                        one is still caught;
  * anything else    -> cosign signatures, attestations, indexes: the raw
                        manifest and its (small) blobs are scanned as text.

Findings are redacted (gitleaks --redact): the repo is public, so its CI logs
and artifacts are too. Vendor paths (node_modules, site-packages, /usr/...)
are reported separately — upstream test fixtures and docs are full of fake
keys — but never dropped.

Talks to the registry directly with the stdlib (no docker daemon), so the
same script works for any package the token can read.

usage: scan-ghcr-secrets.py --package droplet-orchestrator --gitleaks /tmp/gitleaks
                            --out findings.jsonl [--owner dropletbywarplab] [--org DropletByWarpLab]
env:   GITHUB_TOKEN (packages: read), GITHUB_ACTOR
exit:  0 always unless the scan itself could not run; triage is the summary's job.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

ACCEPT = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
    ]
)
IMAGE_CONFIG_TYPES = (
    "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.container.image.v1+json",
)
# Non-image blobs (signatures, attestations) bigger than this are not text.
RAW_BLOB_LIMIT = 50 * 1024 * 1024
VENDOR_MARKERS = (
    "/node_modules/",
    "/site-packages/",
    "/dist-packages/",
    "/usr/share/",
    "/usr/lib/",
    "/usr/local/lib/",
    "/usr/include/",
    "/opt/conda/",
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # GHCR answers blob GETs with a 307 to a pre-signed CDN URL; forwarding
    # the bearer token there is both pointless and rejected, so follow by hand.
    def redirect_request(self, *args, **kwargs):  # noqa: D401
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _get(url: str, headers: dict[str, str] | None = None, timeout: int = 600):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        return _opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
            return urllib.request.urlopen(e.headers["Location"], timeout=timeout)
        raise


def registry_token(owner: str, package: str) -> str:
    actor = os.environ.get("GITHUB_ACTOR", "x-access-token")
    basic = base64.b64encode(f"{actor}:{os.environ['GITHUB_TOKEN']}".encode()).decode()
    url = f"https://ghcr.io/token?scope=repository:{owner}/{package}:pull&service=ghcr.io"
    with _get(url, {"Authorization": f"Basic {basic}"}, timeout=60) as r:
        return json.load(r)["token"]


def list_versions(org: str, package: str) -> list[dict]:
    out = subprocess.run(
        [
            "gh", "api", "--paginate",
            f"/orgs/{org}/packages/container/{package}/versions?per_page=100",
            "--jq", ".[] | {digest: .name, tags: (.metadata.container.tags // [])}",
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def gitleaks(binary: str, target: str, report: str) -> list[dict]:
    subprocess.run(
        [
            binary, "dir", target,
            "--no-banner", "--redact", "--exit-code", "0",
            "--max-target-megabytes", "25",
            "--report-format", "json", "--report-path", report,
        ],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    with open(report) as f:
        return json.load(f) or []


def path_class(path: str) -> str:
    p = "/" + path.lstrip("/")
    return "vendor" if any(m in p for m in VENDOR_MARKERS) else "app"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--package", required=True)
    ap.add_argument("--owner", default="dropletbywarplab")
    ap.add_argument("--org", default="DropletByWarpLab")
    ap.add_argument("--gitleaks", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    repo = f"{args.owner}/{args.package}"
    versions = list_versions(args.org, args.package)
    print(f"{args.package}: {len(versions)} version(s)")

    seen_layers: set[str] = set()
    stats = {"versions": len(versions), "images": 0, "other": 0, "layers": 0,
             "layers_reused": 0, "findings": 0, "errors": 0}
    work = tempfile.mkdtemp(prefix="ghcr-scan-")
    out = open(args.out, "w")

    def emit(version: dict, where: str, findings: list[dict], base: str) -> None:
        for f in findings:
            rel = os.path.relpath(f.get("File", ""), base)
            rec = {
                "package": args.package,
                "version": version["digest"],
                "tags": version["tags"],
                "where": where,
                "file": rel,
                "class": path_class(rel) if where.startswith("layer") else where.split(":")[0],
                "rule": f.get("RuleID"),
                "line": f.get("StartLine"),
                "match": f.get("Match"),  # already redacted
            }
            out.write(json.dumps(rec) + "\n")
            stats["findings"] += 1

    def scan_text_blobs(version: dict, label: str, blobs: dict[str, bytes]) -> None:
        d = tempfile.mkdtemp(dir=work)
        for name, data in blobs.items():
            with open(os.path.join(d, name), "wb") as fh:
                fh.write(data)
        emit(version, label, gitleaks(args.gitleaks, d, d + ".json"), d)
        shutil.rmtree(d, ignore_errors=True)

    for v in versions:
        digest = v["digest"]
        try:
            # Registry bearer tokens are short-lived; a big package outlives one.
            auth = {"Authorization": f"Bearer {registry_token(args.owner, args.package)}"}
            with _get(f"https://ghcr.io/v2/{repo}/manifests/{digest}",
                      {**auth, "Accept": ACCEPT}, timeout=60) as r:
                raw = r.read()
            manifest = json.loads(raw)
            config_type = (manifest.get("config") or {}).get("mediaType", "")
            if config_type in IMAGE_CONFIG_TYPES:
                stats["images"] += 1
                with _get(f"https://ghcr.io/v2/{repo}/blobs/{manifest['config']['digest']}", auth) as r:
                    config = r.read()
                scan_text_blobs(v, "config:manifest+config", {"manifest.json": raw, "config.json": config})
                for layer in manifest.get("layers", []):
                    ld = layer["digest"]
                    if ld in seen_layers:
                        stats["layers_reused"] += 1
                        continue
                    seen_layers.add(ld)
                    stats["layers"] += 1
                    blob = os.path.join(work, "layer.tar")
                    with _get(f"https://ghcr.io/v2/{repo}/blobs/{ld}", auth) as r, open(blob, "wb") as fh:
                        shutil.copyfileobj(r, fh, 1024 * 1024)
                    root = tempfile.mkdtemp(dir=work)
                    # GNU tar sniffs gzip/zstd itself. Device nodes fail as
                    # non-root (exit 2) — irrelevant to a secret scan.
                    subprocess.run(
                        ["tar", "-xf", blob, "-C", root, "--no-same-owner",
                         "--no-same-permissions", "--exclude=dev/*"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
                    os.remove(blob)
                    emit(v, f"layer:{ld[:19]}", gitleaks(args.gitleaks, root, root + ".json"), root)
                    shutil.rmtree(root, ignore_errors=True)
            else:
                stats["other"] += 1
                blobs = {"manifest.json": raw}
                for i, layer in enumerate(manifest.get("layers", []) + manifest.get("blobs", [])):
                    if layer.get("size", 0) <= RAW_BLOB_LIMIT and "digest" in layer:
                        with _get(f"https://ghcr.io/v2/{repo}/blobs/{layer['digest']}", auth) as r:
                            blobs[f"blob-{i}.txt"] = r.read()
                scan_text_blobs(v, "other:" + (manifest.get("mediaType") or config_type or "unknown"), blobs)
        except Exception as e:  # one bad version must not hide the rest
            stats["errors"] += 1
            print(f"::warning::{args.package}@{digest[:19]}: {type(e).__name__}: {e}")

    out.close()
    shutil.rmtree(work, ignore_errors=True)
    print(json.dumps({"package": args.package, **stats}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
