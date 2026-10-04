#!/usr/bin/env python3
"""WARP-3423 / WARP-3429 — secret-scan Droplet container images, layer by layer.

Two sources, one scanner:

  registry mode (default, WARP-3423)
      every published version of one first-party GHCR package, before (and
      after) it is public. Making a GHCR package public exposes EVERY version
      it holds and cannot be undone, so this walks all of them, not just the
      newest.

  local mode (--docker-save <tar>, WARP-3429)
      one freshly built image, from `docker save`, BEFORE it is pushed. A real
      secret must never reach the registry in the first place; publish-release
      runs this between `docker build` and `docker push` and refuses to push
      on a finding.

What gets scanned, in both modes:

  * image config     -> Env and history (build args land there), plus the
                        manifest;
  * every layer      -> extracted and scanned one by one, so a secret written
                        in one layer and deleted in a later one is still
                        caught;
  * (registry only) anything else -> cosign signatures, attestations, indexes:
                        the raw manifest and its (small) blobs, as text.

Findings are redacted (gitleaks --redact): the repo is public, so its CI logs
and artifacts are too. Vendor paths (node_modules, site-packages, /usr/...)
are reported separately — upstream test fixtures and docs are full of fake
keys — but never dropped.

gitleaks runs with scripts/release/gitleaks-images.toml (--config): the default
rules plus ONE tight allowlist for the official python base images' public
GPG_KEY fingerprint. Never the config of whatever is inside the image.

Gating (WARP-3429): --fail-on-app exits 1 when any NON-vendor finding is not in
--baseline, a reviewed list of accepted fingerprints, one `<rule> <path>` per
line (`#` comments). A fingerprint is the gitleaks rule plus the path inside
the image: no line number and no digest, so it survives a rebuild. The image
config is split into one pseudo-file per key before scanning (add_config_blobs),
so its fingerprints name the key — `config.json#Env.GPG_KEY`,
`config.json#Labels.<label>`, `config.json#history.<hash of the instruction>`
— and a baseline line can never excuse a rule across a whole config. See
scripts/release/image-secret-baseline.txt.

Registry mode talks to the registry directly with the stdlib (no docker
daemon), so the same script works for any package the token can read. A big
package can be split: --shard K/N scans versions[K::N] (0 <= K < N), and
--digests <prefix,prefix> rescans only the versions whose digest starts with
one of the prefixes (applied before --shard).

usage: scan-ghcr-secrets.py --package droplet-orchestrator --gitleaks /tmp/gitleaks
                            --out findings.jsonl [--owner dropletbywarplab] [--org DropletByWarpLab]
                            [--shard 0/8] [--digests sha256:ab12,sha256:cd34]
       scan-ghcr-secrets.py --package droplet-orchestrator --gitleaks /tmp/gitleaks
                            --docker-save image.tar --baseline image-secret-baseline.txt --fail-on-app
env:   registry mode: GITHUB_TOKEN (packages: read), GITHUB_ACTOR
exit:  0 unless the scan itself could not run (2, local mode) or --fail-on-app
       found something outside the baseline (1). Registry mode downgrades a
       per-version error to a warning so one bad version cannot hide the rest;
       local mode never does — a pre-push scan that could not run must not pass.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
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
# The ruleset every image scan runs with (see the file's own header). Passed
# explicitly so gitleaks never falls back to a config found inside the scanned
# tree; a missing file makes gitleaks fail, and so the scan, never run default.
GITLEAKS_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gitleaks-images.toml")
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


def parse_shard(text: str) -> tuple[int, int]:
    m = re.fullmatch(r"([0-9]+)/([0-9]+)", text)
    if not m or not int(m[1]) < int(m[2]):
        raise argparse.ArgumentTypeError(f"want K/N with 0 <= K < N, got {text!r}")
    return int(m[1]), int(m[2])


def parse_digests(text: str) -> list[str]:
    prefixes = [p.strip() for p in text.split(",") if p.strip()]
    if not prefixes or not all(re.fullmatch(r"[A-Za-z0-9:]+", p) for p in prefixes):
        raise argparse.ArgumentTypeError(f"want comma-separated digest prefixes (sha256:ab12), got {text!r}")
    return prefixes


def select_versions(versions: list[dict], shard: tuple[int, int], digests: list[str]) -> list[dict]:
    """--digests first (a prefix may omit `sha256:`), then --shard K/N -> versions[K::N]."""
    if digests:
        hit = {p: [v for v in versions if v["digest"].startswith(p) or v["digest"].split(":")[-1].startswith(p)]
               for p in digests}
        missing = [p for p, vs in hit.items() if not vs]
        if missing:  # a typo'd prefix must not turn into a scan of nothing that passes
            raise SystemExit(f"--digests: no version matches {', '.join(missing)}")
        versions = [v for v in versions if any(v in vs for vs in hit.values())]
    k, n = shard
    return versions[k::n]


def gitleaks(binary: str, target: str, report: str) -> list[dict]:
    subprocess.run(
        [
            binary, "dir", target, "--config", GITLEAKS_CONFIG,
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


# ── shared scanning: both modes funnel through these three ───────────────────


def relativize(findings: list[dict], base: str) -> list[dict]:
    """Rewrite each finding's File to be relative to the scanned root."""
    for f in findings:
        f["File"] = os.path.relpath(f.get("File", ""), base)
    return findings


