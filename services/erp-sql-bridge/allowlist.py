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
`normalize_statement` masks double-quoted identifiers to `<id>` and collapses
whitespace; the result must equal a registered skeleton for the named
statement EXACTLY, character for character. Everything an injection needs —
an extra predicate, a UNION, a comment, a second statement, a changed verb —
survives normalization and misses the skeleton. Identifier QUOTING is what
confines what is left: inside `"…"` a payload is an identifier token, never
syntax.

WHY THE TABLE IS NOT MASKED (WARP-2874)
---------------------------------------
Masking EVERY identifier made the skeleton say nothing about what a statement
reads, and several registered statements share a shape: `get_open_invoices`
(AR, `invoice`) and `get_open_bills` (AP, `bill`) are both seven columns, one
`<> 0` predicate and two ORDER BY terms. So `POST /read/get_open_invoices`
carrying bill SQL passed — and so did any other seven-column table
`droplet_ro` can see. The name in the route, the audit log and the capability
gate all claimed one thing while the bridge ran another.

So the skeleton now carries the TABLE verbatim: in a qualified
`"owner"."table"` the owner is masked (it genuinely varies — "dba" is only the
stock install) and the table is not. That is sound because the registries do
not rename anything: `buildSchemaMap` keys the map by the PHYSICAL table name
and `resolveTable`/`resolveColumn` return what they looked up, so a registered
statement always emits the vocabulary the registry declares — a practice whose
table is spelled differently has no mapping and the query is unavailable, with
or without this check.

Columns stay masked. Pinning them too would multiply the write manifest by
every SET-column subset for no new confinement worth the entry count: within
one table, the grant is the boundary. If a column-level confusion ever
matters, unmask them the same way and regenerate the manifest.

INTROSPECTION IS ALLOWLISTED TOO (WARP-2874)
--------------------------------------------
`/introspect` used to run whatever SELECT the wire carried — the whole point
of the allowlist, missing on the one route that never called it. It is checked
by SHAPE ONLY, with no name: the caller LABELS each query (the column pass
labels by table name), so a label is data and can carry no authority. The
registered set is the catalog SQL `erp-connector/src/introspection.ts` emits,
both dialect families, because which one runs is decided by the engine version
the TypeScript side detected.

FAIL CLOSED
-----------
* Name not registered for the route → UNKNOWN_STATEMENT.
* SQL that does not normalize to a registered skeleton (including anything
  with an unterminated quote or a literal `<id>` marker) → STATEMENT_MISMATCH.
* Manifest missing or malformed → ManifestError at import: a bridge that
  cannot prove what it may run does not start.

All three refusals happen in `main.py` before any pool acquire. The
pre-existing single-statement and SELECT/non-SELECT guards stay in place as
the second layer, and the database grants remain the last one.

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


def _end_of_identifier(sql: str, start: int) -> int | None:
    """Index of the closing `"` of the identifier opening at `start`, or None
    when it is never closed. A doubled `""` is an escaped quote INSIDE the
    identifier, not the end of it."""
    j = start + 1
    n = len(sql)
    while j < n:
        if sql[j] == '"':
            if j + 1 < n and sql[j + 1] == '"':
                j += 2  # doubled quote: still inside the identifier
                continue
            return j
        j += 1
    return None


