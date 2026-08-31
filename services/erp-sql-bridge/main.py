"""
Droplet ERP SQL bridge (WARP-1106)
==================================
The DB-touching half of the direct-SQL ERP track: unixODBC + pyodbc against a
practice's SAP SQL Anywhere database, behind the internal REST contract the
orchestrator already expects (services/erp-connector/README.md).

REACHABLE ONLY ON THE INTERNAL COMPOSE NETWORK. It is never published off-box:
it holds the practice's database credentials and executes statements against a
system of record. The orchestrator is the only caller; the dashboard talks to
the orchestrator, and the LLM reaches reads through tools-core handlers.

THE SAFETY MODEL, AND WHERE IT ACTUALLY LIVES
---------------------------------------------
Three layers, outermost first:

1. THE STATEMENT ALLOWLIST (WARP-2540, allowlist.py). `/read/{name}` and
   `/write/{name}` refuse any statement that is not, shape-for-shape, the one
   the registries in `@droplet/erp-connector` emit for that name. Before this
   layer the bridge TRUSTED the wire to carry registry-built SQL (CodeQL's
   finding: both routes executed a caller-supplied string); now it checks,
   fail-closed, before any pool acquire.
2. The route-level assertions: exactly one statement
   (`_is_single_statement`), and the right kind of statement (`_is_select`).
   These are two SEPARATE properties and every route checks both — see the
   note on `_is_single_statement` for the bug that combining them produced.
3. The DATABASE GRANT. `droplet_ro` holds SELECT and nothing else, so a read
   connection physically cannot write even if every check here were removed.

Statements arrive already built. See db.py for why they are not built here.
"""
from __future__ import annotations

import logging
import os
import sys as _sys
import time
from contextlib import asynccontextmanager
from typing import Any

# WARP-229: FIPS 140-3 boot self-test. Env-gated; same contract as the other
# Python services.
_sys.path.insert(0, "/app")
try:
    from _shared.fips_selftest import gated_assert_fips_at_boot  # type: ignore

    gated_assert_fips_at_boot("erp-sql-bridge")
except ImportError:
    pass

import pyodbc
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from allowlist import STATEMENT_MISMATCH, UNKNOWN_STATEMENT, check_statement
from db import (
    BridgeConfigError,
    ConnectionPool,
    Target,
    UpstreamUnavailable,
    default_target,
    redact,
    rows_to_dicts,
)
from schemas import ExecRequest, IntrospectRequest

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("erp-sql-bridge")

POOL = ConnectionPool(
    max_per_key=int(os.environ.get("ERP_DB_POOL_MAX", "4")),
    timeout_s=int(os.environ.get("ERP_DB_TIMEOUT_S", "10")),
)

# Purely observational: the orchestrator surfaces "synced N min ago" from it.
_STATE: dict[str, Any] = {"last_read_at": None}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    POOL.close_all()


app = FastAPI(title="Droplet ERP SQL bridge", version="1.0.0", lifespan=lifespan)


def _target_from(req: ExecRequest | IntrospectRequest) -> Target:
    """Caller may name the box; it may never name the identity.

    Falling back to the deploy-time target keeps the single-practice-per-box
    deployment working with no per-request config, while still letting the
    setup wizard point at a host the operator typed.
    """
    if req.target is not None:
        return Target(
            host=req.target.host,
            port=req.target.port,
            server_name=req.target.serverName,
            database_name=req.target.databaseName,
        )
    return default_target()


# Comments are stripped before ANY classification, so `/*SELECT*/ UPDATE ...`
# cannot masquerade as a read.
#
# CodeQL py/polynomial-redos (alerts #63/#64): this used to be two regexes —
# `/\*.*?\*/|--[^\n]*` for comments and `[\s;]+$` for trailing terminators —
# and both backtrack quadratically on request-controlled SQL (an unclosed `/*`
# followed by many `a/*`, or a long run of tabs before a non-terminator: ~7 s
# at 50k chars, measured). It is now one left-to-right scan; no regex touches
# the statement at all.


