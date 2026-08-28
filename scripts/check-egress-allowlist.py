#!/usr/bin/env python3
"""WARP-269 — telemetry-free invariant: static egress-destination gate.

Extracts every outbound network destination referenced by tracked files and
fails (exit 1) if any host is not registered in
docs/security/allowed-egress.yaml. See that file's header for the schema and
docs/SECURITY.md#egress for the policy.

Extraction rules (v1, deliberately conservative):
  * scheme URLs  — (https|http|wss|ws|ftp)://<host>  anywhere in scoped
    files, including comments (a commented-out endpoint is one uncomment
    away from egress; allowlisting it as kind: reference is cheap).
  * bare hosts   — dotted hostnames in CONFIG files only
    (docker/docker-compose.yml, openwrt/files/etc/config/*, .env.example):
    code files are exempt from bare-host matching to avoid prose noise.
  * public IPv4  — any non-private IP literal in scoped files.

Scope: git-tracked files under apps/ services/ packages/ docker/ scripts/
openwrt/ proto/ schemas/ plus root .env.example — minus tests, fixtures,
mocks, docs, markdown. Tests never ship; their fixture hosts (evil.example
etc.) are out of scope by construction.

Filtered as internal (never egress): localhost, host.docker.internal,
RFC-2606 reserved TLDs (.test/.example/.invalid/.localhost), .local, .lan,
.internal, .home.arpa, example.com/net/org, private/loopback IPs.

Usage:
  python3 scripts/check-egress-allowlist.py [--repo-root DIR] [--list-hosts]
Exit codes: 0 clean, 1 violation(s), 2 usage/config error.
"""
from __future__ import annotations

import argparse
import ipaddress
import os
import re
import subprocess
import sys
from collections import defaultdict
from fnmatch import fnmatch

try:
    import yaml
except ImportError:  # pragma: no cover
    print("ERROR: pyyaml required (pip install pyyaml==6.0.2)", file=sys.stderr)
    sys.exit(2)

ALLOWLIST_PATH = "docs/security/allowed-egress.yaml"

SCOPE_PREFIXES = ("apps/", "services/", "packages/", "docker/", "scripts/",
                  "openwrt/", "proto/", "schemas/")
EXTRA_FILES = (".env.example",)

EXCLUDE_RE = re.compile(
    r"(^|/)(tests?|__tests__|__fixtures__|__mocks__|testing|fixtures)(/|$)"
    r"|\.test\.|\.spec\.|_test\.|(^|/)conftest\.py$"
)
TEXT_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".sh", ".yml",
                 ".yaml", ".json", ".env", ".example", ".conf", ".cnf",
                 ".toml", ".prisma", ".proto", ".sql", ".service")

URL_RE = re.compile(r"(?:https?|wss?|ftp)://([A-Za-z0-9._-]+\.[A-Za-z]{2,})")
BARE_HOST_RE = re.compile(r"\b([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b")
BARE_HOST_TLDS = (".com", ".org", ".net", ".io", ".ai", ".co", ".dev",
                  ".goog", ".cloud", ".us", ".uk", ".de", ".fr")
IPV4_RE = re.compile(r"\b((?:\d{1,3}\.){3}\d{1,3})\b")

INTERNAL_HOST_RE = re.compile(
    r"(\.(test|example|invalid|localhost|local|lan|internal)$)"
    r"|(\.home\.arpa$)"
    r"|(^(localhost|host\.docker\.internal)$)"
    r"|(^example\.(com|net|org)$)"
)

CONFIG_FILES_FOR_BARE_HOSTS = re.compile(
    r"(^docker/docker-compose\.yml$)|(^openwrt/files/etc/config/)|(^\.env\.example$)"
)

# WARP-2217 — provider descriptors declare their destinations as BARE HOSTS in
# an `egressHosts: [...]` array. Code files are otherwise exempt from bare-host
# matching (prose noise), so without this the whole declaration would be
# invisible to the gate and a descriptor could name an unregistered vendor host
# with nothing going red.
#
# Collected as a small state machine rather than a single-line regex on purpose:
# the array is prettier-formatted and wraps once it has more than two entries,
# and a one-line pattern would silently stop matching the day a third host is
# added — the exact failure mode this gate exists to prevent.
EGRESS_HOSTS_OPEN_RE = re.compile(r"\begressHosts\b\s*:\s*\[")
QUOTED_RE = re.compile(r"[\"']([^\"']+)[\"']")


def tracked_files(root: str) -> list[str]:
    out = subprocess.run(["git", "-C", root, "ls-files"],
                         capture_output=True, text=True, check=True)
    return out.stdout.splitlines()


def in_scope(path: str) -> bool:
    if path in EXTRA_FILES:
        return True
    if not path.startswith(SCOPE_PREFIXES):
        return False
    if EXCLUDE_RE.search(path):
        return False
    base = os.path.basename(path)
    return (path.endswith(TEXT_SUFFIXES) or "Dockerfile" in base
            or base.startswith(".env") or "/etc/config/" in path)


def is_internal_host(host: str) -> bool:
    return bool(INTERNAL_HOST_RE.search(host))


def is_public_ip(token: str) -> bool:
    try:
        ip = ipaddress.ip_address(token)
    except ValueError:
        return False
    return not (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_unspecified or ip.is_reserved)


