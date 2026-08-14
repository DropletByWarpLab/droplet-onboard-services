"""
ODBC connection management for the ERP SQL bridge (WARP-1106).

WHY THIS SERVICE EXISTS AT ALL
------------------------------
The orchestrator is TypeScript, and there is no viable modern Node driver for
SAP SQL Anywhere — the `sqlanywhere` npm addon is abandoned at a Node 12 ceiling
and does not build on the control plane. The supported Linux path is unixODBC +
`libdbodbc17_r.so`, driven from Python via pyodbc. So the DB-touching half lives
here, behind an internal REST contract, and the orchestrator stays
language-agnostic (see services/erp-connector/README.md).

WHAT THIS MODULE DELIBERATELY DOES NOT DO
-----------------------------------------
It does not know a single thing about Eaglesoft's schema, and it never builds
SQL. The canonical read/write registries live once, in TypeScript
(`@droplet/erp-connector`), where identifiers resolve through the introspected
schema map and every value binds as `?`. Re-deriving those queries in Python
would create a SECOND source of truth for what runs against a practice's
database — exactly the drift the schema-map/fingerprint design exists to
prevent. This module executes a parameterized statement it is handed, and
nothing more.

CREDENTIALS NEVER TRAVEL OVER THE WIRE
--------------------------------------
The caller may specify WHICH box to talk to (host/port/database — not secrets,
and they come from the IntegrationConnection row so the setup wizard stays
functional). It may never specify WHO to connect as. The `droplet_ro` /
`droplet_rw` passwords are read from this container's own environment and are
never accepted from, or echoed to, a caller.
"""
from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from typing import Any

import pyodbc

logger = logging.getLogger("erp-sql-bridge.db")


class BridgeConfigError(RuntimeError):
    """Raised when the bridge is missing configuration it cannot invent."""


class UpstreamUnavailable(RuntimeError):
    """The practice's database could not be reached or authenticated against.

    Deliberately distinct from a query error: the orchestrator maps this to the
    honest ERP_NOT_CONNECTED degradation path, whereas a malformed statement is
    a bug on our side and should surface loudly.
    """


@dataclass(frozen=True)
class Target:
    """Which database box to talk to. None of these are secrets."""

    host: str
    port: int = 2638
    server_name: str = "PattersonPM"
    database_name: str = "PattersonPM"

    def key(self) -> str:
        return f"{self.host}:{self.port}/{self.server_name}/{self.database_name}"


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def default_target() -> Target:
    """The box configured at deploy time (setup.sh writes these)."""
    host = _env("ERP_DB_HOST")
    if not host:
        raise BridgeConfigError(
            "ERP_DB_HOST is not set and the caller supplied no target — the bridge "
            "has no database to connect to."
        )
    return Target(
        host=host,
        port=int(_env("ERP_DB_PORT", "2638")),
        server_name=_env("ERP_DB_SERVER_NAME", "PattersonPM"),
        database_name=_env("ERP_DB_NAME", "PattersonPM"),
    )


def _credentials(identity: str) -> tuple[str, str]:
    """Resolve (user, password) for 'read' or 'write' from THIS container's env.

    Never accepted from a request. A missing write credential is normal — the
    write account is created unusable and only provisioned on opt-in — so it
    raises a config error rather than being silently substituted.
    """
    if identity == "read":
        user = _env("ERP_DB_RO_USER", "droplet_ro")
        password = _env("ERP_DB_RO_PASSWORD")
        if not password:
            raise BridgeConfigError("ERP_DB_RO_PASSWORD is not set")
        return user, password  # type: ignore[return-value]
    if identity == "write":
        user = _env("ERP_DB_RW_USER", "droplet_rw")
        password = _env("ERP_DB_RW_PASSWORD")
        if not password:
            raise BridgeConfigError(
                "ERP_DB_RW_PASSWORD is not set — writes are opt-in and the write "
                "account is created without grants until a capability is enabled."
            )
        return user, password  # type: ignore[return-value]
    raise BridgeConfigError(f"unknown identity {identity!r}")