def scan_text_blobs(binary: str, work: str, blobs: dict[str, bytes]) -> list[dict]:
    d = tempfile.mkdtemp(dir=work)
    for name, data in blobs.items():
        with open(os.path.join(d, name), "wb") as fh:
            fh.write(data)
    findings = relativize(gitleaks(binary, d, d + ".json"), d)
    shutil.rmtree(d, ignore_errors=True)
    return findings


def _slug(name: str) -> str:
    # Becomes part of a file name: nothing that could be a path separator or
    # `..`, and short enough for the filesystem (a clash just concatenates).
    return re.sub(r"[^A-Za-z0-9_-]", "_", name)[:100] or "_"


def add_config_blobs(blobs: dict[str, bytes], raw: bytes) -> None:
    """Add an image config to `blobs`, split into one pseudo-file per key.

    Scanned as one file every finding would be at `config.json`, so a baseline
    line for it would excuse that rule across the WHOLE config — Env, labels
    and build history — of every image, today and in every future build.
    Split instead, a finding's path names its key (gitleaks reports the file):

      config.json#Env.<NAME>          one per Env entry (config and container_config)
      config.json#Labels.<label>      one per label
      config.json#history.<hash12>    one per history entry, hashed on its
                                      instruction text, so it survives a rebuild
                                      but not a changed instruction (where build
                                      args land)
      config.json#<section>.<key>     every other key (config.Cmd, rootfs.diff_ids, ...)

    Entries that share a path are concatenated, never dropped. A config that is
    not JSON is scanned whole, as `config.json`.
    """
    def put(name: str, text: str) -> None:
        blobs[name] = blobs.get(name, b"") + text.encode() + b"\n"

    try:
        cfg = json.loads(raw)
        sections = list(cfg.items())
    except (ValueError, AttributeError):
        blobs["config.json"] = blobs.get("config.json", b"") + raw
        return
    for key, val in sections:
        if key == "history" and isinstance(val, list):
            for h in val:
                text = ("\n".join(str(h[f]) for f in ("created_by", "comment") if h.get(f))
                        if isinstance(h, dict) else str(h))
                put(f"config.json#history.{hashlib.sha256(text.encode()).hexdigest()[:12]}", text)
        elif isinstance(val, dict):
            for sub, v in val.items():
                if sub == "Env" and isinstance(v, list):
                    for entry in map(str, v):
                        put(f"config.json#Env.{_slug(entry.partition('=')[0])}", entry)
                elif sub == "Labels" and isinstance(v, dict):
                    for label, value in v.items():
                        put(f"config.json#Labels.{_slug(str(label))}", f"{label}={value}")
                else:
                    put(f"config.json#{_slug(key)}.{_slug(sub)}", json.dumps(v))
        else:
            put(f"config.json#{_slug(key)}", json.dumps(val))


