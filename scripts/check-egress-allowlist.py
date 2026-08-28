#!/usr/bin/env python3
"""WARP-269 — telemetry-free invariant: static egress-destination gate.

Extracts every outbound network destination referenced by tracked files and
fails (exit 1) if any host is not registered in
docs/security/allowed-egress.yaml. See that file's header for the schema and
docs/SECURITY.md#egress for the policy.

The gate runs in two opposite directions:

  * DENIAL (below) — is every destination the repo names registered? Reads
    comments ON PURPOSE; a commented-out endpoint is one uncomment away.
  * BACKING (WARP-2452, code_ref_literal_report) — is every registered
    kind: egress entry actually load-bearing? Here a comment proves nothing,
    so comments are stripped: each entry must show one of its hosts as a
    non-comment literal in one of its own code_refs files, or declare
    no_code_literal. Without this an entry can go decorative — its host
    mentioned only in a doc comment, or split into runtime-assembled parts —
    while CI stays green and the registry quietly stops describing what the
    code dials.

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

# ── BACKING pass: which comment syntax applies to a code_refs file ──────────
C_COMMENT_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go",
                      ".rs", ".java", ".c", ".h", ".proto", ".prisma",
                      ".css", ".scss")
HASH_COMMENT_SUFFIXES = (".py", ".sh", ".bash", ".zsh", ".yml", ".yaml",
                         ".toml", ".conf", ".cnf", ".cfg", ".ini", ".env",
                         ".example", ".service", ".rb", ".pl")


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
        for lineno, line in enumerate(lines, 1):
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


def comment_styles(path: str) -> tuple[bool, bool]:
    """(slash_comments, hash_comments) applicable to `path`."""
    base = os.path.basename(path)
    slashes = path.endswith(C_COMMENT_SUFFIXES)
    hashes = (path.endswith(HASH_COMMENT_SUFFIXES) or "Dockerfile" in base
              or base.startswith(".env") or "." not in base)
    return slashes, hashes


def strip_comments(text: str, slashes: bool, hashes: bool) -> str:
    """Remove comments so a hostname in prose cannot vouch for an entry.

    A pragmatic scanner, NOT a language parser (WARP-2452 says it need not
    be). It walks the text tracking quoted strings, so `https://` inside a
    literal is never mistaken for the start of a `//` comment, and handles
    `//` + `/* */` for C-family files and `#` for shell/python/YAML/conf.

    Known limits, accepted deliberately:
      * Python triple quotes read as three one-character strings, so a `#`
        inside a docstring ends a line there.
      * An unbalanced apostrophe in prose ("don't") leaves the walker inside
        a phantom string, suppressing comment detection for the rest of it.
      * Markdown and JSON get no stripping — neither has comment syntax.

    Every limit fails PERMISSIVE: it can only retain text, never delete a
    real literal. So the worst case is a lie we miss, never a false CI
    failure against honest code.
    """
    if not slashes and not hashes:
        return text
    out: list[str] = []
    i, n, quote = 0, len(text), None
    while i < n:
        ch = text[i]
        if quote is not None:
            if ch == "\\" and i + 1 < n:      # keep escapes intact
                out.append(ch)
                out.append(text[i + 1])
                i += 2
                continue
            out.append(ch)
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "\"'`":
            quote = ch
            out.append(ch)
            i += 1
            continue
        # `://` is a URL scheme, never a comment — guards unquoted config URLs.
        if (slashes and ch == "/" and i + 1 < n and text[i + 1] == "/"
                and not (i > 0 and text[i - 1] == ":")):
            while i < n and text[i] != "\n":
                i += 1
            continue
        if slashes and ch == "/" and i + 1 < n and text[i + 1] == "*":
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        if hashes and ch == "#":
            while i < n and text[i] != "\n":
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def host_literal_in(host: str, text: str) -> bool:
    """Is `host` present as a contiguous literal in `text`?

    Substring matching on purpose: hosts appear quoted in TS, bare in YAML,
    and after `=` in .conf/.env, so a quote-anchored rule would reject the
    honest config cases. A `*.` pattern is satisfied by any concrete
    subdomain of it. The point is contiguity — `"https://files." + host`
    does not match, which is exactly the runtime-assembly this pass catches.
    """
    host = host.lower()
    text = text.lower()
    if host.startswith("*."):
        return re.search(r"[a-z0-9_-]+\." + re.escape(host[2:]), text) is not None
    return host in text


def code_ref_literal_report(
    root: str, entry: dict
) -> tuple[bool, str | None, list[str], list[str]]:
    """(satisfied, matched_host, refs_checked, unreadable_refs) for an entry.

    Satisfied when ANY host of the entry appears as a non-comment literal in
    ANY of its code_refs — the per-entry question the stale-entry notice has
    always asked, promoted to enforcement. Per-HOST would be stronger but
    fails honest entries whose extra hosts are redirect targets never named
    in code (e.g. objects.githubusercontent.com); see WARP-2452 notes.
    """
    hosts = [h.lower() for h in (entry.get("destination") or {}).get("hosts") or []]
    refs = entry.get("code_refs") or []
    unreadable: list[str] = []
    for ref in refs:
        try:
            with open(os.path.join(root, ref), encoding="utf-8",
                      errors="ignore") as fh:
                raw = fh.read()
        except OSError:
            unreadable.append(ref)
            continue
        slashes, hashes = comment_styles(ref)
        body = strip_comments(raw, slashes, hashes)
        for host in hosts:
            if host_literal_in(host, body):
                return True, host, refs, unreadable
    return False, None, refs, unreadable


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
        declared = e.get("no_code_literal")
        if declared is not None:
            if e["kind"] != "egress":
                print(f"ERROR: entry '{e['id']}' (kind {e['kind']}) sets "
                      f"no_code_literal, which only applies to kind: egress",
                      file=sys.stderr)
                sys.exit(2)
            if not isinstance(declared, str) or not declared.strip():
                print(f"ERROR: entry '{e['id']}' no_code_literal must be a "
                      f"non-empty reason naming who owns the destination",
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

    # ── BACKING pass (WARP-2452) ────────────────────────────────────────────
    # The denial pass above reads comments on purpose, which means a hostname
    # sitting in a doc comment makes a dead entry look live — and hides a URL
    # that is really assembled at runtime. Here comments prove nothing.
    #
    # kind: dynamic is exempt BY DESIGN — its host comes from config_key at
    # runtime (docs/SECURITY.md:174-184), so no literal can exist. kind:
    # reference is not egress at all. Both keep their previous behaviour.
    ref_failures: list[str] = []
    for e in entries:
        if e["kind"] != "egress":
            continue
        satisfied, hit, refs, unreadable = code_ref_literal_report(root, e)
        declared = e.get("no_code_literal")
        hosts = ", ".join((e.get("destination") or {}).get("hosts") or [])
        if satisfied and declared:
            ref_failures.append(
                f"  {e['id']}: declares no_code_literal, but '{hit}' IS a "
                f"non-comment\n    literal in its code_refs — drop the "
                f"declaration, the code backs it.")
        elif not satisfied and not declared:
            detail = (f"  {e['id']}: no host of [{hosts}] appears as a "
                      f"non-comment literal\n    in code_refs: "
                      f"{', '.join(refs) if refs else '(none listed)'}")
            if unreadable:
                detail += f"\n    unreadable code_refs: {', '.join(unreadable)}"
            ref_failures.append(detail)

    if not violations and not ref_failures:
        print(f"egress-gate OK — {len(found)} distinct hosts, all allowlisted "
              f"({len(entries)} registry entries).")
        return 0

    if ref_failures:
        print(f"\nEGRESS REGISTRY DRIFT: {len(ref_failures)} kind: egress "
              f"entry/entries in {ALLOWLIST_PATH}\nnot backed by the code "
              f"they claim to describe\n", file=sys.stderr)
        for detail in ref_failures:
            print(detail, file=sys.stderr)
        print(
            "\nA registered destination must be traceable to the code that\n"
            "dials it. Comments do not count here: the denial scan reads them\n"
            "on purpose, so a hostname in a comment can keep a dead entry\n"
            "looking live and hide a URL assembled at runtime. Resolve by:\n"
            "  1. Pointing code_refs at the file holding the whole-string URL\n"
            "     literal — keep base URLs unsplit, that is the convention.\n"
            "  2. If a third-party binary or SDK owns the destination and no\n"
            "     literal can exist, add a one-line no_code_literal: reason\n"
            "     to that entry naming the owner. Per-entry only — a blanket\n"
            "     exemption would make the gate decorative again.\n"
            "  3. If nothing dials it any more, delete the entry.\n"
            "All three touch the allowlist: request security review (assign\n"
            "Romain). See docs/SECURITY.md#egress and WARP-2452.\n",
            file=sys.stderr)

    if not violations:
        return 1

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