def _strip_comments_and_mask_literals(sql: str) -> str:
    """One linear pass: block/line comments become a single space, single-quoted
    literals become `''` (a doubled quote inside a literal stays inside it).

    Doing both in ONE pass — rather than comments first and literals second, as
    the regex version did — also closes a bypass that ordering had: a `--`
    INSIDE a literal (`SET reason = '--'; DROP ...`) swallowed the rest of the
    line, semicolon included, before the literal mask ever saw it, so a stacked
    write read as a single statement. Lexed together, a quote opens a literal
    and nothing inside it is a comment, and vice versa.

    Unterminated constructs are left as-is so a stray `;` inside them still
    counts as a separator (fail closed, same as before).
    """
    out: list[str] = []
    i, n = 0, len(sql)
    # Once a `/*` has no closing `*/` anywhere after it, no later `/*` has one
    # either — remember that instead of re-scanning to the end for every
    # opener, which is exactly the quadratic behaviour this replaces.
    block_may_close = True
    while i < n:
        ch = sql[i]
        if ch == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            if j >= n:
                out.append(sql[i:])  # unterminated literal: keep it visible
                break
            out.append("''")
            i = j + 1
        elif ch == "/" and block_may_close and sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            if end == -1:
                block_may_close = False
                out.append(ch)
                i += 1
            else:
                out.append(" ")
                i = end + 2
        elif ch == "-" and sql.startswith("--", i):
            end = sql.find("\n", i)
            out.append(" ")
            i = n if end == -1 else end  # the newline itself is kept
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _bare(sql: str) -> str:
    """Comments removed, string literals masked, trailing terminators removed.

    "Trailing terminators" means any run of semicolons and whitespace at the
    very end — `;`, `;;;`, and `; ; ` all normalize the same way. They are
    empty statements, not a second real one, so accepting them is correct; what
    matters is that the three spellings agree. A plain `.rstrip(";")` did not:
    it collapsed `;;;` but left `; ; ` holding a semicolon, so two inputs with
    identical meaning got opposite verdicts purely on spacing (review nit,
    verified). Only the END is stripped — an interior `;` is exactly the
    separator this is looking for and must survive.

    Literals are masked in the same pass as comments, so a semicolon INSIDE a
    value ('x;y') is not mistaken for a separator either.
    """
    bare = _strip_comments_and_mask_literals(sql).strip()
    end = len(bare)
    while end and (bare[end - 1] == ";" or bare[end - 1].isspace()):
        end -= 1
    return bare[:end]


def _is_single_statement(sql: str) -> bool:
    """Exactly one statement — no unquoted semicolon survives.

    Deliberately INDEPENDENT of what kind of statement it is. An earlier
    revision folded this into the is-a-SELECT check, which meant a non-SELECT
    short-circuited out before the stacking test ever ran: `/write/*` (whose
    only guard is "reject if it IS a select") then accepted
    `UPDATE ...; UPDATE ...` and executed both, while reporting `cursor.rowcount`
    from the last one only — a response that understated what it had changed.
    Found in review; the property is now asserted on every route.
    """
    return ";" not in _bare(sql)


def _is_select(sql: str) -> bool:
    """Anchored on the first keyword, after comment stripping."""
    return _bare(sql).lower().startswith("select")