def build_connection_string(target: Target, identity: str) -> str:
    """Assemble the ODBC connection string.

    `ERP_ODBC_DRIVER` selects the driver, which is what makes this service
    testable at all: in production it is the SAP client ("SQL Anywhere 17"),
    and the test suite points it at a PostgreSQL ODBC driver to exercise every
    line below against a real database without the license-gated SAP binaries.

    SQL Anywhere accepts `Host=` XOR `CommLinks=` — never both — so only `Host=`
    is emitted. `Encryption=NONE` is the documented default for a LAN link
    without server-side TLS; ERP_DB_ENCRYPTION overrides it where the server
    supports TLS.
    """
    user, password = _credentials(identity)
    driver = _env("ERP_ODBC_DRIVER", "SQL Anywhere 17")

    # Postgres ODBC (test lane) speaks a different keyword vocabulary than the
    # SAP client. Detected by driver name so production is never affected.
    if "postgres" in (driver or "").lower():
        return (
            f"DRIVER={{{driver}}};"
            f"SERVER={target.host};PORT={target.port};"
            f"DATABASE={target.database_name};"
            f"UID={user};PWD={password};"
        )

    parts = [
        f"DRIVER={{{driver}}}",
        f"Host={target.host}:{target.port}",
        f"ServerName={target.server_name}",
        f"DatabaseName={target.database_name}",
        f"UID={user}",
        f"PWD={password}",
        f"Encryption={_env('ERP_DB_ENCRYPTION', 'NONE')}",
    ]
    return ";".join(parts) + ";"


def redact(text: str) -> str:
    """Strip anything password-shaped out of a string before it is logged or
    returned. pyodbc puts the whole connection string into some error
    messages, so this is not theoretical."""
    out = []
    for chunk in str(text).split(";"):
        low = chunk.strip().lower()
        if low.startswith("pwd=") or low.startswith("password="):
            out.append(chunk.split("=", 1)[0] + "=***")
        else:
            out.append(chunk)
    return ";".join(out)


class ConnectionPool:
    """A tiny, explicit pool keyed by (identity, target).

    Deliberately not a generic pooling library: the access pattern is a handful
    of short reads from one box, and a dependency whose failure modes we would
    also have to learn is not worth it at this size. Connections are validated
    before reuse, because a practice server restarting overnight is the normal
    case, not the exception.
    """

    def __init__(self, max_per_key: int = 4, timeout_s: int = 10) -> None:
        self._idle: dict[str, list[pyodbc.Connection]] = {}
        self._lock = threading.Lock()
        self._max = max_per_key
        self._timeout = timeout_s

    @staticmethod
    def _pool_key(target: Target, identity: str) -> str:
        return f"{identity}@{target.key()}"

    def _connect(self, target: Target, identity: str) -> pyodbc.Connection:
        cs = build_connection_string(target, identity)
        try:
            conn = pyodbc.connect(cs, timeout=self._timeout, autocommit=False)
        except pyodbc.Error as exc:
            # Never let the raw message out: it can contain the full connection
            # string, password included.
            raise UpstreamUnavailable(redact(str(exc))) from None
        return conn

    def acquire(self, target: Target, identity: str) -> pyodbc.Connection:
        key = self._pool_key(target, identity)
        with self._lock:
            bucket = self._idle.get(key) or []
            while bucket:
                conn = bucket.pop()
                if self._alive(conn):
                    self._idle[key] = bucket
                    return conn
            self._idle[key] = bucket
        return self._connect(target, identity)

    def release(self, target: Target, identity: str, conn: pyodbc.Connection, *, discard: bool = False) -> None:
        key = self._pool_key(target, identity)
        if discard:
            self._close_quietly(conn)
            return
        with self._lock:
            bucket = self._idle.setdefault(key, [])
            if len(bucket) >= self._max:
                self._close_quietly(conn)
                return
            bucket.append(conn)

    @staticmethod
    def _alive(conn: pyodbc.Connection) -> bool:
        try:
            conn.cursor().execute("SELECT 1").fetchone()
            return True
        except Exception:
            ConnectionPool._close_quietly(conn)
            return False

    @staticmethod
    def _close_quietly(conn: pyodbc.Connection) -> None:
        try:
            conn.close()
        except Exception:  # noqa: BLE001 - closing must never raise
            pass

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {"idle": {k: len(v) for k, v in self._idle.items()}}

    def close_all(self) -> None:
        with self._lock:
            for bucket in self._idle.values():
                for conn in bucket:
                    self._close_quietly(conn)
            self._idle.clear()


def rows_to_dicts(cursor: pyodbc.Cursor) -> list[dict[str, Any]]:
    """Materialize a cursor into JSON-able dicts.

    Values are normalized so the orchestrator sees the same shapes the REST
    track produces: dates/times become ISO strings, Decimal becomes float (the
    read queries that return money already aggregate in SQL, so the precision
    that matters was decided server-side), and bytes are hex.
    """
    import datetime as _dt
    import decimal as _dec

    columns = [c[0] for c in cursor.description or []]

    def norm(v: Any) -> Any:
        if v is None or isinstance(v, (str, int, float, bool)):
            return v
        if isinstance(v, _dec.Decimal):
            return float(v)
        if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
            return v.isoformat()
        if isinstance(v, (bytes, bytearray)):
            return v.hex()
        return str(v)

    return [dict(zip(columns, (norm(v) for v in row))) for row in cursor.fetchall()]
