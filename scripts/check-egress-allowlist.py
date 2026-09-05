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
  * INTEGRITY (WARP-2487, duplicate_id_report) — two entries may not share
    an id. YAML permits it, so PR #1828 shipped two identical `hubspot-api`
    blocks under a green summary line.

Extraction rules (v1, deliberately conservative):
  * scheme URLs  — (https|http|wss|ws|ftp)://<host>  anywhere in scoped
    files, including comments (a commented-out endpoint is one uncomment
    away from egress; allowlisting it as kind: reference is cheap).
  * bare hosts   — dotted hostnames, in two shapes:
      - CONFIG files (docker/docker-compose.yml, openwrt/files/etc/config/*,
        .env.example) hand over the whole raw line.
      - CODE files hand over their STRING-LITERAL contents, comments
        stripped (WARP-2467). Code used to be exempt entirely, which meant
        the only shape enforced in code was a literal scheme URL, so
        `const H = "api.evil-corp.io"` plus a runtime-assembled fetch
        passed. The prose noise that exemption dodged is handled by the
        PATTERN filters below instead — there are no file exemptions.
    What counts as a hostname is the PUBLIC SUFFIX LIST (WARP-2487,
    scripts/data/public_suffix_list.dat), not a hand-kept TLD tuple: a
    candidate must sit under a real ICANN suffix with at least one label of
    its own. A provider descriptor's egressHosts array (WARP-2217) is
    stricter still and takes any dotted token.
  * public IPv4  — any non-private IP literal in scoped files.

Bare-host noise filters, all PATTERNS (WARP-2467/2487) — there are no file
exemptions, because exempting a file reopens the hole one directory at a
time:
  * RFC 2606 reserved names, in two independent layers;
  * `@scope/name` npm identifiers — a host cannot start with `@`;
  * the domain half of a sample email address in placeholder copy, but only
    when the literal carries no scheme, so `https://user@host/` still denies;
  * Python triple-quoted blocks, which are prose;
  * the basename of any git-tracked file, derived from the repo itself, so
    `setup.sh` and `internal-mtls.md` are filenames rather than hosts;
  * SQL `--` comments, which the walker did not know about and which read
    back as source.
Beyond those, a candidate needs one of two confidences: a legacy
high-signal TLD, or a value-shaped position. See LEGACY_HIGH_SIGNAL_TLDS.
A scheme URL in a comment or docstring still denies — that pass reads raw
lines.

Scope: git-tracked files under apps/ services/ packages/ docker/ scripts/
openwrt/ proto/ schemas/ plus root .env.example — minus tests, fixtures,
mocks, docs, markdown. Tests never ship; their fixture hosts (evil.example
etc.) are out of scope by construction.

Filtered as internal (never egress): localhost, host.docker.internal,
RFC-2606 reserved TLDs (.test/.example/.invalid/.localhost), .local, .lan,
.internal, .home.arpa, example.com/net/org, private/loopback IPs.

Usage:
  python3 scripts/check-egress-allowlist.py [--repo-root DIR] [--list-hosts]
  python3 scripts/check-egress-allowlist.py --check-psl-freshness
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

# ── WARP-2487: what counts as a hostname is the Public Suffix List ──────────
# Until this ticket a candidate was a host only if it ended in one of fifteen
# hand-kept TLDs. #1831 (WARP-2467) made that tuple load-bearing for CODE and
# not just config, at which point every destination outside it — vendor.sh,
# vendor.app, vendor.xyz — was invisible in the denial direction, and stayed
# invisible until somebody remembered to widen a tuple. A gate whose coverage
# is a list someone has to remember to extend is not a gate.
#
# The snapshot is vendored (scripts/data/public_suffix_list.dat, refreshed by
# scripts/fetch-public-suffix-list.sh) and read from THIS FILE'S directory,
# never from --repo-root: the scanner runs offline, in CI and on the box, and
# must never make a network call. It is also read outside the repo scope in
# tests, which hand --repo-root a synthetic tree that has no snapshot.
PSL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "data", "public_suffix_list.dat")
# The list is updated several times a week upstream, so a snapshot whose own
# VERSION line is half a year old means the refresh has stopped, not that the
# internet stopped issuing TLDs. Checked by --check-psl-freshness, which the
# scanner's own test suite runs; NOT by the PR gate, which stays deterministic.
PSL_MAX_AGE_DAYS = 180
PSL_VERSION_RE = re.compile(r"^//\s*VERSION:\s*(\d{4})-(\d{2})-(\d{2})")
PSL_ICANN_BEGIN = "// ===BEGIN ICANN DOMAINS==="
PSL_ICANN_END = "// ===END ICANN DOMAINS==="
# WARP-2467 noise filters. PATTERNS, never file exemptions — exempting a file
# reopens the hole this closes, one directory at a time.
#   * an npm scoped package (`@droplet/tools-core`) can never be a hostname
#   * `you@company.com` is a sample address in placeholder text, not a
#     destination — but only when the literal carries no scheme, so a real
#     `https://user@host/` still denies.
EMAIL_LOCALPART_RE = re.compile(r"[A-Za-z0-9._%+-]+@$")
IPV4_RE = re.compile(r"\b((?:\d{1,3}\.){3}\d{1,3})\b")

# ── WARP-2487: the two confidences a bare-host candidate can carry ──────────
# The PSL makes ~1,440 TLDs matchable where fifteen were before, and most of
# the newly matchable ones are ordinary English words — `.name`, `.id`,
# `.map`, `.zone`, `.md`, `.sh`, `.py`. Measured on pristine stage, turning it
# on unfiltered took the repo from 69 hosts to 459.
#
# So a candidate is taken when EITHER holds:
#
#   1. its suffix is one of the fifteen LEGACY_HIGH_SIGNAL_TLDS — the exact
#      set this gate keyed on before, so nothing it used to see is lost, in
#      prose and comments included;
#   2. it is VALUE-SHAPED: the candidate is the whole string literal, or the
#      whole right-hand side of a config assignment, give or take a scheme-less
#      leading dot and a trailing port or path. That is the shape a
#      destination is actually written in, and the shape the repo's own
#      whole-string-URL convention produces.
#
# The tuple is therefore a FLOOR, never a ceiling: deleting it can only make
# the scanner stricter, never blinder — the opposite of its old role, where it
# was the sole gate and every unlisted TLD was invisible. `vendor.sh`,
# `vendor.app` and `vendor.xyz` in a code literal are all value-shaped, so
# they deny; `wireless.channel` inside a call argument list, or `setup.sh` in
# a sentence, are not.
LEGACY_HIGH_SIGNAL_TLDS = (".com", ".org", ".net", ".io", ".ai", ".co",
                           ".dev", ".goog", ".cloud", ".us", ".uk", ".de",
                           ".fr", ".eu")
# Decoration a destination may carry and still be "the value": a leading
# wildcard/suffix dot (`".hs1api.com"` is the Ascend guard constant verbatim),
# a userinfo `@`, and surrounding quotes the walker did not consume.
VALUE_LEAD_RE = re.compile(r"^[\s\"'`*.@]*$")
# ...and after it, nothing, or a port/path/query/fragment. A trailing DOT is
# deliberately NOT allowed: `` `firewall.zone.${zone}` `` is a namespace
# prefix assembled at runtime, which is WARP-268's problem, not this pass's.
VALUE_TAIL_RE = re.compile(r"^(:\d+)?([/?#].*)?$", re.S)
VALUE_TAIL_TRIM_RE = re.compile(r"[\s\"'`)\]}]+$")
# `KEY=value`, `key: value`, `- KEY=value` (compose env lists), and OpenWrt
# UCI's `option name 'value'` / `list name 'value'`.
CONFIG_ASSIGN_RE = re.compile(r"^-?\s*[A-Za-z_][A-Za-z0-9_.\[\]-]*\s*[:=]\s*(.*)$")
CONFIG_UCI_RE = re.compile(r"^(?:option|list)\s+\S+\s+'?([^']*)'?\s*$")

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


def load_public_suffixes(path: str = PSL_PATH):
    """(rules, wildcards, exceptions) from the vendored PSL — ICANN only.

    The PRIVATE DOMAINS section is deliberately EXCLUDED. It registers
    suffixes like `github.io` and `s3.amazonaws.com`, and a public suffix is
    by definition not itself a registrable name — so honouring the private
    section would make `github.io` and `s3.amazonaws.com` stop being hosts.
    In a denial gate that is a false NEGATIVE, the one direction this scanner
    may never fail in. ICANN-only keeps them registrable and therefore
    detectable, and costs nothing: no ICANN rule is a destination.
    """
    rules: set[str] = set()
    wildcards: set[str] = set()
    exceptions: set[str] = set()
    try:
        with open(path, encoding="utf-8") as fh:
            in_icann = False
            for line in fh:
                s = line.strip()
                if s == PSL_ICANN_BEGIN:
                    in_icann = True
                    continue
                if s == PSL_ICANN_END:
                    break
                if not in_icann or not s or s.startswith("//"):
                    continue
                s = s.lower()
                if s.startswith("!"):
                    exceptions.add(s[1:])
                elif s.startswith("*."):
                    wildcards.add(s[2:])
                else:
                    rules.add(s)
    except OSError as exc:
        print(f"ERROR: cannot read the vendored Public Suffix List at "
              f"{path}: {exc}\nRun scripts/fetch-public-suffix-list.sh to "
              f"restore it.", file=sys.stderr)
        sys.exit(2)
    if not rules:
        print(f"ERROR: {path} yielded no ICANN rules — the snapshot is "
              f"truncated or the section markers changed. Refusing to run "
              f"with an empty suffix set, which would make every bare host "
              f"invisible.", file=sys.stderr)
        sys.exit(2)
    return rules, wildcards, exceptions


_PSL_CACHE = None


def public_suffixes():
    global _PSL_CACHE
    if _PSL_CACHE is None:
        _PSL_CACHE = load_public_suffixes()
    return _PSL_CACHE


def public_suffix_of(host: str, psl=None) -> str | None:
    """Longest matching ICANN public suffix of `host`, or None.

    The published algorithm ends with "if no rules match, the prevailing rule
    is `*`". That default is deliberately NOT implemented here. Under it every
    dotted token has a public suffix, so `run.sh`, `main.py` and `foo.bar`
    would all be registrable domains and the PSL would filter nothing. What
    this scanner needs is the narrower question the list can actually answer:
    is the right-hand side a suffix somebody really delegates? So an explicit
    rule must match, or the token is not a hostname.
    """
    rules, wildcards, exceptions = psl if psl is not None else public_suffixes()
    labels = host.split(".")
    # Exception rules (`!www.ck`) win over every other rule; the suffix is the
    # matched rule minus its leftmost label.
    for i in range(len(labels)):
        if ".".join(labels[i:]) in exceptions:
            return ".".join(labels[i + 1:]) or None
    # i ascending walks longest candidate first, so the first hit is the
    # longest match — which is what the algorithm asks for.
    for i in range(len(labels)):
        candidate = labels[i:]
        joined = ".".join(candidate)
        if joined in rules:
            return joined
        if len(candidate) > 1 and ".".join(candidate[1:]) in wildcards:
            return joined
    return None


def is_registrable_domain(host: str, psl=None) -> bool:
    """Is `host` a name under a real public suffix, rather than a filename?

    Replaces the fifteen-entry BARE_HOST_TLDS tuple this gate used to key on
    (WARP-2487). Two conditions, both necessary:

      * an ICANN rule matches — so `1.2.3.tar`, `package-lock.json` and
        `styles.module.css` are not hosts, because `tar`/`json`/`css` are not
        delegated;
      * at least one label sits to the LEFT of that suffix — so `co.uk` and
        `com.au` are not destinations, only names registered under them are.
    """
    suffix = public_suffix_of(host, psl)
    if suffix is None:
        return False
    return host.count(".") > suffix.count(".")


def psl_snapshot_date(path: str = PSL_PATH) -> str | None:
    """The snapshot's own `// VERSION: YYYY-MM-DD_...` date, or None.

    Upstream stamps it, so freshness is read from the DATA rather than from a
    header we would have to remember to hand-edit — a hand-edited date can
    claim a currency the rules do not have, which is the one failure mode a
    staleness check exists to catch.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                m = PSL_VERSION_RE.match(line.strip())
                if m:
                    return "-".join(m.groups())
                if line.strip() == PSL_ICANN_BEGIN:
                    break
    except OSError:
        return None
    return None


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


def config_value_of(text: str, path: str) -> str:
    """The right-hand side of `text`, if it is a config assignment.

    Only config files reach the bare-host matcher as WHOLE RAW LINES, so only
    they need this: in a code file the "value" is the string literal the
    walker already isolated.
    """
    if not CONFIG_FILES_FOR_BARE_HOSTS.search(path):
        return text
    s = text.strip()
    m = CONFIG_UCI_RE.match(s)
    if m:
        return m.group(1).strip()
    m = CONFIG_ASSIGN_RE.match(s)
    if m:
        return m.group(1).strip().strip("'\"")
    return s


def is_value_shaped(host: str, text: str, path: str) -> bool:
    """Is `host` written as the VALUE of `text`, rather than a word in it?

    The second of the two confidences described at LEGACY_HIGH_SIGNAL_TLDS,
    and the one that lets the gate see a destination on any of the ~1,440
    delegated TLDs without drowning in `run.sh` and `item.name`.

    Accepts `"api.vendor.sh"`, `".hs1api.com"`, `GEO_HOST=api.vendor.sh`,
    `option server 'api.vendor.sh'`, `"api.vendor.sh:8443/v1"`. Rejects
    `"see scripts/setup.sh for details"`, and `${item.name}` in a template
    literal, where the `${` before the candidate is not decoration a
    destination could carry. Rejects a trailing dot on purpose; see
    VALUE_TAIL_RE.

    Measured on the whole repo: this is the load-bearing filter. Without it
    the wider suffix list takes 184 hosts instead of 77.
    """
    value = config_value_of(text, path)
    at = value.find(host)
    if at < 0:
        return False
    if not VALUE_LEAD_RE.match(value[:at]):
        return False
    tail = VALUE_TAIL_TRIM_RE.sub("", value[at + len(host):])
    return bool(VALUE_TAIL_RE.match(tail))


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
    slashes, hashes, dashes = comment_styles(path)
    per_line = string_literal_lines("".join(lines), slashes, hashes, dashes)
    # scan_source preserves newlines, so per_line tracks `lines` — but a file
    # with no trailing newline, or one ending mid-literal, can come up short.
    while len(per_line) < len(lines):
        per_line.append([])
    return per_line


def repo_file_basenames(files: list[str]) -> set[str]:
    """Lowercased basenames of every tracked file (WARP-2487).

    A filename filter DERIVED from the repository, so it needs no upkeep and
    cannot rot: `setup.sh`, `internal-mtls.md` and `config.py` stop being
    hostnames because this repo really contains files with those names, and
    the moment one is deleted the filter stops covering it.

    It replaces the alternative — an extension denylist — which the ticket
    rules out and which would be actively wrong: `.sh`, `.app` and `.py` are
    delegated TLDs, so denylisting them is the blind spot WARP-2487 exists to
    close. Accepted limit, bounded and reviewable: a destination whose name
    equals a tracked file's basename goes unseen. That takes a file called
    `vendor.sh` sitting in the tree next to the connector that dials
    `vendor.sh`, which is a diff a reviewer reads.
    """
    return {os.path.basename(p).lower() for p in files}


def extract(root: str, files: list[str]) -> dict[str, set[tuple[str, int]]]:
    found: dict[str, set[tuple[str, int]]] = defaultdict(set)
    basenames = repo_file_basenames(files)
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
        # Open when we are inside an `egressHosts: [` array (WARP-2217).
        # KEPT after WARP-2467 generalised bare-host matching, because it is
        # strictly stronger inside these arrays: a descriptor entry is taken
        # whatever its TLD, where the general path requires a BARE_HOST_TLDS
        # suffix. A descriptor host on an unusual TLD is caught here and
        # nowhere else, so the two paths are additive, not redundant.
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
            for chunk in bare_src[lineno - 1]:
                if is_package_specifier(chunk):
                    continue
                for m in BARE_HOST_RE.finditer(chunk):
                    if is_email_domain(chunk, m.start()):
                        continue
                    host = m.group(1).lower()
                    if not is_registrable_domain(host) or is_internal_host(host):
                        continue
                    if host in basenames:
                        continue
                    # The two confidences — see LEGACY_HIGH_SIGNAL_TLDS.
                    if (host.endswith(LEGACY_HIGH_SIGNAL_TLDS)
                            or is_value_shaped(host, chunk, path)):
                        found[host].add((path, lineno))
            for m in IPV4_RE.finditer(line):
                if is_public_ip(m.group(1)):
                    found[m.group(1)].add((path, lineno))
    return found


def comment_styles(path: str) -> tuple[bool, bool, bool]:
    """(slash_comments, hash_comments, dash_comments) applicable to `path`.

    `.sql` had NEITHER style until WARP-2487, so a migration's whole `--`
    header was read as source. Because `'` is SQL's string delimiter, an
    apostrophe in that prose left the walker inside a phantom string for the
    rest of the file and the SQL body came back as "literal contents" — which
    is how `req.user.id` and `ai.model.chat` turned up as destinations. Both
    directions get this: a hostname in a SQL comment must not back an entry
    either.
    """
    base = os.path.basename(path)
    slashes = path.endswith(C_COMMENT_SUFFIXES)
    hashes = (path.endswith(HASH_COMMENT_SUFFIXES) or "Dockerfile" in base
              or base.startswith(".env") or "." not in base)
    dashes = path.endswith(".sql")
    return slashes, hashes, dashes


# ── WARP-2516: JS/TS regex literals ─────────────────────────────────────────
# A `/` that opens a regex literal is not a divide, and the quotes inside it
# are not string delimiters. `scan_source` did not know that, so `/[^\']/`
# left the walker inside a phantom string for the rest of the file: comment
# stripping stopped, and a hostname in a `//` comment below it counted as a
# non-comment literal and BACKED a registry entry that should have been
# reported as unreferenced — the exact escape WARP-2452 exists to close.
#
# Characters after which a `/` starts a regex rather than a division. A
# division always follows a VALUE (identifier, literal, `)`, `]`), so the
# complement is what is listed here; `<` is deliberately absent, to keep JSX's
# `</div>` out.
REGEX_POSITION_CHARS = "=(,:[!&|?{};"


def regex_literal_end(text: str, start: int) -> int | None:
    r"""Index just past the regex literal at `start`, or None if it is not one.

    Returns None at a newline, because a JS regex literal cannot span lines —
    so an unmatched `/` (a division this heuristic misread) costs nothing
    instead of swallowing the rest of the file. `[...]` is tracked because a
    `/` inside a character class does not close the literal, and escapes are
    honoured so `\/` does not either.
    """
    i, n, in_class = start + 1, len(text), False
    while i < n:
        ch = text[i]
        if ch == "\n":
            return None
        if ch == "\\":
            i += 2
            continue
        if ch == "[":
            in_class = True
        elif ch == "]":
            in_class = False
        elif ch == "/" and not in_class:
            i += 1
            while i < n and text[i].isalpha():   # trailing flags: gimsuyd
                i += 1
            return i
        i += 1
    return None


def in_regex_position(text: str, at: int) -> bool:
    """Would a `/` at `at` open a regex literal rather than divide?

    A heuristic, like the rest of this walker — the real answer needs a
    parser. It fails in the PERMISSIVE direction for both passes: a division
    misread as a regex still yields every character, and a regex misread as a
    division only restores today's behaviour.
    """
    j = at - 1
    while j >= 0 and text[j] in " \t":
        j -= 1
    if j < 0 or text[j] == "\n":
        return True                                    # start of a line
    if text[j] in REGEX_POSITION_CHARS:
        return True
    if not text[:j + 1].endswith("return"):            # `return /re/.test(x)`
        return False
    before = text[j - 6] if j >= 6 else "\n"
    return not (before.isalnum() or before in "_$")


def scan_source(text: str, slashes: bool, hashes: bool, dashes: bool = False):
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
        The one shape that really occurred — a quote inside a REGEX literal,
        `/[^']/` — is handled (WARP-2516); JSX text is the remaining one.
      * Markdown and JSON get no stripping — neither has comment syntax.
      * A triple-quoted block used as DATA rather than prose (a heredoc-ish
        SQL blob) is treated as prose, so a host inside one does not deny.
        Rare, and it fails in the permissive direction like the rest.

    Retaining text is permissive for the DENIAL pass — at worst an extra
    host to register, which is cheap and reviewed, never a missed
    destination. It is NOT harmless for the BACKING pass: a comment that
    survives stripping BACKS an entry, so the entry stops being reported as
    unreferenced and the registry quietly keeps describing code that is not
    there. That is the failure WARP-2516 found and fixed for regex literals,
    and it is why a new limit here needs the backing direction thought
    through, not just the denial one.
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
        # SQL line comment (WARP-2487). `--` inside a literal is protected by
        # the quote tracking above, exactly as `//` and `#` already are.
        if dashes and ch == "-" and i + 1 < n and text[i + 1] == "-":
            while i < n and text[i] != "\n":
                i += 1
            continue
        # Regex literal (WARP-2516). Checked AFTER the two comment branches,
        # which own `//` and `/*`. Its characters are still YIELDED, with
        # in_string=False: a regex is code, so the backing pass must keep
        # seeing it (`/files.allowed-vendor.com/` really is the code naming
        # that host), while the denial pass, which reads only in_string=True,
        # correctly declines to treat it as a string literal. What changes is
        # only that a quote inside can no longer open one.
        if slashes and ch == "/" and in_regex_position(text, i):
            end = regex_literal_end(text, i)
            if end is not None:
                for c in text[i:end]:
                    yield c, False
                i = end
                continue
        yield ch, False
        i += 1


def strip_comments(text: str, slashes: bool, hashes: bool,
                   dashes: bool = False) -> str:
    """Comment-free `text`, for the BACKING pass (WARP-2452).

    A hostname in prose must not vouch for a registry entry. See
    scan_source for the walker and its accepted limits.
    """
    if not slashes and not hashes and not dashes:
        return text
    return "".join(ch for ch, _ in scan_source(text, slashes, hashes, dashes))


def string_literal_lines(text: str, slashes: bool, hashes: bool,
                         dashes: bool = False) -> list[list[str]]:
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
    for ch, in_string in scan_source(text, slashes, hashes, dashes):
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


def declared_hosts(entry: dict) -> dict[str, str]:
    """{host: reason} that `entry`'s no_code_literal covers (WARP-2487).

    The declaration used to be one string for the whole entry, which made a
    MIXED entry inexpressible. `cloud-llm-providers-optin` registers two
    hosts; if LiteLLM owned one of them and our own client dialled the other,
    declaring the flag would fail (a literal exists) and omitting it would
    pass (some host is backed) while nothing accounted for the SDK-owned one.
    Neither state is the truth, so the registry could only be wrong.

    Two accepted shapes, and the string form is unchanged:
      * `no_code_literal: <reason>`        — covers EVERY host of the entry.
      * `no_code_literal: {host: reason}`  — covers exactly the named hosts.
    """
    declared = entry.get("no_code_literal")
    hosts = [h.lower() for h in (entry.get("destination") or {}).get("hosts") or []]
    if declared is None:
        return {}
    if isinstance(declared, dict):
        return {str(h).lower(): str(r) for h, r in declared.items()}
    return {h: str(declared) for h in hosts}


def code_ref_literal_report(
    root: str, entry: dict
) -> tuple[list[str], list[str], list[str]]:
    """(backed_hosts, refs_checked, unreadable_refs) for an entry.

    PER HOST since WARP-2487 — the loop used to return on the first hit, so
    an entry with two hosts only ever reported one of them and the caller
    could not tell a fully-backed entry from a half-backed one.

    The ENTRY is still satisfied when ANY host is backed. Per-host
    *satisfaction* would fail honest entries whose extra hosts are redirect
    targets never named in code (objects.githubusercontent.com); that
    WARP-2452 judgement stands. What is now per host is the `no_code_literal`
    CLAIM, which is a statement about a specific destination and was never
    really an entry-level fact.
    """
    hosts = [h.lower() for h in (entry.get("destination") or {}).get("hosts") or []]
    refs = entry.get("code_refs") or []
    unreadable: list[str] = []
    backed: list[str] = []
    bodies: list[str] = []
    for ref in refs:
        try:
            with open(os.path.join(root, ref), encoding="utf-8",
                      errors="ignore") as fh:
                raw = fh.read()
        except OSError:
            unreadable.append(ref)
            continue
        slashes, hashes, dashes = comment_styles(ref)
        bodies.append(strip_comments(raw, slashes, hashes, dashes))
    for host in hosts:
        if any(host_literal_in(host, body) for body in bodies):
            backed.append(host)
    return backed, refs, unreadable


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


def entry_id_lines(text: str) -> dict[str, list[int]]:
    """{entry id: [1-based line numbers]} straight from the YAML nodes.

    yaml.safe_load throws line information away, and a duplicate `id:` is not
    a duplicate MAPPING key — it is two perfectly valid list items that happen
    to name the same slug — so nothing in the parser objects. PR #1828 carried
    two byte-identical `hubspot-api` blocks and the gate printed
    `OK — 41 registry entries`. Line numbers come from the node stream rather
    than a regex over the raw text so the report stays right whatever
    indentation or flow style an entry is written in.
    """
    lines: dict[str, list[int]] = defaultdict(list)
    try:
        root_node = yaml.compose(text)
    except yaml.YAMLError:
        return {}
    if root_node is None:
        return {}
    for key, value in getattr(root_node, "value", []):
        if getattr(key, "value", None) != "entries":
            continue
        for item in getattr(value, "value", []):
            for k, v in getattr(item, "value", []):
                if getattr(k, "value", None) == "id":
                    lines[str(v.value)].append(v.start_mark.line + 1)
    return dict(lines)


def duplicate_id_report(entries: list[dict], text: str) -> list[str]:
    """One formatted failure line per id that appears more than once."""
    seen: dict[str, int] = defaultdict(int)
    for e in entries:
        seen[str(e.get("id"))] += 1
    at = entry_id_lines(text)
    out: list[str] = []
    for entry_id, count in sorted(seen.items()):
        if count < 2:
            continue
        where = at.get(entry_id) or []
        located = (", ".join(f"{ALLOWLIST_PATH}:{n}" for n in where)
                   if where else "(line numbers unavailable)")
        out.append(f"  {entry_id}: declared {count} times — {located}")
    return out


def load_allowlist(root: str) -> tuple[list[dict], set[str], list[str]]:
    path = os.path.join(root, ALLOWLIST_PATH)
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        doc = yaml.safe_load(text)
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
            hosts = [h.lower()
                     for h in (e.get("destination") or {}).get("hosts") or []]
            if isinstance(declared, dict):
                # Per-host form (WARP-2487). A key that is not one of the
                # entry's own hosts exempts nothing and reads as though it
                # does, so it is a config error rather than a silent no-op.
                for host, reason in declared.items():
                    if str(host).lower() not in hosts:
                        print(f"ERROR: entry '{e['id']}' declares "
                              f"no_code_literal for '{host}', which is not "
                              f"one of its destination.hosts", file=sys.stderr)
                        sys.exit(2)
                    if not isinstance(reason, str) or not reason.strip():
                        print(f"ERROR: entry '{e['id']}' no_code_literal["
                              f"'{host}'] must be a non-empty reason naming "
                              f"who owns the destination", file=sys.stderr)
                        sys.exit(2)
            elif not isinstance(declared, str) or not declared.strip():
                print(f"ERROR: entry '{e['id']}' no_code_literal must be a "
                      f"non-empty reason naming who owns the destination, or "
                      f"a host->reason mapping", file=sys.stderr)
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
    return entries, patterns, duplicate_id_report(entries, text)


def check_psl_freshness(path: str, today: str | None = None) -> int:
    """Drift gate for the vendored Public Suffix List (WARP-2487).

    The snapshot decides what the whole bare-host pass treats as a hostname,
    so it is exactly the kind of committed artefact this repo requires an
    explicit drift gate for rather than trust. Age is read from the
    snapshot's OWN `// VERSION: YYYY-MM-DD_...` line, which upstream stamps —
    not from a header we would maintain by hand and could therefore refresh
    without refreshing the data, and not from the file's mtime, which a fresh
    clone resets to checkout time and would report as permanently current.

    Offline by construction. `--today` exists so the suite can pin both sides
    of the boundary against a fixed snapshot instead of a fixture whose date
    is computed from the clock it is being compared to.
    """
    from datetime import date

    stamped = psl_snapshot_date(path)
    if stamped is None:
        print(f"ERROR: {path} has no '// VERSION: YYYY-MM-DD' line — cannot "
              f"tell how old the suffix list is. Re-run "
              f"scripts/fetch-public-suffix-list.sh.", file=sys.stderr)
        return 2
    try:
        snapshot = date(*(int(p) for p in stamped.split("-")))
        now = date(*(int(p) for p in today.split("-"))) if today else date.today()
    except (TypeError, ValueError) as exc:
        print(f"ERROR: bad date ({exc})", file=sys.stderr)
        return 2
    age = (now - snapshot).days
    if age > PSL_MAX_AGE_DAYS:
        print(f"PUBLIC SUFFIX LIST STALE: {path}\nis dated {stamped}, "
              f"{age} days old (limit {PSL_MAX_AGE_DAYS}).\n\n"
              f"The list decides what this gate treats as a hostname, so a "
              f"stale snapshot\nmeans destinations on newly delegated TLDs "
              f"are invisible to the denial pass.\nRefresh it:\n"
              f"  ./scripts/fetch-public-suffix-list.sh\n"
              f"then commit the result. The PR needs security review (assign "
              f"Romain).", file=sys.stderr)
        return 1
    print(f"public-suffix snapshot OK — dated {stamped}, {age} days old "
          f"(limit {PSL_MAX_AGE_DAYS}).")
    return 0


def host_allowed(host: str, patterns: set[str]) -> bool:
    if host in patterns:
        return True
    return any(p.startswith("*.") and fnmatch(host, p) for p in patterns)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo-root", default=None)
    ap.add_argument("--list-hosts", action="store_true",
                    help="print every extracted host and exit 0")
    ap.add_argument("--check-psl-freshness", action="store_true",
                    help="fail if the vendored Public Suffix List snapshot is "
                         f"older than {PSL_MAX_AGE_DAYS} days (offline; reads "
                         "the snapshot's own VERSION line)")
    ap.add_argument("--psl-path", default=PSL_PATH,
                    help="snapshot to check (tests point this at a fixture)")
    ap.add_argument("--today", default=None,
                    help="YYYY-MM-DD to measure the snapshot's age against; "
                         "defaults to the real date")
    args = ap.parse_args()

    if args.check_psl_freshness:
        return check_psl_freshness(args.psl_path, args.today)

    root = args.repo_root or subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=True).stdout.strip()

    found = extract(root, tracked_files(root))
    if args.list_hosts:
        for host in sorted(found):
            locs = sorted(found[host])
            print(f"{host}  ({len(locs)} refs, e.g. {locs[0][0]}:{locs[0][1]})")
        return 0

    entries, patterns, dup_failures = load_allowlist(root)

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
        backed, refs, unreadable = code_ref_literal_report(root, e)
        declared = declared_hosts(e)
        all_hosts = [h.lower()
                     for h in (e.get("destination") or {}).get("hosts") or []]
        hosts = ", ".join(all_hosts)
        # PER HOST (WARP-2487). Two independent questions, and the old
        # per-entry flag conflated them:
        #   * a declared host that IS a literal — the claim is false, and now
        #     EVERY such host is named, not just whichever the loop hit first;
        #   * an undeclared host with nothing backing the entry at all.
        contradicted = [h for h in backed if h in declared]
        unexcused = [h for h in all_hosts if h not in backed and h not in declared]
        if contradicted:
            ref_failures.append(
                f"  {e['id']}: declares no_code_literal for "
                f"{', '.join(repr(h) for h in contradicted)}, but "
                f"{'they are' if len(contradicted) > 1 else 'it is'} a "
                f"non-comment\n    literal in its code_refs — drop the "
                f"declaration for {'those hosts' if len(contradicted) > 1 else 'that host'}"
                f", the code backs "
                f"{'them' if len(contradicted) > 1 else 'it'}.")
        elif not backed and unexcused:
            detail = (f"  {e['id']}: no host of [{hosts}] appears as a "
                      f"non-comment literal\n    in code_refs: "
                      f"{', '.join(refs) if refs else '(none listed)'}"
                      f"\n    undeclared: {', '.join(unexcused)}")
            if unreadable:
                detail += f"\n    unreadable code_refs: {', '.join(unreadable)}"
            ref_failures.append(detail)

    if (not violations and not ref_failures and not scope_failures
            and not dup_failures):
        print(f"egress-gate OK — {len(found)} distinct hosts, all allowlisted "
              f"({len(entries)} registry entries).")
        return 0

    if dup_failures:
        print(f"\nDUPLICATE ALLOWLIST ENTRY: {len(dup_failures)} id(s) in "
              f"{ALLOWLIST_PATH}\ndeclared more than once\n", file=sys.stderr)
        for detail in dup_failures:
            print(detail, file=sys.stderr)
        print(
            "\nAn id is the registry's handle for one reviewed destination:\n"
            "docs cite it, review comments cite it, and a future entry-level\n"
            "rule keys on it. Two blocks sharing one id means half the pair is\n"
            "invisible — YAML is happy, both blocks load, and a reviewer\n"
            "reading the file sees whichever they scroll to first. That is how\n"
            "PR #1828 shipped two 'hubspot-api' blocks under a green\n"
            "`OK -- 41 registry entries`. Resolve by deleting the duplicate,\n"
            "or by giving the second destination its own id and purpose.\n"
            "Touching the allowlist needs security review (assign Romain).\n",
            file=sys.stderr)

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
