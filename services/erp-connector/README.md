# @droplet/erp-connector

First-party **ERP-connector framework** for the Droplet control plane, with
**Eaglesoft** (Patterson Dental's practice-management system) as provider #1.
The connector reaches Eaglesoft **directly over its SAP SQL Anywhere database**
on the LAN, as a **dedicated least-privilege user** we provision inside
`PattersonPM` — no Patterson API, no cloud, no egress.

Full architecture and safety contract:
[`docs/integrations/eaglesoft.md`](../../docs/integrations/eaglesoft.md)
(the in-repo provider reference; the original `EAGLESOFT-INTEGRATION-ARCHITECTURE-BRIEF.md`
build spec this README implements §5–§12 of is an unpublished working doc, not in-repo). The design is provider-agnostic: OpenDental
(MySQL) and generic ODBC ERPs slot in later behind the same
`Connector` interface.

> ## ⚠ Status: the driver bridge ships; the SAP client is operator-supplied
>
> The direct-SQL track's I/O now goes through **`services/erp-sql-bridge`**
> (WARP-1106) — a unixODBC + pyodbc sidecar reached over internal REST via
> `src/sql-bridge-client.ts`. Python owns the driver because the Node
> `sqlanywhere` addon is abandoned at a Node 12 ceiling and does not build on
> the control plane (open decision **O-4 resolved → Python**, per
> `EAGLESOFT-DIRECT-SQL-RESEARCH-2026-07-07.md` §5).
>
> Two things remain outside this repo, and both fail **honestly** rather than
> silently:
>
> 1. the **SAP SQL Anywhere client** (`libdbodbc17_r.so`) is license-governed
>    and account-walled, so it cannot ship in our image — an operator vendors
>    it (`services/erp-sql-bridge/vendor/README.md`). The sidecar is
>    **x86_64-only**: SAP ships no aarch64 client, so an ARM box uses the
>    `eaglesoft-api` REST track instead (research §5).
> 2. a **restored copy of `PattersonPM.db`** is still what proves the read
>    queries and write commands against Eaglesoft's real schema (brief §16 —
>    production is never the first place a write runs).
>
> With no bridge configured, or a bridge that cannot reach the practice, every
> I/O method throws `ConnectorBlockedError` and the orchestrator surfaces
> `ERP_NOT_CONNECTED`. That is the design, not a gap.
>
> **What is proven end-to-end today:** `scripts/test-erp-sql-bridge.sh` boots a
> real Postgres seeded with a shape-faithful synthetic `PattersonPM`
> (`harness/init/`) and its least-privilege grants, points the bridge's ODBC
> driver at psqlODBC, and runs the **real** registry SQL through the **real**
> connector into a **real** database — connect → introspect → schema map →
> fingerprint → named reads → the guarded write
> (`__tests__/sql-bridge.live.test.ts`). unixODBC is driver-agnostic, so
> everything above `pyodbc.connect` is identical against SQL Anywhere. What
> stays unproven until an install is the SAP connection string itself
> (unit-tested) and SQL Anywhere's own dialect behaviour.
>
> **This does NOT satisfy the full WARP-1094 Definition of Done**, which
> requires connecting to a copy of the real `PattersonPM.db` as `droplet_ro`
> and printing the introspected schema map + fingerprint from it (brief §17
> Phase 0 DoD).

## What ships in this slice

| Module | Purpose | Unit-tested |
|---|---|---|
| `src/connection-string.ts` | Builds the DSN-less SQL Anywhere string — `Host=` XOR `CommLinks=` (never both), `Encryption=NONE` default (§7.2, review C-1) | ✅ |
| `src/version-detect.ts` | `PROPERTY('ProductVersion')` → engine major → catalog dialect (SA10+ modern / ASA7 legacy) + corrected Eaglesoft↔engine band map (§3, review C-5) | ✅ |
| `src/schema-map.ts` | `computeSchemaFingerprint` (stable drift hash, §9.2) + identifier resolution through the introspected map (invariant 3) | ✅ |
| `src/introspection.ts` | `SYS.SYSTAB` / `SYS.SYSTABCOL` / `SYS.SYSIDX` catalog SQL (§9.1) + v7 legacy fallbacks + `catalogQueriesFor(dialect)` + trigger / FK / DEFAULT-TIMESTAMP-watermark discovery for write-safety (review B-4/B-5) | ✅ |
| `src/read-queries.ts` | Parameterized named read queries; identifiers resolve only through the schema map; unknown names rejected (§10.1) | ✅ |
| `src/write-commands.ts` | Named write commands `{name, targetTable, allowedColumns, requiredParams, buildStatement, reversalPlan, verifyQuery}`; ledger/clinical/claim tables are impossible targets (§11.3, invariant 5) | ✅ |
| `src/connector.ts` | `Connector` provider interface + `EaglesoftConnector`; database I/O goes through the `erp-sql-bridge` sidecar, blocked when none is configured | ✅ (+ live suite) |
| `src/sql-bridge-client.ts` | HTTP client for `services/erp-sql-bridge`. Sends a built statement + which box to reach; **never** a credential (WARP-1106) | ✅ (+ live suite) |
| `sql/provision.sql` / `sql/revoke.sql` | `droplet_ro` SELECT-only + `droplet_rw` with no grants at creation (§8.1) | — |

## Internal REST contract (orchestrator ↔ sidecar)

