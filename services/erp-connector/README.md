# @droplet/erp-connector

First-party **ERP-connector framework** for the Droplet control plane, with
**Eaglesoft** (Patterson Dental's practice-management system) as provider #1.
The connector reaches Eaglesoft **directly over its SAP SQL Anywhere database**
on the LAN, as a **dedicated least-privilege user** we provision inside
`PattersonPM` — no Patterson API, no cloud, no egress.

Full architecture and safety contract:
[`EAGLESOFT-INTEGRATION-ARCHITECTURE-BRIEF.md`](../../EAGLESOFT-INTEGRATION-ARCHITECTURE-BRIEF.md)
(this README implements §5–§12). The design is provider-agnostic: OpenDental
(MySQL), Dentrix, and generic ODBC ERPs slot in later behind the same
`Connector` interface.

> ## ⛔ Blocked on: SAP SQL Anywhere client + a restored copy of `PattersonPM.db`
>
> This package is the **DB-independent foundation only** (Phase 0, brief §17).
> Everything that touches a live database is **stubbed** behind a typed
> `ConnectorBlockedError` and marked `// TODO(WARP-1094): blocked on SAP SQL
> Anywhere client + copy of PattersonPM.db`. The blocked slice needs two things
> that are **not present in this environment**:
>
> 1. the **SAP SQL Anywhere client** (native `sqlanywhere` npm addon, or the
>    unixODBC `libdbodm17` fallback — brief §7.1), and
> 2. a **restored copy of `PattersonPM.db`** to introspect and to prove every
>    read query and write command against (brief §16 — production is never the
>    first place a write runs).
>
> The native `sqlanywhere` dependency is **deliberately not added yet** — it
> requires the SAP client redistributable and native compilation, and there is
> nothing to connect to. What **does** ship and is fully unit-tested: the schema
> map + drift fingerprint, the read-query registry, and the write-command
> registry (all pure — no I/O, no faked database).
>
> **This does NOT satisfy the full WARP-1094 Definition of Done**, which
> requires connecting to a copy DB as `droplet_ro`, printing the introspected
> schema map + fingerprint, and the offline CI egress gate (brief §17 Phase 0
> DoD). Those land once the client + copy DB are available.

## What ships in this slice

| Module | Purpose | Unit-tested |
|---|---|---|
| `src/schema-map.ts` | `computeSchemaFingerprint` (stable drift hash, §9.2) + identifier resolution through the introspected map (invariant 3) | ✅ |
| `src/introspection.ts` | `SYS.SYSTAB` / `SYS.SYSTABCOL` / `SYS.SYSIDX` catalog SQL constants (§9.1), plus v7 legacy fallbacks | (constants) |
| `src/read-queries.ts` | Parameterized named read queries; identifiers resolve only through the schema map; unknown names rejected (§10.1) | ✅ |
| `src/write-commands.ts` | Named write commands `{name, targetTable, allowedColumns, requiredParams, buildStatement, reversalPlan, verifyQuery}`; ledger/clinical/claim tables are impossible targets (§11.3, invariant 5) | ✅ |
| `src/connector.ts` | `Connector` provider interface + `EaglesoftConnector` (all driver/network calls stubbed) | ✅ (stub contract) |
| `sql/provision.sql` / `sql/revoke.sql` | `droplet_ro` SELECT-only + `droplet_rw` with no grants at creation (§8.1) | — |

## Internal REST contract (orchestrator ↔ sidecar)

The connector runs as a **sidecar** (`erp-connector`, brief §6.1), reachable
**only over the internal compose network** (`erp-connector:9090`) — never
exposed off-box (invariant 10). The orchestrator is the only caller; the
dashboard talks to the orchestrator, and the LLM reaches reads through
tools-core handlers (never this service directly). The wire contract the
orchestrator depends on (implemented once the driver lands):

| Method + path | Body | Returns | Notes |
|---|---|---|---|
| `GET /health` | — | `{ ok, lastReadAt, fingerprint, pool }` | `SELECT 1`-class probe + drift state (§7.3). Orchestrator maps this to the connection's `IntegrationStatus` enum. |
| `POST /introspect` | — | `{ tables, fingerprint }` | Runs the §9.1 catalog queries and fingerprints the result (§9.2). |
| `POST /read/:query` | `{ params }` | `{ rows }` | Runs a **named** read query (invariant 4). Values bind as `?`. Unknown query name → 404. |
| `POST /write/:command` | `{ params }` | `{ result, reversal, verify }` | Applies a **named** write command in ONE transaction as `droplet_rw` (§11.1 step 3). Gated by write opt-in + confirmation + drift re-check upstream. |

The REST layer is language-agnostic to the orchestrator (brief §6.2): if the
Node driver won't build on the box's arch, the sidecar may become a thin Python
service with the **same** REST contract (open decision O-4).

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
# From the repo root:
npm run -w @droplet/erp-connector build
cd services/erp-connector && npx vitest run --pool=forks --no-file-parallelism
```

All tests are pure unit tests. There are **no mock-database integration
tests** (team rule): DB-touching paths stay stubbed and are proven against a
restored copy of `PattersonPM.db` in a later phase, never a faked database.