def normalize_statement(sql: str) -> str | None:
    """Mask double-quoted identifiers to `<id>` — except a qualified name's
    table, which is kept verbatim (WARP-2874) — and collapse whitespace.

    Returns None when the statement cannot be normalized — an unterminated
    quoted identifier, an unterminated string literal, or a raw `<id>` marker
    in the input (which could only exist to impersonate a masked identifier).
    None is never a match, so the caller refuses (fail closed).

    Single-quoted literals are NOT masked: the only literal a registry
    statement carries is `ESCAPE '\\'`, and keeping literals verbatim means an
    attacker cannot smuggle one in anywhere the skeleton has none.

    They are, however, PARSED (WARP-2570). A `"` inside a `'...'` literal is
    inert data to a SQL engine, so the walker has to know it is inside one; a
    masker that tracks double-quote state alone would read that `"` as opening
    an identifier and mask from there to the next `"` — somewhere else
    entirely. That is a divergence between what this allowlist checks and what
    the database executes, in the one module whose job is to make those two
    agree, and it is the only thing standing in front of `cursor.execute`.
    Not reachable today (the manifest's sole literal is the fixed `ESCAPE '\\'`,
    which must match byte-for-byte), but it becomes reachable the moment any
    registered statement carries free single-quoted content.
    """
    if _ID_MARK in sql:
        return None
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == '"':
            j = _end_of_identifier(sql, i)
            if j is None:
                return None  # unterminated identifier
            i = j + 1
            # WARP-2874: `"owner"."table"` — mask the owner, keep the table.
            # Only the right half of a qualified pair is a table; a bare
            # identifier is a column as the registries emit them, and stays
            # masked.
            if sql[i : i + 2] == '."':
                k = _end_of_identifier(sql, i + 1)
                if k is None:
                    return None
                out.append(_ID_MARK)
                out.append(sql[i : k + 1])  # `."table"`, escaping intact
                i = k + 1
            else:
                out.append(_ID_MARK)
        elif ch == "'":
            # Copy the literal through verbatim, and — the point of this
            # branch — consume it as ONE span, so nothing inside it is read as
            # syntax. `''` is the only escape (a backslash is not one in a
            # standard-conforming literal, which is why `ESCAPE '\'` is a
            # complete two-character literal and not an escaped quote).
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2  # doubled quote: still inside the literal
                        continue
                    break
                j += 1
            if j >= n:
                return None  # unterminated literal — fail closed
            out.append(sql[i : j + 1])
            i = j + 1
        else:
            out.append(ch)
            i += 1
    return " ".join("".join(out).split())


def _load(path: Path) -> tuple[dict[str, tuple[str, ...]], ...]:
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
                # Normal form = whitespace collapsed, and no UNMASKED owner.
                # WARP-2874 put the table into the skeleton, so `"` is expected
                # now; `"."` is the tell that the owner was left in, which
                # would pin the entry to one install and match nothing anywhere
                # else — a silently dead allowlist entry. Refuse to start on it.
                if '"."' in s or " ".join(s.split()) != s:
                    raise ManifestError(f"manifest skeleton for {kind}/{name} is not in normal form")
            out[name] = tuple(skeletons)
        return out

    return section("reads"), section("writes"), section("introspect")


READS, WRITES, INTROSPECT = _load(STATEMENT_MANIFEST_PATH)

#: Introspection is matched by shape alone (see the module docstring), so the
#: names in the manifest are documentation for a human reading it — the check
#: is against this flattened set.
_INTROSPECT_SKELETONS = frozenset(s for skeletons in INTROSPECT.values() for s in skeletons)


def check_statement(kind: str, name: str, sql: str) -> str | None:
    """None when `sql` is a registered `kind` statement for `name`; otherwise
    the refusal code. Reads and writes are separate namespaces — a read name
    is unknown on the write route, whatever its SQL says.

    `kind` is an internal literal ("read"/"write" at the two route call
    sites); anything else is a bug that should surface as a KeyError, not be
    quietly routed to either table."""
    table = {"read": READS, "write": WRITES}[kind]
    skeletons = table.get(name)
    if skeletons is None:
        return UNKNOWN_STATEMENT
    normalized = normalize_statement(sql)
    if normalized is None or normalized not in skeletons:
        return STATEMENT_MISMATCH
    return None


def check_introspection(sql: str) -> str | None:
    """None when `sql` is one of the registered catalog statements; otherwise
    the refusal code (WARP-2874).

    No name is taken: `/introspect`'s labels are caller-chosen (the column pass
    labels by table name), so a label proves nothing and the shape is the whole
    check. STATEMENT_MISMATCH is the only refusal — there is no name to be
    unknown.
    """
    normalized = normalize_statement(sql)
    if normalized is None or normalized not in _INTROSPECT_SKELETONS:
        return STATEMENT_MISMATCH
    return None