def _fail(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": redact(message)})


def _assert_statement_registered(kind: str, name: str, sql: str) -> None:
    """WARP-2540 — the first layer, run before anything else on both execute
    routes. The wire may only carry a statement the registries emit for
    `name`; the shipped manifest (statement_manifest.json) is the proof, and
    an unknown name or a mismatched shape is refused before a connection is
    even acquired. Identifier NAMES stay free — the schema map resolves them
    per practice and the server checks they exist — but the statement's shape
    may not vary by one character."""
    code = check_statement(kind, name, sql)
    if code is None:
        return
    logger.warning("refused %s '%s': %s", kind, name, code)
    if code == UNKNOWN_STATEMENT:
        raise _fail(400, UNKNOWN_STATEMENT, f"{kind} '{name}' is not a registered statement")
    raise _fail(
        400,
        STATEMENT_MISMATCH,
        f"{kind} '{name}' does not match its registered statement shape",
    )


def _assert_single_statement(what: str, name: str, sql: str) -> None:
    """Every route runs exactly one statement. A batch is always a caller bug:
    the registries emit one statement per named operation, so more than one
    means something built SQL by concatenation."""
    if not _is_single_statement(sql):
        raise _fail(
            400,
            "NOT_A_SINGLE_STATEMENT",
            f"{what} '{name}' was handed more than one statement",
        )


@app.get("/health")
def health() -> dict[str, Any]:
    """SELECT 1-class probe. Reports reachability honestly — a bridge that is
    running but cannot reach the practice is NOT ok, because reporting
    otherwise is how a dashboard ends up showing a green light over a dead
    connection."""
    try:
        target = default_target()
    except BridgeConfigError as exc:
        return {"ok": False, "reason": "NOT_CONFIGURED", "message": str(exc), "pool": POOL.stats()}

    conn = None
    try:
        conn = POOL.acquire(target, "read")
        conn.cursor().execute("SELECT 1").fetchone()
        POOL.release(target, "read", conn)
        return {
            "ok": True,
            "target": target.key(),
            "lastReadAt": _STATE["last_read_at"],
            "pool": POOL.stats(),
        }
    except (UpstreamUnavailable, BridgeConfigError, pyodbc.Error) as exc:
        if conn is not None:
            POOL.release(target, "read", conn, discard=True)
        return {
            "ok": False,
            "reason": "UPSTREAM_UNAVAILABLE",
            "message": redact(str(exc)),
            "pool": POOL.stats(),
        }


@app.post("/read/{name}")
def run_read(name: str, req: ExecRequest) -> dict[str, Any]:
    """Execute one already-built, parameterized SELECT as `droplet_ro`.

    `name` is the registry query name. It selects which registered statement
    shape the wire SQL must match (WARP-2540) — it is still never used to
    build anything — and it keeps logs and errors saying which named read
    failed, rather than leaving an operator to reverse-engineer it from SQL.
    """
    _assert_statement_registered("read", name, req.sql)
    # Second layer. Any statement the allowlist accepts is a single SELECT by
    # construction (tests pin that over the whole manifest); these stay so a
    # manifest bug fails loudly here instead of reaching a connection.
    _assert_single_statement("read", name, req.sql)
    if not _is_select(req.sql):
        raise _fail(400, "NOT_A_READ", f"read '{name}' was handed a non-SELECT statement")

    conn = None
    started = time.monotonic()
    try:
        # Inside the try: an unconfigured box with no per-request target must
        # answer NOT_CONFIGURED like the health route does, not a raw 500.
        target = _target_from(req)
        conn = POOL.acquire(target, "read")
        cursor = conn.cursor()
        cursor.execute(req.sql, *tuple(req.params))
        rows = rows_to_dicts(cursor)
        conn.rollback()  # read-only: end the implicit transaction cleanly
        POOL.release(target, "read", conn)
        _STATE["last_read_at"] = time.time()
        logger.info(
            "read %s -> %d rows in %dms", name, len(rows), int((time.monotonic() - started) * 1000)
        )
        return {"rows": rows, "rowCount": len(rows)}
    except UpstreamUnavailable as exc:
        raise _fail(503, "UPSTREAM_UNAVAILABLE", str(exc)) from None
    except BridgeConfigError as exc:
        raise _fail(503, "NOT_CONFIGURED", str(exc)) from None
    except pyodbc.Error as exc:
        if conn is not None:
            POOL.release(target, "read", conn, discard=True)
        # No row data in the message — a failed query's error text can echo
        # bound parameter values, which on this track are patient identifiers.
        raise _fail(502, "QUERY_FAILED", f"read '{name}' failed: {exc.args[0] if exc.args else exc}") from None


@app.post("/write/{name}")
def apply_write(name: str, req: ExecRequest) -> dict[str, Any]:
    """Apply one already-built, parameterized write as `droplet_rw`, in ONE
    transaction.

    Returns the affected row count without committing anything the caller did
    not ask for. A zero row count is NOT an error — it is the optimistic
    concurrency guard reporting that the row changed underneath us, which the
    orchestrator maps to DISCREPANCY rather than retrying blindly over a
    front-desk edit.
    """
    _assert_statement_registered("write", name, req.sql)
    # Second layer. Order still matters within it: the batch check runs
    # before the kind check, so a stacked write cannot slip past a guard that
    # only knows how to say "this is a SELECT".
    _assert_single_statement("write", name, req.sql)
    if _is_select(req.sql):
        raise _fail(400, "NOT_A_WRITE", f"write '{name}' was handed a SELECT")

    conn = None
    try:
        # Inside the try — same NOT_CONFIGURED honesty as /read/*.
        target = _target_from(req)
        conn = POOL.acquire(target, "write")
        cursor = conn.cursor()
        cursor.execute(req.sql, *tuple(req.params))
        affected = cursor.rowcount
        conn.commit()
        POOL.release(target, "write", conn)
        logger.info("write %s -> %s rows affected", name, affected)
        return {"rowCount": affected, "applied": affected > 0}
    except UpstreamUnavailable as exc:
        raise _fail(503, "UPSTREAM_UNAVAILABLE", str(exc)) from None
    except BridgeConfigError as exc:
        raise _fail(503, "NOT_CONFIGURED", str(exc)) from None
    except pyodbc.Error as exc:
        if conn is not None:
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001
                pass
            POOL.release(target, "write", conn, discard=True)
        raise _fail(502, "WRITE_FAILED", f"write '{name}' failed: {exc.args[0] if exc.args else exc}") from None


@app.post("/introspect")
def introspect(req: IntrospectRequest) -> dict[str, Any]:
    """Run the caller-supplied catalog queries and return the raw rows.

    The catalog SQL is dialect-specific (SYS.SYSTAB / SYS.SYSTABCOL on SA10+,
    SYSTABLE / SYSCOLUMN on ASA7) and the TypeScript side already knows which
    dialect it detected, so it supplies the statements. Fingerprinting happens
    there too, against the same `computeSchemaFingerprint` the drift check uses
    — computing a second hash here would be a second definition of "the schema
    changed".
    """
    # Same guard as /read/*, for the same reason: this route also runs on the
    # read connection, so a non-SELECT here is a caller bug that should fail by
    # name rather than as a server-side permission error. (The grant is still
    # what makes it impossible; this makes it obvious.)
    for label, statement in req.queries.items():
        _assert_single_statement("introspection query", label, statement.sql)
        if not _is_select(statement.sql):
            raise _fail(400, "NOT_A_READ", f"introspection query '{label}' is not a SELECT")

    conn = None
    try:
        # Inside the try — same NOT_CONFIGURED honesty as /read/*.
        target = _target_from(req)
        conn = POOL.acquire(target, "read")
        out: dict[str, list[dict[str, Any]]] = {}
        for label, statement in req.queries.items():
            cursor = conn.cursor()
            cursor.execute(statement.sql, *tuple(statement.params))
            out[label] = rows_to_dicts(cursor)
        conn.rollback()
        POOL.release(target, "read", conn)
        return {"results": out}
    except UpstreamUnavailable as exc:
        raise _fail(503, "UPSTREAM_UNAVAILABLE", str(exc)) from None
    except BridgeConfigError as exc:
        raise _fail(503, "NOT_CONFIGURED", str(exc)) from None
    except pyodbc.Error as exc:
        if conn is not None:
            POOL.release(target, "read", conn, discard=True)
        raise _fail(502, "QUERY_FAILED", f"introspection failed: {exc.args[0] if exc.args else exc}") from None


@app.exception_handler(HTTPException)
async def http_exception_handler(_request, exc: HTTPException):  # type: ignore[override]
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "ERROR", "message": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content=detail)
