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
  * SCOPE (WARP-2468, code_refs_scope_report) — every code_refs path of a
    kind: egress entry must itself be in the denial scope below. A file the
    denial pass would never read cannot be evidence that the entry is used,
    so an ADR or a test fixture can no longer keep an entry green. kind:
    reference is exempt: it exists for doc and namespace hostnames.

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
                  ".goog", ".cloud", ".us", ".uk", ".de", ".fr", ".eu")
# WARP-2467 noise filters. PATTERNS, never file exemptions — exempting a file
# reopens the hole this closes, one directory at a time.
#   * an npm scoped package (`@droplet/tools-core`) can never be a hostname
#   * `you@company.com` is a sample address in placeholder text, not a
#     destination — but only when the literal carries no scheme, so a real
#     `https://user@host/` still denies.
EMAIL_LOCALPART_RE = re.compile(r"[A-Za-z0-9._%+-]+@$")
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


def is_package_specifier(literal: str) -> bool:
    """Is this string literal a package/module id rather than a hostname?

    WARP-2467's noise filter is a PATTERN list, never a file exemption —
    exempting a file would reopen the same hole the ticket closes, one
    directory at a time. Two shapes, both of which really occur:

      * `@scope/name` — an npm scoped package. `@droplet/tools-core`,
        `@modelcontextprotocol/sdk`. Never a hostname: a host cannot start
        with `@`.
      * a specifier whose dotted segment is followed by a path separator
        (`next/navigation`, `socket.io/client`) — hosts do appear with
        paths, but only behind a scheme, and URL_RE already owns that case.

    RFC 2606 names (.example/.test/.invalid/.localhost) and localhost
    itself are NOT handled here — INTERNAL_HOST_RE already filters them for
    every extraction mode, so there is one list, not two.
    """
    lit = literal.strip()
    return lit.startswith("@") and "/" in lit


def is_email_domain(literal: str, start: int) -> bool:
    """Is the match at `start` the domain half of a sample email address?

    `placeholder="you@company.com"` and `"Enter a valid email (e.g.
    name@acme.co)"` are the dashboard's onboarding copy, not destinations.

    Guarded on the literal carrying no scheme, so `https://user@evil.com/`
    is NOT excused — userinfo in a URL still names a real host.
    """
    if "://" in literal:
        return False
    return bool(EMAIL_LOCALPART_RE.search(literal[:start]))


def bare_host_sources(path: str, lines: list[str]) -> list[list[str]]:
    """Per line, the text the bare-host matcher is allowed to read.

    Config files (docker-compose, OpenWrt UCI, .env.example) hand over the
    whole raw line: a host there is a setting, and there is no prose to be
    noisy about.

    Code files were EXEMPT until WARP-2467, which meant the only shape the
    gate enforced in code was a literal scheme URL:

        const HOST = "api.evil.example";        // never scanned
        await fetch(`https://${HOST}/v1/data`); // no literal scheme URL

    passed with exit 0 while the destination was registered nowhere. The
    exemption existed to dodge prose noise, but it made the gate catch only
    connectors that already follow the convention — and a gate that only
    catches the compliant is not a gate. So code files hand over their
    string-literal contents instead: the noise lived in comments and prose,
    which a filter can remove, rather than in literals.
    """
    if CONFIG_FILES_FOR_BARE_HOSTS.search(path):
        return [[line] for line in lines]
    slashes, hashes = comment_styles(path)
    per_line = string_literal_lines("".join(lines), slashes, hashes)
    # scan_source preserves newlines, so per_line tracks `lines` — but a file
    # with no trailing newline, or one ending mid-literal, can come up short.
    while len(per_line) < len(lines):
        per_line.append([])
    return per_line


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
        # Bare hosts: a whole raw line in config files, string-literal
        # contents only in code files (WARP-2467). See bare_host_sources.
        bare_src = bare_host_sources(path, lines)
        for lineno, line in enumerate(lines, 1):
            for m in URL_RE.finditer(line):
                host = m.group(1).lower().rstrip(".")
                if not is_internal_host(host):
                    found[host].add((path, lineno))
            for chunk in bare_src[lineno - 1]:
                if is_package_specifier(chunk):
                    continue
                for m in BARE_HOST_RE.finditer(chunk):
                    if is_email_domain(chunk, m.start()):
                        continue
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