def extract(root: str, files: list[str]) -> dict[str, set[tuple[str, int]]]:
    found: dict[str, set[tuple[str, int]]] = defaultdict(set)
    for path in files:
        if not in_scope(path):
            continue
        try:
            with open(os.path.join(root, path), encoding="utf-8",
                      errors="ignore") as fh:
                lines = fh.readlines()
        except OSError:
            continue
        bare_ok = bool(CONFIG_FILES_FOR_BARE_HOSTS.search(path))
        # Open when we are inside an `egressHosts: [` array (WARP-2217).
        in_egress_hosts = False
        for lineno, line in enumerate(lines, 1):
            if in_egress_hosts or EGRESS_HOSTS_OPEN_RE.search(line):
                tail = line
                if not in_egress_hosts:
                    tail = line[EGRESS_HOSTS_OPEN_RE.search(line).end():]
                    in_egress_hosts = True
                closing = tail.find("]")
                scanned = tail if closing < 0 else tail[:closing]
                for m in QUOTED_RE.finditer(scanned):
                    host = m.group(1).strip().lower().rstrip(".")
                    # Same internal-host filter every other extraction path
                    # uses, so a fixture descriptor pointing at `.test` stays
                    # out of scope by construction.
                    if host and not is_internal_host(host):
                        found[host].add((path, lineno))
                if closing >= 0:
                    in_egress_hosts = False
            for m in URL_RE.finditer(line):
                host = m.group(1).lower().rstrip(".")
                if not is_internal_host(host):
                    found[host].add((path, lineno))
            if bare_ok:
                for m in BARE_HOST_RE.finditer(line):
                    host = m.group(1).lower()
                    if host.endswith(BARE_HOST_TLDS) and not is_internal_host(host):
                        found[host].add((path, lineno))
            for m in IPV4_RE.finditer(line):
                if is_public_ip(m.group(1)):
                    found[m.group(1)].add((path, lineno))
    return found


def load_allowlist(root: str) -> tuple[list[dict], set[str]]:
    path = os.path.join(root, ALLOWLIST_PATH)
    try:
        with open(path, encoding="utf-8") as fh:
            doc = yaml.safe_load(fh)
    except OSError as exc:
        print(f"ERROR: cannot read {ALLOWLIST_PATH}: {exc}", file=sys.stderr)
        sys.exit(2)
    if not isinstance(doc, dict) or doc.get("version") != 1:
        print(f"ERROR: {ALLOWLIST_PATH} must have version: 1", file=sys.stderr)
        sys.exit(2)
    entries = doc.get("entries") or []
    patterns: set[str] = set()
    for e in entries:
        for field in ("id", "kind", "service", "purpose", "ticket"):
            if not e.get(field):
                print(f"ERROR: allowlist entry missing '{field}': {e}",
                      file=sys.stderr)
                sys.exit(2)
        if e["kind"] == "dynamic":
            if not e.get("config_key"):
                print(f"ERROR: dynamic entry '{e['id']}' needs config_key",
                      file=sys.stderr)
                sys.exit(2)
            continue
        hosts = (e.get("destination") or {}).get("hosts") or []
        if not hosts:
            print(f"ERROR: entry '{e['id']}' (kind {e['kind']}) has no "
                  f"destination.hosts", file=sys.stderr)
            sys.exit(2)
        patterns.update(h.lower() for h in hosts)
    return entries, patterns


def host_allowed(host: str, patterns: set[str]) -> bool:
    if host in patterns:
        return True
    return any(p.startswith("*.") and fnmatch(host, p) for p in patterns)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo-root", default=None)
    ap.add_argument("--list-hosts", action="store_true",
                    help="print every extracted host and exit 0")
    args = ap.parse_args()

    root = args.repo_root or subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=True).stdout.strip()

    found = extract(root, tracked_files(root))
    if args.list_hosts:
        for host in sorted(found):
            locs = sorted(found[host])
            print(f"{host}  ({len(locs)} refs, e.g. {locs[0][0]}:{locs[0][1]})")
        return 0

    entries, patterns = load_allowlist(root)

    violations = {h: found[h] for h in found if not host_allowed(h, patterns)}

    # Stale-entry notice (non-fatal): egress/reference entries none of whose
    # hosts appear anywhere anymore — candidates for removal at review time.
    for e in entries:
        if e["kind"] == "dynamic":
            continue
        hosts = [h.lower() for h in e["destination"]["hosts"]]
        if not any(host_allowed(f, {h}) for h in hosts for f in found):
            print(f"NOTICE: allowlist entry '{e['id']}' matched no host in "
                  f"the repo — remove it or update code_refs at next review.")

    if not violations:
        print(f"egress-gate OK — {len(found)} distinct hosts, all allowlisted "
              f"({len(entries)} registry entries).")
        return 0

    print(f"\nEGRESS VIOLATION: {len(violations)} outbound destination(s) "
          f"not registered in {ALLOWLIST_PATH}\n", file=sys.stderr)
    for host in sorted(violations):
        print(f"  {host}", file=sys.stderr)
        for path, lineno in sorted(violations[host])[:5]:
            print(f"    {path}:{lineno}", file=sys.stderr)
    print(
        "\nThe Droplet appliance promises that customer data never leaves the\n"
        "device except through reviewed, allowlisted channels (WARP-269).\n"
        "To register a new destination:\n"
        f"  1. Add an entry to {ALLOWLIST_PATH} (schema in the file header):\n"
        "     id, kind, service, destination hosts/ports/protocol, phase,\n"
        "     data_class, purpose, ticket.\n"
        "  2. Request security review on the PR (assign Romain) — changes to\n"
        "     the allowlist are review-blocking by policy.\n"
        "  3. Runtime destinations must also be covered by the WARP-268\n"
        "     runtime egress audit before GA.\n"
        "If this hostname is not egress (XML namespace, doc link), register\n"
        "it with kind: reference instead. See docs/SECURITY.md#egress.\n",
        file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
