# Droplet Integrations — how it works

> **Audience:** anyone building, operating, or reviewing a Droplet integration.
> **Scope:** the whole integration system — the generic connector framework that applies to **every** integration, with **Eaglesoft** as the first concrete provider.
>
> **See also:** [`SETUP.md`](SETUP.md) (connect an integration — setup guide, in two tracks) · [`credential-handling.md`](credential-handling.md) (what the box does with a pasted SaaS credential) · [`ADD-A-PROVIDER.md`](ADD-A-PROVIDER.md) (build a new integration — developer guide) · [`eaglesoft.md`](eaglesoft.md) (the Eaglesoft provider reference) · [`export-drop.md`](export-drop.md) (the vendor-agnostic file-export track).
>
> **Per-vendor customer setup guides (cloud/SaaS):** [`stripe.md`](stripe.md) · [`hubspot.md`](hubspot.md) · [`mailchimp.md`](mailchimp.md) · [`shopify.md`](shopify.md) · [`xero.md`](xero.md).

---

## 1. What an integration is

An **integration** connects Droplet to an external **system of record** — a dental practice-management system (Eaglesoft), an accounting package (QuickBooks), another ERP, or a SaaS the business already lives in (Microsoft 365, Salesforce) — so the household/office can read and (carefully) act on that system's data through the Droplet dashboard and the local assistant.

This is a first-class fit for Droplet's founding thesis (`shared_brain/FOUNDATION.md`): the local AI and data **see and manage** the network but are **never exposed** to it. Every integration runs **on the box**, is **screened and audited**, and defaults to **read-only**.

### Two connector classes — know which one you are building

|  | **LAN connectors** | **Cloud connectors** (ADR-041) |
|---|---|---|
| System of record | On the customer's own network | A SaaS the customer already pays for |
| Network | **LAN only. No egress. Nothing leaves the premises.** | Outbound HTTPS only, to a destination registered in [`allowed-egress.yaml`](../security/allowed-egress.yaml) |
| Enabled by | Operator configuring the connection | **The owner connecting that specific account** — ships off, no default credentials |
| Data | Read-through; nothing persisted | **Persisted on the box** — the local copy is the point |
| Examples | `eaglesoft`, `eaglesoft-api`, `<vendor>-export` | `m365`, `salesforce` |

**The LAN-only guarantee is absolute for LAN connectors and always will be** — for a system sitting one switch-port away there is no reason for a packet to leave the building, and PHI never does.

**Cloud connectors are the deliberate, bounded exception**, decided in [ADR-041](../ADR-041-cloud-connector-class.md). They exist because most small businesses keep their mail, calendar, documents and pipeline in someone else's cloud, and a Droplet that cannot see any of it cannot answer the questions those businesses actually ask. The terms are fixed: outbound-only (the box opens no port and registers no webhook — it polls), owner-enabled per connection, every destination in the default-deny egress registry with its `data_class` declared, tokens encrypted at rest and purged on disconnect, and delegated per-user authorization so **the box can never read what the signed-in user cannot**. Read the ADR before building one.

The honest one-line version, which the UI should use too: *nothing leaves the box unless the owner turns on a specific connection — and everything that does is registered, screened and audited.*

Integrations are a **framework**, not a one-off. Eaglesoft is provider #1 behind a generic abstraction; other providers slot in behind the same interface, the same dashboard hub, the same safety pipeline (see [`ADD-A-PROVIDER.md`](ADD-A-PROVIDER.md)).

---

## 2. Architecture & call path

The call path is **one-directional and never inverted** (see `CLAUDE.md` — "Ollama call path" and "LLM tool calling"):

```
┌──────────────── Dashboard (apps/web-dashboard) ─────────────────────────────┐
│  /integrations  (hub — every connector)   /integrations/eaglesoft  (per-provider) │
│         │  REST: GET/POST /api/integrations/*   /api/erp/*                     │
└─────────┼─────────────────────────────────────────────────────────────────────┘
          ▼
┌──────────────── Orchestrator (apps/orchestrator) ───────────────────────────┐
│  routes/integrations.ts + routes/erp.ts      (auth-gated Express routers)     │
│  services/integrations.service.ts            (connection lifecycle)           │
│  services/erp.service.ts                     (reads + write-request outbox)   │
│  services/erp-error.ts                       (typed ErpError → HTTP status)   │
│  Prisma: IntegrationConnection · ErpSyncCursor · ErpEntityCache ·             │
│          ErpWriteRequest · ErpAuditLog                                        │
│  ReAct agent loop → @droplet/mcp-server → packages/tools-core/handlers/erp/*  │
└─────────┬─────────────────────────────────────────────────────────────────────┘
          │  internal REST over the compose network (never exposed off-box)
          ▼
┌──────────────── erp-connector sidecar (services/erp-connector) ─────────────┐
│  Connector interface  ·  EaglesoftConnector (provider #1)                     │
│  read-query registry (named, parameterized)  ·  write-command registry        │
│  schema-map + drift fingerprint  ·  version/catalog detection                 │
│  provisioning SQL (droplet_ro / droplet_rw)                                   │
└─────────┬─────────────────────────────────────────────────────────────────────┘
          │  provider driver (e.g. SQL Anywhere over TCP 2638), LAN only
          ▼
        External system of record (e.g. Eaglesoft — NOT ours)
```