def scan_source(text: str, slashes: bool, hashes: bool):
    """Walk `text` yielding (char, in_string) for every NON-comment char.

    The single source-walking primitive both directions share. WARP-2452
    introduced it inside strip_comments; WARP-2467 lifted it out so the
    bare-host denial pass could ask the other question the same walk
    already answers — "was this character inside a string literal?" —
    rather than growing a second, subtly different parser.

    A pragmatic scanner, NOT a language parser (WARP-2452 says it need not
    be). Tracking quotes is what keeps `https://` inside a literal from
    reading as the start of a `//` comment; it handles `//` + `/* */` for
    C-family files and `#` for shell/python/YAML/conf.

    Newlines are always yielded, INCLUDING the ones inside a block comment,
    so a caller can count lines. Quote delimiters yield in_string=False and
    their contents in_string=True, so "inside a literal" means the content.

    Known limits, accepted deliberately:
      * An unbalanced apostrophe in prose ("don't") leaves the walker inside
        a phantom string, suppressing comment detection for the rest of it.
      * Markdown and JSON get no stripping — neither has comment syntax.
      * A triple-quoted block used as DATA rather than prose (a heredoc-ish
        SQL blob) is treated as prose, so a host inside one does not deny.
        Rare, and it fails in the permissive direction like the rest.

    Every limit fails PERMISSIVE for the BACKING pass: it can only retain
    text, never delete a real literal, so the worst case is a lie we miss,
    never a false CI failure against honest code. For the DENIAL pass the
    same permissiveness means at worst an extra host to register, which is
    cheap and reviewed — never a missed destination.
    """
    i, n, quote = 0, len(text), None
    while i < n:
        ch = text[i]
        if quote is not None:
            if ch == "\\" and i + 1 < n:      # keep escapes intact
                yield ch, True
                yield text[i + 1], True
                i += 2
                continue
            if ch == quote:
                quote = None
                yield ch, False
            else:
                yield ch, True
            i += 1
            continue
        # Triple-quoted block: PROSE, not a literal (WARP-2467). Yielded with
        # in_string=False, so strip_comments still keeps every character —
        # the BACKING pass is unchanged — while the bare-host denial pass,
        # which reads only in_string=True, skips it. Without this the
        # scanner's own docstrings deny ("api.evil.example", "socket.io"),
        # and so does every explanatory docstring in the repo. A scheme URL
        # in a docstring still denies: that pass reads raw lines.
        if text[i:i + 3] in ('"""', "'''"):
            fence = text[i:i + 3]
            end = text.find(fence, i + 3)
            stop = n if end < 0 else end + 3
            for c in text[i:stop]:
                yield c, False
            i = stop
            continue
        if ch in "\"'`":
            quote = ch
            yield ch, False
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
            stop = n if end < 0 else end + 2
            # Re-emit the comment's newlines: dropping them would shift every
            # line number after a block comment in the denial report.
            for c in text[i:stop]:
                if c == "\n":
                    yield c, False
            i = stop
            continue
        if hashes and ch == "#":
            while i < n and text[i] != "\n":
                i += 1
            continue
        yield ch, False
        i += 1


def strip_comments(text: str, slashes: bool, hashes: bool) -> str:
    """Comment-free `text`, for the BACKING pass (WARP-2452).

    A hostname in prose must not vouch for a registry entry. See
    scan_source for the walker and its accepted limits.
    """
    if not slashes and not hashes:
        return text
    return "".join(ch for ch, _ in scan_source(text, slashes, hashes))