def scan_layer(binary: str, work: str, blob: str) -> list[dict]:
    """Extract one layer tarball, scan its filesystem, and delete both.

    The tarball is consumed so only one layer is ever on disk at a time.
    """
    root = tempfile.mkdtemp(dir=work)
    # List before extracting. The extraction's exit status cannot be checked
    # (below), so a layer tar cannot read — corrupt, or a compression this tar
    # lacks — would extract to nothing and scan "clean". Failing the listing
    # makes that an error instead of a pass.
    subprocess.run(["tar", "-tf", blob], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # GNU tar sniffs gzip/zstd itself. Device nodes fail as non-root
    # (exit 2) — irrelevant to a secret scan.
    subprocess.run(
        ["tar", "-xf", blob, "-C", root, "--no-same-owner",
         "--no-same-permissions", "--exclude=dev/*"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    os.remove(blob)
    findings = relativize(gitleaks(binary, root, root + ".json"), root)
    shutil.rmtree(root, ignore_errors=True)
    return findings


def make_record(package: str, version: dict, where: str, f: dict) -> dict:
    rel = f["File"]
    return {
        "package": package,
        "version": version["digest"],
        "tags": version["tags"],
        "where": where,
        "file": rel,
        "class": path_class(rel) if where.startswith("layer") else where.split(":")[0],
        "rule": f.get("RuleID"),
        "line": f.get("StartLine"),
        "match": f.get("Match"),  # already redacted
    }


# ── baseline gate (WARP-3429) ─────────────────────────────────────────────────


def load_baseline(path: str) -> set[tuple[str, str]]:
    """`<rule> <path>` per line; blank lines and `#` comments are skipped."""
    accepted = set()
    with open(path, encoding="utf-8") as fh:
        for n, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(None, 1)
            if len(parts) != 2:
                raise SystemExit(f"{path}:{n}: want '<rule> <path>', got {raw.rstrip()!r}")
            accepted.add((parts[0], parts[1].lstrip("/")))
    return accepted


def is_new_app_finding(rec: dict, baseline: set[tuple[str, str]]) -> bool:
    return rec["class"] != "vendor" and (rec["rule"], rec["file"]) not in baseline


def report_new_app(package: str, rows: list[dict]) -> None:
    # The match is deliberately left out: the rule and location are enough to
    # triage, and this goes to a public log.
    seen: dict[tuple[str, str], dict] = {}
    for r in rows:
        seen.setdefault((r["rule"], r["file"]), r)
    keys = sorted(seen, key=str)
    for rule, file in keys:
        r = seen[(rule, file)]
        print(f"::error::{package}: {r['where']} {file}:{r['line']} {rule} is not in the reviewed baseline")
    print(f"{package}: {len(keys)} non-vendor finding(s) outside the baseline. A real secret: "
          "rotate it and fix the image. A reviewed false positive: add these lines to the "
          "baseline file in the PR:")
    for rule, file in keys:
        print(f"{rule} {file}")


# ── local mode: `docker save` archive ─────────────────────────────────────────


def layer_label(path: str) -> str:
    # `<id>/layer.tar` (legacy docker save) or `blobs/sha256/<hex>` (OCI layout).
    parts = path.split("/")
    ident = parts[0] if parts[-1] == "layer.tar" else parts[-1]
    return f"layer:{ident[:12]}"


def _open_member(tf: tarfile.TarFile, name: str):
    f = tf.extractfile(name)  # KeyError when absent
    if f is None:
        raise ValueError(f"{name}: not a regular file in the docker save archive")
    return f


def _read_member(tf: tarfile.TarFile, name: str) -> bytes:
    with _open_member(tf, name) as f:
        return f.read()


def scan_docker_save(binary: str, work: str, archive: str):
    """Yield (where, findings) for a `docker save` archive: config, then layers.

    manifest.json lists, per image, its config and its layers — either the
    legacy `<id>/layer.tar` paths or OCI `blobs/sha256/<hex>` (layers may then
    be compressed; tar sniffs that). Layers are streamed out of the archive one
    at a time rather than unpacking the whole archive, which would double the
    disk a multi-GB image needs.
    """
    with tarfile.open(archive, "r:") as tf:
        raw = _read_member(tf, "manifest.json")
        images = json.loads(raw)
        if not images:
            raise ValueError("manifest.json lists no images")
        blobs = {"manifest.json": raw}
        for img in images:
            add_config_blobs(blobs, _read_member(tf, img["Config"]))
        yield "config:manifest+config", scan_text_blobs(binary, work, blobs)
        seen: set[str] = set()
        for img in images:
            for layer in img["Layers"]:
                if layer in seen:
                    continue
                seen.add(layer)
                blob = os.path.join(work, "layer.tar")
                with _open_member(tf, layer) as src, open(blob, "wb") as fh:
                    shutil.copyfileobj(src, fh, 1 << 20)
                yield layer_label(layer), scan_layer(binary, work, blob)


def scan_local(args, work: str, stats: dict, emit) -> None:
    version = {"digest": "docker-save", "tags": [os.path.basename(args.docker_save)]}
    stats.update(versions=1, images=1)
    for where, findings in scan_docker_save(args.gitleaks, work, args.docker_save):
        if where.startswith("layer"):
            stats["layers"] += 1
        emit(version, where, findings)


# ── registry mode: every version of a GHCR package ────────────────────────────


def scan_registry(args, work: str, stats: dict, emit) -> None:
    repo = f"{args.owner}/{args.package}"
    all_versions = list_versions(args.org, args.package)
    versions = select_versions(all_versions, args.shard, args.digests)
    print(f"{args.package}: {len(versions)} of {len(all_versions)} version(s)"
          f" (shard {args.shard[0]}/{args.shard[1]})")
    stats["versions"] = len(versions)
    seen_layers: set[str] = set()

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
                blobs = {"manifest.json": raw}
                add_config_blobs(blobs, config)
                emit(v, "config:manifest+config", scan_text_blobs(args.gitleaks, work, blobs))
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
                    emit(v, f"layer:{ld[:19]}", scan_layer(args.gitleaks, work, blob))
            else:
                stats["other"] += 1
                blobs = {"manifest.json": raw}
                for i, layer in enumerate(manifest.get("layers", []) + manifest.get("blobs", [])):
                    if layer.get("size", 0) <= RAW_BLOB_LIMIT and "digest" in layer:
                        with _get(f"https://ghcr.io/v2/{repo}/blobs/{layer['digest']}", auth) as r:
                            blobs[f"blob-{i}.txt"] = r.read()
                emit(v, "other:" + (manifest.get("mediaType") or config_type or "unknown"),
                     scan_text_blobs(args.gitleaks, work, blobs))
        except Exception as e:  # one bad version must not hide the rest
            stats["errors"] += 1
            print(f"::warning::{args.package}@{digest[:19]}: {type(e).__name__}: {e}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--package", required=True)
    ap.add_argument("--owner", default="dropletbywarplab")
    ap.add_argument("--org", default="DropletByWarpLab")
    ap.add_argument("--gitleaks", required=True)
    ap.add_argument("--out", help="write every finding (redacted) here as JSONL")
    ap.add_argument("--docker-save", metavar="TAR",
                    help="scan this `docker save` archive instead of the registry")
    ap.add_argument("--shard", type=parse_shard, default=(0, 1), metavar="K/N",
                    help="registry mode: scan only versions[K::N] (0 <= K < N)")
    ap.add_argument("--digests", type=parse_digests, default=[], metavar="PREFIXES",
                    help="registry mode: rescan only the versions whose digest starts with one of these")
    ap.add_argument("--baseline", help="reviewed accepted fingerprints, `<rule> <path>` per line")
    ap.add_argument("--fail-on-app", action="store_true",
                    help="exit 1 on any non-vendor finding that is not in --baseline")
    args = ap.parse_args()
    if args.docker_save and (args.shard != (0, 1) or args.digests):
        ap.error("--shard and --digests select registry versions; they do not apply to --docker-save")

    baseline = load_baseline(args.baseline) if args.baseline else set()
    stats = {"versions": 0, "images": 0, "other": 0, "layers": 0,
             "layers_reused": 0, "findings": 0, "errors": 0}
    new_app: list[dict] = []
    work = tempfile.mkdtemp(prefix="ghcr-scan-")
    out = open(args.out, "w") if args.out else None

    def emit(version: dict, where: str, findings: list[dict]) -> None:
        for f in findings:
            rec = make_record(args.package, version, where, f)
            if out:
                out.write(json.dumps(rec) + "\n")
            stats["findings"] += 1
            if args.fail_on_app and is_new_app_finding(rec, baseline):
                new_app.append(rec)

    try:
        if args.docker_save:
            try:
                scan_local(args, work, stats, emit)
            except Exception as e:  # fail closed: an image we could not scan must not be pushed
                print(f"::error::{args.package}: could not scan {args.docker_save}: {type(e).__name__}: {e}")
                return 2
        else:
            scan_registry(args, work, stats, emit)
    finally:
        if out:
            out.close()
        shutil.rmtree(work, ignore_errors=True)

    print(json.dumps({"package": args.package, **stats}))
    if new_app:
        report_new_app(args.package, new_app)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