Rules baked into this shape:

- **The dashboard talks to the orchestrator, never to the external system directly.**
- **Tool dispatch lives in the orchestrator** (`CLAUDE.md` — "LLM tool calling"). The assistant reaches an integration **only** through named `tools-core/handlers/erp/*` commands — it **never emits SQL**.
- **The connector sidecar owns the driver.** The provider-specific dependency (e.g. the SQL Anywhere client) is isolated in the sidecar so the orchestrator stays language-agnostic behind the sidecar's internal REST contract.
- **For a LAN connector, everything stays on the LAN.** No egress from the connector; PHI never leaves the box. (A **cloud connector** dials out instead — outbound only, to a registered destination, once the owner connects that account. The diagram above is the LAN shape; see [ADR-041](../ADR-041-cloud-connector-class.md).)

---

## 3. The provider framework

Every integration implements the same `Connector` interface (`services/erp-connector/src/connector.ts`):

```ts
interface Connector {
  readonly provider: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<{ ok: boolean }>;
  introspect(): Promise<IntrospectionResult>;          // discover + fingerprint the live schema
  runRead(name: string, params): Promise<unknown[]>;   // run a NAMED read query
  applyWrite(name: string, params): Promise<unknown>;  // apply a NAMED write command (one txn)
}
```

Two registries make the data plane **allow-list-only** — the assistant and dashboard can only name pre-vetted operations, never compose arbitrary SQL:

- **Read-query registry** (`read-queries.ts`) — named, parameterized `SELECT`s. Identifiers resolve through the introspected **schema map**; values bind as `?`. An unknown query name is rejected.
- **Write-command registry** (`write-commands.ts`) — named write operations with an `allowedColumns` list and a `FORBIDDEN_WRITE_TABLES` guard (ledger / clinical / claim tables are impossible targets). An unknown command name is rejected.

The orchestrator service layer is **provider-agnostic**; the dashboard hub renders any registered provider from static metadata. Adding a provider is: implement the `Connector`, register read/write operations, add tools + dashboard metadata — see [`ADD-A-PROVIDER.md`](ADD-A-PROVIDER.md).

---

## 4. Data model (Prisma, orchestrator DB)

State is **always an explicit enum column**, never derived from a row's absence (hard rule — WARP-218). Droplet stores integration state in **its own** database; the external system is never Droplet's source of truth.

| Model | Purpose |
|---|---|
| `IntegrationConnection` | One row per configured provider. Explicit `status` enum; `writeEnabled` opt-in flag; `host` / `databaseName`; **`secretRef` — a pointer into the encrypted secret store, never a cleartext password**; discovered `schemaVersion` + `schemaHash` (drift fingerprint). For the cloud tracks (WARP-2137): **`providerConfig`** carries the vendor's own account identifier (`realmId` / `organizationId`), validated structurally per provider rather than cast, and **`providerTokensEnc`** holds that track's OAuth tokens, AAD-bound to the row id so a blob moved to another connection fails closed. |
| `ErpSyncCursor` | Per-entity incremental-sync watermark (explicit column, not `IS NULL`). |
| `ErpEntityCache` | Cached read snapshots (PHI → encrypted at rest). A convenience/uptime layer, never the system of record; the UI always time-stamps it ("as of …"). |
| `ErpWriteRequest` | The write **outbox** — one row per proposed write, with an explicit `WriteStatus` lifecycle. |
| `ErpAuditLog` | Append-only audit of every read and every write transition. `scope` is **PHI-free** (ids / counts / tokens only). |

### `IntegrationStatus` (connection state)

```
NOT_CONFIGURED → PROVISIONING → CONNECTED
                              ↘ DEGRADED (can't reach the server; last-synced shown, labelled stale)
                              ↘ DRIFT_LOCKED (schema changed after an upgrade → writes frozen)
                              ↘ ERROR (unexpected failure)
DISABLED (turned off)
```

