"""Bridge-held allowlist of registered statement shapes (WARP-2540).

WHY THIS EXISTS
---------------
The wire contract says `req.sql` is an already-built, parameterized statement
from the registries in `@droplet/erp-connector` — but until now the bridge had
no way to check that, so `/read/{name}` and `/write/{name}` executed whatever
SQL text the wire carried (CodeQL's finding, and the real exposure: any process
that can reach this container on the compose network could run arbitrary
statements under the practice's grants). This module makes the registry claim
enforceable ON the bridge, where the connection lives.

WHY A SHAPE, NOT A TEXT OR A HASH
---------------------------------
A registry statement is a fixed template with two degrees of freedom:
PHYSICAL identifiers (resolved per practice through the introspected schema
map, always double-quoted) and bound values (always `?`, never inline). The
template is the invariant — so the manifest registers the template.
`normalize_statement` masks every double-quoted identifier to `<id>` and
collapses whitespace; the result must equal a registered skeleton for the
named statement EXACTLY, character for character. Everything an injection
needs — an extra predicate, a UNION, a comment, a second statement, a changed
verb — survives normalization and misses the skeleton. Identifier NAMES stay
free (the server still resolves them against the real schema); identifier
QUOTING is what confines them: inside `"…"` a payload is an identifier token,
never syntax.

FAIL CLOSED
-----------
* Name not registered for the route → UNKNOWN_STATEMENT.
* SQL that does not normalize to a registered skeleton (including anything
  with an unterminated quote or a literal `<id>` marker) → STATEMENT_MISMATCH.
* Manifest missing or malformed → ManifestError at import: a bridge that
  cannot prove what it may run does not start.

Both refusals happen in `main.py` before any pool acquire. The pre-existing
single-statement and SELECT/non-SELECT guards stay in place as the second
layer, and the database grants remain the last one.

KEPT IN SYNC
------------
`services/erp-connector/__tests__/statement-manifest-sync.test.ts` rebuilds
every registered statement from the actual registries and fails if this
manifest drifts — so a registry change that forgets the manifest breaks CI,
not a customer. This is deliberately NOT a second definition of the SQL
(db.py's "never build SQL here" rule): the skeletons prove what the registry
emitted; they cannot be executed and no code path assembles SQL from them.
"""
from __future__ import annotations

import json
from pathlib import Path

STATEMENT_MANIFEST_PATH = Path(__file__).resolve().parent / "statement_manifest.json"

UNKNOWN_STATEMENT = "UNKNOWN_STATEMENT"
STATEMENT_MISMATCH = "STATEMENT_MISMATCH"

_ID_MARK = "<id>"


class ManifestError(RuntimeError):
    """The shipped statement manifest is missing or malformed."""


def normalize_statement(sql: str) -> str | None:
    """Mask double-quoted identifiers to `<id>`, collapse whitespace.

    Returns None when the statement cannot be normalized — an unterminated
    quoted identifier, or a raw `<id>` marker in the input (which could only
    exist to impersonate a masked identifier). None is never a match, so the
    caller refuses (fail closed).

    Single-quoted literals are NOT masked: the only literal a registry
    statement carries is `ESCAPE '\\'`, and keeping literals verbatim means an
    attacker cannot smuggle one in anywhere the skeleton has none.
    """
    if _ID_MARK in sql:
        return None
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == '"':
            j = i + 1
            while j < n:
                if sql[j] == '"':
                    if j + 1 < n and sql[j + 1] == '"':
                        j += 2  # doubled quote: still inside the identifier
                        continue
                    break
                j += 1
            if j >= n:
                return None  # unterminated identifier
            out.append(_ID_MARK)
            i = j + 1
        else:
            out.append(ch)
            i += 1
    return " ".join("".join(out).split())


def _load(path: Path) -> tuple[dict[str, tuple[str, ...]], dict[str, tuple[str, ...]]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ManifestError(f"statement manifest missing: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ManifestError(f"statement manifest unreadable: {exc}") from exc

    def section(kind: str) -> dict[str, tuple[str, ...]]:
        entries = raw.get(kind)
        if not isinstance(entries, dict) or not entries:
            raise ManifestError(f"manifest section {kind!r} is missing or empty")
        out: dict[str, tuple[str, ...]] = {}
        for name, skeletons in entries.items():
            if (
                not isinstance(skeletons, list)
                or not skeletons
                or not all(isinstance(s, str) and s for s in skeletons)
            ):
                raise ManifestError(f"manifest entry {kind}/{name}: not a non-empty list of skeletons")
            for s in skeletons:
                # Normal form = no unmasked identifier, whitespace collapsed.
                # A skeleton outside normal form could never match anything —
                # a silently dead allowlist entry — so refuse to start on it.
                if '"' in s or " ".join(s.split()) != s:
                    raise ManifestError(f"manifest skeleton for {kind}/{name} is not in normal form")
            out[name] = tuple(skeletons)
        return out

    return section("reads"), section("writes")


READS, WRITES = _load(STATEMENT_MANIFEST_PATH)


def check_statement(kind: str, name: str, sql: str) -> str | None:
    """None when `sql` is a registered `kind` statement for `name`; otherwise
    the refusal code. Reads and writes are separate namespaces — a read name
    is unknown on the write route, whatever its SQL says."""
    table = READS if kind == "read" else WRITES
    skeletons = table.get(name)
    if skeletons is None:
        return UNKNOWN_STATEMENT
    normalized = normalize_statement(sql)
    if normalized is None or normalized not in skeletons:
        return STATEMENT_MISMATCH
    return None