def string_literal_lines(text: str, slashes: bool, hashes: bool) -> list[list[str]]:
    """Per line (1-based index - 1), the string literals it contains.

    The DENIAL pass's bare-host extractor (WARP-2467) works on this instead
    of raw lines. Two properties matter:

      * comments are already gone, so `// see api.open-meteo.com` does not
        deny — but a scheme URL in a comment still does, because that path
        keeps scanning raw lines. That asymmetry is the existing rule: a
        commented-out endpoint is one uncomment away from egress, whereas a
        hostname in prose is usually just prose.
      * literals are kept SEPARATE rather than concatenated, so a filter can
        judge a whole literal — an npm specifier like "@droplet/tools-core"
        or "socket.io" is discarded as a unit, not char-spliced into its
        neighbour and made to look like a host.
    """
    out: list[list[str]] = [[]]
    current: list[str] = []
    for ch, in_string in scan_source(text, slashes, hashes):
        if ch == "\n":
            if current:
                out[-1].append("".join(current))
                current = []
            out.append([])
            continue
        if in_string:
            current.append(ch)
        elif current:
            out[-1].append("".join(current))
            current = []
    if current:
        out[-1].append("".join(current))
    return out


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


def code_refs_scope_report(entry: dict) -> list[str]:
    """code_refs paths of `entry` that the denial pass would never read.

    WARP-2468. The BACKING pass will happily accept a literal from any
    tracked file, so `code_refs: [docs/ADR-041-...md]` made two M365 entries
    look live off the ADR that merely *proposed* the destination — from
    design time through to a connector that never ships.

    The rule is the scanner's own `in_scope`, deliberately not a fresh copy
    of SCOPE_PREFIXES, so the two directions can never drift apart. That
    also excludes test files (EXCLUDE_RE): `graph.microsoft.com` exists in
    this repo only inside `.test.ts` fixtures, and a fixture host proves
    nothing about what the box dials either.

    Applies to kind: egress only — kind: reference exists precisely for the
    doc and namespace hostnames a docs path is the right citation for, and
    kind: dynamic has no destination to trace. Callers enforce that.
    """
    return [r for r in (entry.get("code_refs") or []) if not in_scope(r)]


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
    #
    # WARP-2468 runs the SCOPE pass in the same loop: a code_refs path the
    # denial scan would never read cannot be evidence of use, so it is a hard
    # error even when the entry is otherwise backed by that very file.
    ref_failures: list[str] = []
    scope_failures: list[str] = []
    for e in entries:
        if e["kind"] != "egress":
            continue
        out_of_scope = code_refs_scope_report(e)
        if out_of_scope:
            scope_failures.append(
                f"  {e['id']}: code_refs outside the denial scope: "
                f"{', '.join(out_of_scope)}")
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

    if not violations and not ref_failures and not scope_failures:
        print(f"egress-gate OK — {len(found)} distinct hosts, all allowlisted "
              f"({len(entries)} registry entries).")
        return 0

    if scope_failures:
        print(f"\nEGRESS CODE_REFS OUT OF SCOPE: {len(scope_failures)} kind: "
              f"egress entry/entries in\n{ALLOWLIST_PATH} cite a file the "
              f"denial scan never reads\n", file=sys.stderr)
        for detail in scope_failures:
            print(detail, file=sys.stderr)
        print(
            "\ncode_refs is the evidence that a registered destination is\n"
            "really dialled, so it has to point at code this gate itself\n"
            "scans: apps/ services/ packages/ docker/ scripts/ openwrt/\n"
            "proto/ schemas/ (or .env.example), and not a test file. An ADR\n"
            "or a runbook proves only that somebody once proposed the host —\n"
            "that is how an entry stays green all the way to a connector\n"
            "that never ships. Resolve by:\n"
            "  1. Repointing code_refs at the source file holding the URL.\n"
            "  2. If no such file exists yet, keep the doc as a YAML comment\n"
            "     and add a no_code_literal: reason instead — that one\n"
            "     self-prunes the moment the real caller lands.\n"
            "  3. If the host is not egress at all (XML namespace, doc link),\n"
            "     it belongs under kind: reference, which may cite docs/.\n"
            "Touching the allowlist needs security review (assign Romain).\n"
            "See docs/SECURITY.md#egress and WARP-2468.\n",
            file=sys.stderr)

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