The DB-touching half runs as a **sidecar** — `services/erp-sql-bridge`
(brief §6.1) — reachable **only over the internal compose network**
(`erp-sql-bridge:9095`), never exposed off-box (invariant 10). The
orchestrator is the only caller; the dashboard talks to the orchestrator, and
the LLM reaches reads through tools-core handlers (never this service
directly). `src/sql-bridge-client.ts` is this side of the wire:

| Method + path | Body | Returns | Notes |
|---|---|---|---|
| `GET /health` | — | `{ ok, reason?, lastReadAt, pool }` | `SELECT 1`-class probe (§7.3). `ok:false` when the practice's DB is unreachable — a running bridge is not a working one. The connector adds the drift state, which it owns. |
| `POST /introspect` | `{ queries, target? }` | `{ results }` | Runs caller-supplied catalog queries. Fingerprinting stays in TypeScript, against the same `computeSchemaFingerprint` the drift check uses (§9.2) — a second hash would be a second definition of "the schema changed". |
| `POST /read/:query` | `{ sql, params, target? }` | `{ rows, rowCount }` | Executes an **already-built** named read as `droplet_ro` (invariant 4). A non-SELECT is refused. |
| `POST /write/:command` | `{ sql, params, target? }` | `{ rowCount, applied }` | Executes an **already-built** named write in ONE transaction as `droplet_rw` (§11.1 step 3). `rowCount: 0` is the optimistic guard missing, not an error. Gated by write opt-in + confirmation + drift re-check upstream. |

Note what the body carries and what it does not: the **statement is built
here**, by the registries above, so the bridge has no second copy of the SQL —
and **no credential ever crosses the wire**. The bridge resolves `droplet_ro` /
`droplet_rw` from its own environment and picks between them by route.

The REST layer is language-agnostic to the orchestrator (brief §6.2). Open
decision **O-4 is resolved → the DB-touching bridge is Python** (unixODBC +
`libdbodbc17_r.so` via pyodbc); the Node addon is abandoned and does not build
on the control plane (research §5). The orchestrator sees only this REST
contract, so the bridge language is invisible to it.

## Safety invariants enforced here

- **Read-only by default** (invariant 1) — `droplet_rw` gets no grants at
  creation (`sql/provision.sql`); writes are opt-in, per-capability.
- **Never string-concatenate SQL** (invariant 3) — values bind as `?`;
  identifiers resolve only through the schema map; an unknown identifier
  throws (`SchemaResolutionError`).
- **The LLM never emits SQL** (invariant 4) — reads/writes are named registry
  entries; an unregistered name is rejected.
- **No raw writes to financial/clinical tables** (invariant 5) —
  `FORBIDDEN_WRITE_TABLES` + `assertTargetAllowed` make ledger/clinical/claim
  tables impossible write targets, enforced at registration and per build.
- **Schema-drift fails safe** (invariant 9) — the fingerprint is recomputed and
  compared before every write; a mismatch (Eaglesoft upgraded) freezes writes.
- **Secrets are pointers** (invariant 10, §7.4) — `ConnectorConfig` carries a
  `secretRef` only; no cleartext password lives in code, config, rows, or logs.

## Test

```bash
# From the repo root (matches the package's own scripts):
npm run -w @droplet/erp-connector build   # tsc
npm run -w @droplet/erp-connector test    # vitest run (live SQL suite skips)

# Adds the live SQL lane: boots Postgres + the bridge, then runs the
# connector -> bridge -> database suite. Needs postgresql + unixodbc +
# odbc-postgresql on the host.
./scripts/test-erp-sql-bridge.sh
```

**The SQL track is never tested against a database pretending to be
Eaglesoft** (team rule): the registries are proven against a restored copy of
`PattersonPM.db` in a later phase. Two suites guard it in the meantime, and
neither claims to be that copy:

* `__tests__/harness-postgres-drift.test.ts` parses the dry-run harness's DDL,
  rebuilds every registered query and grant against it, and fails when they
  drift — it asserts the harness still matches the code.
* `__tests__/sql-bridge.live.test.ts` (gated on `ERP_BRIDGE_LIVE_URL`, run by
  `scripts/test-erp-sql-bridge.sh`) drives the real connector through the real
  `erp-sql-bridge` into a real Postgres. What it proves is the **transport and
  the pipeline** — connect, live catalog introspection, schema-map resolution,
  fingerprint stability, `?` binding, `LIKE` escaping, the optimistic-guard
  write, and honest degradation when the bridge is absent or unreachable. It
  does not claim the synthetic schema is Eaglesoft's; the schema map is
  discovered at runtime precisely because it is not.

**The REST track is different, and is tested against a live server.**
`__tests__/api-connector.live.test.ts` starts the dummy Eaglesoft API box in
[`harness/eaglesoft-api/`](harness/eaglesoft-api/) and drives the real
`EaglesoftApiConnector` across a real TLS socket. That is not a faked
Eaglesoft standing in for the real one: the connector's blocked-by-default
contract is unchanged, and what the suite proves is the transport — TLS
verification, the auth handshake, timeouts, 5xx, dropped connections, non-JSON
bodies, and the honest degradation each produces. Those are the failures an
install hits, and a mocked `fetch` cannot produce any of them. It needs no
Docker (in-process, ephemeral port) and runs in the existing CI leg.
