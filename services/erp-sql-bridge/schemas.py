"""Request models for the ERP SQL bridge.

Note what is absent: there is no field anywhere here for a username or a
password. The identity a statement runs as is decided by the ROUTE (`/read/*`
is `droplet_ro`, `/write/*` is `droplet_rw`) and resolved from this container's
own environment. A caller can say which box to reach and what statement to run;
it can never say who to be.
"""
from __future__ import annotations

from pydantic import BaseModel, Field

# WARP-3193 SEC-INJ-3 — these three values are spliced into an ODBC connection
# string, so they are restricted to characters that cannot close a parameter
# (`;`), open a quoted value (`{`) or smuggle a line. Mirrored by the zod
# connect schema in apps/orchestrator/src/routes/integrations.ts.
HOST_PATTERN = r"^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$"
NAME_PATTERN = r"^[A-Za-z0-9_.-]{1,128}$"


class TargetSpec(BaseModel):
    """Which database box to reach. None of these are secrets — they come from
    the IntegrationConnection row so the setup wizard's host field stays
    meaningful on a box that was deployed pointing somewhere else."""

    host: str = Field(pattern=HOST_PATTERN)
    port: int = Field(default=2638, ge=1, le=65535)
    serverName: str = Field(default="PattersonPM", pattern=NAME_PATTERN)
    databaseName: str = Field(default="PattersonPM", pattern=NAME_PATTERN)


class Statement(BaseModel):
    """A parameterized statement built by the TypeScript registry.

    `params` is positional, matching the `?` placeholders. Values are always
    bound, never interpolated — that property is established where the SQL is
    built (read-queries.ts / write-commands.ts) and preserved here by passing
    the list straight to pyodbc.
    """

    sql: str = Field(min_length=1)
    params: list[object] = Field(default_factory=list)


class ExecRequest(Statement):
    target: TargetSpec | None = None


class IntrospectRequest(BaseModel):
    """Catalog queries keyed by a label the caller chooses (e.g. "tables",
    "columns"), so the response can be matched back up without relying on
    ordering."""

    queries: dict[str, Statement]
    target: TargetSpec | None = None
