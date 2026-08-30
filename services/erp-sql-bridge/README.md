# `erp-sql-bridge` — direct-SQL ERP bridge (WARP-1106)

The DB-touching half of the direct-SQL Eaglesoft track: unixODBC + pyodbc
against a practice's SAP SQL Anywhere (`PattersonPM`) database, behind an
internal REST contract the orchestrator consumes.

## Why this service exists

The orchestrator is TypeScript, and there is no viable modern Node driver for
SQL Anywhere — the `sqlanywhere` npm addon is abandoned at a Node 12 ceiling and
does not build on the control plane. The supported Linux path is unixODBC +
`libdbodbc17_r.so`, driven from Python via pyodbc. So the driver lives here, and
the orchestrator stays language-agnostic.

```
LLM / dashboard
      │  named read/write only — never SQL
      ▼
orchestrator (erp.service → @droplet/erp-connector)
      │  EaglesoftConnector builds the statement:
      │  identifiers from the introspected schema map, values as `?`
      ▼
SqlBridgeClient ──HTTP (internal network only)──▶ erp-sql-bridge
                                                        │  pyodbc
                                                        ▼
                                               unixODBC → SAP client
                                                        ▼
                                             the practice's SQL Anywhere box
```

## What crosses the boundary, and what does not

**Out:** a parameterized statement (`sql` + positional `params`) built by the
canonical registries in `@droplet/erp-connector`, plus optionally which box to
reach.

**Never out:** a credential. `droplet_ro` / `droplet_rw` are resolved from this
container's own environment and chosen by ROUTE — `/read/*` runs as the
read-only account, `/write/*` as the write account. A caller can say which box
to talk to; it can never say who to be. There is no username or password field
anywhere in the request models, and a test pins that
(`tests/test_guards.py::test_no_credential_field_exists_on_any_request_model`).

**Never built here:** SQL. Re-deriving the queries in Python would create a
second source of truth for what runs against a practice's database — exactly the
drift the schema-map/fingerprint design exists to prevent. This service executes
a statement it is handed, and nothing more.

## The safety model

The real boundary is the **database grant**, not this process. `droplet_ro`
holds SELECT and nothing else, so a read connection physically cannot write even
if every check in `main.py` were deleted. `droplet_rw` is created unusable and
granted only the one enabled write capability — a column-scoped UPDATE on
`appointment`'s four mutable scheduling columns.
`services/erp-connector/sql/provision.sql` is the script that establishes this.

On top of that, outermost first:

**The statement allowlist** (WARP-2540, `allowlist.py` +
`statement_manifest.json`). `/read/{name}` and `/write/{name}` refuse any
statement that is not, shape-for-shape, what the registries emit for that
`{name}`: the incoming SQL is normalized (double-quoted identifiers masked to
`<id>`, whitespace collapsed) and must equal a shipped skeleton exactly. An
unknown name is `UNKNOWN_STATEMENT`, a reshaped statement is
`STATEMENT_MISMATCH` — both HTTP 400, refused before a connection is acquired.
Identifier *names* stay free (the schema map resolves them per practice, the
server checks they exist); the statement's *shape* may not vary by one
character, which is what makes an injected predicate, UNION, comment, second
statement, or changed verb structurally impossible. The manifest is pinned to
the registries by
`services/erp-connector/__tests__/statement-manifest-sync.test.ts`; a
missing/malformed manifest stops the service at import rather than starting it
half-guarded. `/introspect` is not allowlisted — its catalog SQL is a
dialect-injection seam (the live lane introspects Postgres) and the route is
confined to SELECTs on the read identity by the guards below.

The route guards then make a caller bug fail immediately and by name. Two
independent properties, checked in this order on **every** route:

1. **Exactly one statement** (`NOT_A_SINGLE_STATEMENT`). Unconditional, and
   deliberately independent of statement kind — an earlier revision folded this
   into the is-a-SELECT test, so a non-SELECT short-circuited out before the
   stacking check ran and `/write/*` executed `UPDATE ...; UPDATE ...` while
   reporting only the last statement's row count. Caught in review; now a
   shared assertion with a live test per route.
2. **The right kind of statement** — `/read/*` and `/introspect` require a
   SELECT (`NOT_A_READ`), `/write/*` refuses one (`NOT_A_WRITE`). Comments are
   stripped first, so `/*SELECT*/ UPDATE` cannot masquerade as a read.

`tests/test_live_bridge.py::TestGrantsAreTheRealBoundary` proves the grant half
against a live server, bypassing the routes entirely.

## API

| Route | Identity | Notes |
|---|---|---|
| `GET /health` | read | `SELECT 1` + pool state. Returns `ok:false` with a reason when the practice's DB is unreachable — a running bridge is not a working one |
| `POST /read/{name}` | `droplet_ro` | One registry-built SELECT. `{name}` is the registry query name — it selects which registered shape the SQL must match, and names the read in logs/errors |
| `POST /write/{name}` | `droplet_rw` | One registry-built write, in one transaction. `{name}` selects the registered shape. `rowCount: 0` is the optimistic guard missing, **not** an error |
| `POST /introspect` | read | Runs caller-supplied catalog queries and returns raw rows. Fingerprinting happens in TypeScript, against the same `computeSchemaFingerprint` the drift check uses |

## Enabling the track

1. Vendor the SAP SQL Anywhere client — see [`vendor/README.md`](vendor/README.md).
   It is license-governed and cannot ship in our image. **No aarch64 Linux
   client exists**; on ARM, use the `eaglesoft-api` REST track instead.
2. Provision the database accounts on the practice's server with
   `services/erp-connector/sql/provision.sql`.
3. Set `ERP_DB_*` in `.env` (see `docs/ENVIRONMENT.md`), add `erp` to
   `COMPOSE_PROFILES`, and set `ERP_SQL_BRIDGE_URL=http://erp-sql-bridge:9095`
   for the orchestrator.

Skip any of these and the connector stays blocked, surfacing
`ERP_NOT_CONNECTED` — deliberately, rather than reporting a green light over a
connection that does not exist.

## Tests

```bash
# Pure suite — no database, no ODBC driver. This is what ci.yml's leg runs.
# Needs unixODBC on the host (pyodbc links against libodbc).
cd services/erp-sql-bridge && pip install -r requirements-dev.txt && pytest

# Live suite — boots a throwaway Postgres, seeds the synthetic PattersonPM
# schema and its grants, drives this service through psqlODBC, then runs the
# TypeScript connector -> bridge -> database vitest suite on top.
./scripts/test-erp-sql-bridge.sh
```

Mocking pyodbc would test nothing that can break, so the live lane is where the
coverage is. It runs against **Postgres**, not SQL Anywhere, because the SAP
client is license-gated and x86_64-only and therefore cannot exist in CI —
unixODBC is driver-agnostic, so everything above `pyodbc.connect` is identical
either way. What stays unproven until a real install is the SAP connection
string itself (unit-tested in `tests/test_connection_string.py`) and SQL
Anywhere's own dialect behaviour.