A connect attempt that can't reach the external system lands in **`PROVISIONING`**, never a fake `CONNECTED`. This is honest degradation — the dashboard shows "connecting / not connected", which is the truth.

### `WriteStatus` (write-request outbox lifecycle)

```
PENDING_CONFIRMATION ──(human confirms)──▶ APPLYING ──(applied + verified)──▶ APPLIED
        │                                     │
        │                                     ├──(external system altered it)──▶ DISCREPANCY
        │                                     └──(apply failed / blocked)──────▶ FAILED
        └──(rejected)──▶ REJECTED
```

A write is **never applied without a confirmed request**. Intent (`createWriteRequest`) touches nothing in the external system; only a human-confirmed request is applied.

---

## 5. The safety model (why this is careful)

Reads are safe; writing back into a live system of record is the sharp edge. Every layer is designed around that.

1. **Read-only by default.** A new connection is read-only. Writes are a **per-practice, per-capability opt-in** (`writeEnabled`), off until explicitly enabled.
2. **Least-privilege database access.** Droplet connects as **dedicated accounts it provisions inside the external database** — a `droplet_ro` (SELECT-only, the default) and, only when writes are enabled, a narrow `droplet_rw`. Never a shared/admin/default credential. See [`SETUP.md`](SETUP.md) §2.3 ("The dedicated user in their database model") and [`eaglesoft.md`](eaglesoft.md). This applies to the **LAN track only** — a cloud/SaaS provider has no database in which to provision an account, and instead takes a credential the owner creates in the vendor's own console ([`SETUP.md`](SETUP.md) §3, [`credential-handling.md`](credential-handling.md)).
3. **The assistant never emits SQL.** It invokes **named, parameterized commands** from the registries only. There is no "run this query" escape hatch against a live third-party system.
4. **Financial / clinical / claim tables are never written.** `FORBIDDEN_WRITE_TABLES` makes them impossible targets. Writes are confined to a small, vetted, tested allow-list (e.g. an appointment reschedule).
5. **The write outbox: create → confirm → apply → verify.** A proposed write is staged (`ErpWriteRequest`, `PENDING_CONFIRMATION`), a **human confirms** it (the dashboard's write-confirm modal — voice/LLM alone can never authorize a write), then the connector applies it in one transaction, then a verify-read checks the result. A blocked/failed apply is recorded `FAILED` — never a fake `APPLIED`.
6. **RBAC — PHI minimum-necessary.** Reads are gated to PHI-viewing roles (owner / admin / family); writes to owner / admin. Enforced **both** in the service and at the route (`requireRole`).
7. **Everything is audited.** Every read and every write transition writes an append-only `ErpAuditLog` row with a **PHI-free `scope`** (internal ids, counts, action — never names, DOB, or notes; a patient-search term is recorded only as its length).
8. **Schema-drift fails safe.** The discovered schema is fingerprinted (`schemaHash`). When an upgrade changes it, the connection goes **`DRIFT_LOCKED`**: writes freeze, reads degrade to still-matching fields, and the dashboard shows a "re-check" state. Droplet refuses to act against a schema it can no longer prove.
9. **Kill-switch.** A per-practice and global write kill-switch instantly returns the integration to read-only. Default off.
10. **On-box and encrypted; LAN-only for a LAN connector.** PHI cache + secrets encrypted at rest; the external link uses TLS where the server supports it. A LAN connector adds **no egress at all**. A **cloud connector** (ADR-041) egresses only to its registered destination, only after the owner connects that account, and purges its tokens on disconnect. Stated in the UI as a **capability**, not a policy promise — and a cloud connection must say plainly, at connect time, what will be read and that it will be copied onto the box.

Every error the dashboard renders is a typed `ErpError` (`erp-error.ts`) mapped to an HTTP status — e.g. `ERP_NOT_CONNECTED` → 503, `WRITE_NOT_ENABLED` / `INVALID_STATE` → 409, `FORBIDDEN` → 403 — so the UI can branch (render a "connect" empty state vs a hard-error banner) without ever seeing a raw driver error.

---

## 6. API surface (orchestrator → dashboard)

All endpoints are auth-gated; PHI endpoints enforce RBAC and audit.

| Method + path | Purpose |
|---|---|
| `GET /api/integrations` | Hub list (all providers + status). No PHI, no secret. |
| `GET /api/integrations/eaglesoft` | Connection detail + status. |
| `POST /api/integrations/eaglesoft/connect` | Run / verify provisioning; land `CONNECTED` (or honest `PROVISIONING`). |
| `POST /api/integrations/eaglesoft/test` | Reachability test (no save). |
| `POST /api/integrations/eaglesoft/write-enable` \| `/write-disable` | The write opt-in / kill-switch. |
| `GET /api/erp/schedule?date=…` · `/api/erp/patients?query=…` · `/api/erp/patient/:id` · `/api/erp/ar-summary` · `/api/erp/recall-due` | Read surfaces (paginated, audited). |
| `POST /api/erp/write-requests` · `GET /api/erp/write-requests/:id` · `POST /api/erp/write-requests/:id/confirm` | The write outbox: stage → read status → human-confirm. |

*(The `/api/erp/*` prefix is the generic ERP data plane; a future non-ERP provider category would add its own surface behind the same service pattern.)*

---

## 7. Current build state

The framework is built and buildable **without** any live external system. What's shipped vs. blocked:

| Piece | State |
|---|---|
| Dashboard (`/integrations` hub + `/integrations/eaglesoft`) | **Built** — renders honest "Not connected" until a connection exists (PR #900). |
| Connector foundation (`erp-connector`: interface, registries, schema-map/fingerprint, provisioning SQL, tools) | **Merged** (PR #901). Every live I/O path throws `ConnectorBlockedError` until a driver is wired. |
| Orchestrator API + service layer (this document's §6) | **Built** (PR #916) — endpoints return honest status/empty; the write outbox works end-to-end with the connector stubbed. |
| **Live driver** (the provider's real DB connection + introspection + read/write execution) | **Blocked** — needs the provider's client + a data source. For Eaglesoft that's the SAP SQL Anywhere client + a copy of `PattersonPM.db` on an x86_64 host (see [`eaglesoft.md`](eaglesoft.md)). Wiring it live only replaces the connector's stubbed methods. |
| **Export-drop track** (`<vendor>-export`, WARP-1964) | **Runnable today** — reads the report files a practice exports from its own PMS off a read-only share. Needs no vendor driver and no vendor enrolment, so it is the one track that does not wait on a third party; read-only by construction and vendor-agnostic via declarative profiles. See [`export-drop.md`](export-drop.md). |
| **Cloud tracks** (`quickbooks-online` WARP-2109, `dentrix-ascend` WARP-2127) | **Selectable** (WARP-2137). Both connectors shipped with full suites but had no provider key in `erp-provider.ts`, so `validateProvider` rejected them and nothing could construct one — they were unreachable from the API. The keys, the connection config, and the token store are now wired; each still needs an operator to supply its account identifier and an authorized token before it reads anything. Egress for both is registered in [`allowed-egress.yaml`](../security/allowed-egress.yaml). |
| **`quickbooks-desktop`** (WARP-2108) | **Not selectable.** The connector exists, but the Intuit Web Connector POSTs qbXML *to the box* and no such endpoint is built — a connector wired today would read a permanently empty snapshot store. Deliberately left unmapped rather than made constructible-but-useless. |

**"Blocked" means the seam is stubbed, not missing.** The whole walking skeleton (dashboard ↔ orchestrator ↔ connector) is wired and tested; only the connector's driver methods (`connect`/`introspect`/`runRead`/`applyWrite`) reject with `ConnectorBlockedError` until the provider's driver lands.

---

## 8. Where things live

| Concern | Location (repo `droplet-onboard-services`) |
|---|---|
| Dashboard surfaces | `apps/web-dashboard/src/app/integrations/` + `src/components/erp/` + `src/components/integrations/` |
| Orchestrator services | `apps/orchestrator/src/services/{integrations,erp}.service.ts` + `erp-error.ts` |
| Orchestrator routes | `apps/orchestrator/src/routes/{integrations,erp}.ts` (mounted in `app.ts`) |
| Connector framework | `services/erp-connector/` |
| Assistant tools | `packages/tools-core/src/handlers/erp/` |
| Prisma models | `apps/orchestrator/prisma/schema.prisma` (`IntegrationConnection`, `Erp*`) |

**Design + specs:** `shared_brain/content/brand/handoffs/erp-integrations/` (design brief + clickable prototype). The `EAGLESOFT-INTEGRATION-ARCHITECTURE-BRIEF.md` (build spec), `EAGLESOFT-INTEGRATION-PLAN-AND-PRS-2026-07-07.md` (PR plan), and `EAGLESOFT-DIRECT-SQL-RESEARCH-2026-07-07.md` (deep research) are unpublished working docs — not in-repo; the in-repo authority is this README + [`eaglesoft.md`](eaglesoft.md). **Epic:** WARP-1093.
