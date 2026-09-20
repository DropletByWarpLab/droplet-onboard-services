# Eaglesoft — provider reference

> The concrete first provider of the [integrations framework](README.md). Eaglesoft is Patterson Dental's practice-management system; Droplet reads it **directly over its SQL database**, as a **dedicated least-privilege user we provision inside that database** — no Patterson API, nothing off the LAN.
>
> Facts below are load-bearing and web-verified (some correct earlier assumptions — flagged **⚠**). The full workings (`EAGLESOFT-INTEGRATION-ARCHITECTURE-BRIEF.md` + `EAGLESOFT-DIRECT-SQL-RESEARCH-2026-07-07.md`) are unpublished working docs, not in-repo — this file + [`README.md`](README.md) are the in-repo authority.

---

## 1. The database

| Fact | Value |
|---|---|
| Engine | **SAP SQL Anywhere** (formerly Sybase Adaptive Server Anywhere). **Not** SQL Server, not MySQL. |
| Database file | **`PattersonPM.db`** (+ `PattersonPM.log`) → the `DatabaseName` is `PattersonPM`. |
| Default TCP port | **2638**. The network `dbsrv` engine listens on TCP by default (workstations connect this way). ⚠ A single-PC `dbeng` office may not expose TCP — verify per-site. |
| Schema owner | typically **`dba`** — reference objects as `dba.<table>` unless introspection says otherwise. |
| Connection | one of `Host=<ip>:2638` **or** `CommLinks=tcpip(...)` — ⚠ **never both** (SQL Anywhere rejects it). `Encryption=NONE` unless the server has TLS. |

### ⚠ Engine-version → catalog map (corrected)

The engine binary version does **not** equal the Eaglesoft version. Detect the engine at connect time via `PROPERTY('ProductVersion')` and branch the introspection queries:

| Engine (`dbsrvNN`/`dbengNN`) | Eaglesoft band | Catalog dialect |
|---|---|---|
| `dbsrv17` | ES 20+ | `SYS.SYSTAB` / `SYS.SYSTABCOL` (v10+ modern) |
| `dbsrv16` | ES 18.10 – 19.10 | modern |
| **`dbsrv10`** | **ES 16 – 18** (SQL Anywhere 10 is the workhorse — **not** v16) | modern |
| `dbsrv7` | ES 15 ↓ | `SYSTABLE` / `SYSCOLUMN` (ASA7 legacy) |

Also capture triggers (`SYS.SYSTRIGGER`), foreign keys (`SYSFOREIGNKEY`), and scan for a `DEFAULT TIMESTAMP` column (the sync watermark — §4).

---

## 2. The driver bridge (the hard gate)

⚠ **There is no viable modern Node SQL Anywhere driver** — the `sqlanywhere` npm package is dead (Node-12 ceiling). The DB-touching sidecar is therefore **Python + unixODBC + `libdbodbc17_r.so` (pyodbc)** — the TS orchestrator stays language-agnostic behind the sidecar's internal REST contract.

⚠ **x86_64-only.** SAP ships **no aarch64 SQL Anywhere client** (only a 32-bit ARMv6 build). On a future aarch64 box the DB sidecar must run under qemu-x86_64, on an x86_64 node, or via jConnect+TDS (server-side TDS you don't control). **Flag aarch64 direct-SQL as hardware-blocked.**

The SAP SQL Anywhere client is **license-governed** — vendor the **Developer Edition** into the sidecar image for CI, and **never** perform a real `PattersonPM.db` restore without a BAA (§6).

⚠ **AES-256 at-rest encryption is NOT a connection blocker.** The database key only gates *starting* the engine, not *connecting* to a running one — so reads-first is genuinely buildable once the driver lands. (This was the biggest feared go/no-go; it's refuted.)

---

## 3. Provisioning — Droplet's accounts

Droplet provisions its own least-privilege accounts inside `PattersonPM` (see [`SETUP.md`](SETUP.md) §2.3, "The dedicated user in their database model"):

- **`droplet_ro`** — `SELECT` only.
- **`droplet_rw`** — narrow, created empty, grants added per enabled write capability.

⚠ **Do not use `dba`/`sql`.** Eaglesoft historically shipped a well-known hardcoded credential (`dba`/`sql`; US-CERT-class advisory VU#344432 / CVE-2016-2343). On **ES18+** the DBA credential is randomized (a per-install SA/DBA/PDBA stored in `Eaglesoft.Server.Configuration.data`) — `dba`/`sql` is dead there. Using any built-in credential is insecure, over-privileged, and unauditable. Provision our own.

⚠ **Bootstrap needs someone with DBA authority** (the office's Eaglesoft admin) to run the grant script once — surface this in the wizard. Our provisioned accounts persist in **`ISYSUSER`** inside the `.db` (they survive a restart), but a **major-version `.db` rebuild could drop them** → provisioning is **idempotent / self-healing** (re-run on connect-fail).

⚠ **Request-log leak:** avoid any path that logs the provisioning statement with the generated password — passwords stay `secretRef`-only.

---

## 4. Reads

Named, parameterized read queries only (see [`ADD-A-PROVIDER.md`](ADD-A-PROVIDER.md) §2). Likely entities: `patient`, `appointment`, `provider`, `operatory`, `service`, `serv_trans`, `account` (AR — read-only), `recall`. Exact tables/columns/keys are **version-dependent** → come from live introspection, never a hardcoded schema.

⚠ **Person model:** a patient maps to an account via a **responsible-party join**, not one-row-per-patient — model it accordingly.

⚠ **Service code ≠ ADA/CDT code.** Eaglesoft's `service` code is an internal code; the ADA/CDT procedure code is mapped separately (via Quick Pick). Don't conflate them in AR/production reads.

⚠ **The sync watermark may not exist as a column.** SQL Anywhere has no implicit rowversion — introspect for a `DEFAULT TIMESTAMP` column (a Phase-0 gate). If absent, fall back to the **OnSchedule audit trail** (if it's a base table) or a bounded **~2-minute poll + diff**. This is the single biggest build-shaping unknown.

**Industry context:** direct-SQL read via an on-site agent (~2–5 min polls) is the **standard** dental-integration pattern — NexHealth, Sikka, Yapi, RevenueWell all do it. Our approach is not exotic.

---

## 5. Writes — extra hazards

Beyond the framework's general write safety ([`README.md`](README.md) §5), Eaglesoft-specific hazards:

- ⚠ **Raw writes bypass Eaglesoft's application-tier side effects** — its own audit trail, double-book/recall logic, ledger balancing. A raw `INSERT`/`UPDATE` can desync data the app maintains.
- ⚠ **Column-level `INSERT` grants don't exist in SQL Anywhere** — `INSERT` column-confinement is **app-layer only** (the write-command `allowedColumns` guard), so the guard is load-bearing. `UPDATE(col)` grants *do* exist.
- ⚠ **Writes may not be visible to live Eaglesoft clients until a service restart** — surface this to the operator.
- **Evaluate Patterson's PIC API for writes.** For anything beyond a trivially-safe write, routing writes through Patterson's sanctioned integration API (narrow, ~$3–5k+/mo) may be safer than raw SQL. Reads stay direct-SQL.

v1 writes are limited to appointment reschedule/create; ledger/clinical/claim tables are never written.

---

## 6. Legal (a hard precondition, not an open question)

Direct database access is powerful and **not sanctioned by Patterson** — clear these **before any PHI**, including a real copy restore (tracked as **WARP-1100**, needs an owner + dated exit criteria):

- **Signed BAA** before any PHI touches Droplet (a restored real copy is PHI).
- **EULA §5(a)** bans "integrating unauthorized software" — counsel review required; Patterson "strongly encourages using only authorized vendors" (support a_id/18100). Warp is exposed via **tortious interference** even though the EULA binds the practice.
- **Encryption** in transit (SA TLS on 2638 or appliance tunnel) + at rest (built-in); **immutable 6-yr audit**.

---

## 7. Current build state

| Piece | State |
|---|---|
| Connector foundation (interface, registries, schema-map/fingerprint, provisioning SQL, version/catalog detect, tools) | **Merged** — PR #901 + corrections (`9f50018e`). Live I/O throws `ConnectorBlockedError`. |
| Dashboard (`/integrations` + `/integrations/eaglesoft`) | **Built** — PR #900 (design-reconciled). |
| Orchestrator API + service layer | **Built** — PR #916. |
| Copy-DB harness (Postgres mock runs in CI; real dbsrv17 template documented) | **Merged** — PR #909. |
| **Python/ODBC driver bridge + Dockerfile** (WARP-1106) | **Built** — `services/erp-sql-bridge` (FastAPI + unixODBC + pyodbc), the `erp` compose profile, and `SqlBridgeClient` on the TS side. `scripts/test-erp-sql-bridge.sh` proves the whole path — real connector → real bridge → real database — against a Postgres stand-in (psqlODBC), because the SAP client cannot exist in CI. |
| SAP SQL Anywhere client in the image | ⛔ **Operator-supplied** — license-governed and account-walled, so it is vendored per deployment (`services/erp-sql-bridge/vendor/README.md`), not shipped. Without it the track stays blocked, honestly. **x86_64-only** (no aarch64 client); ARM boxes take the `eaglesoft-api` REST track. |
| Live reads/writes against a real `PattersonPM.db` | ⛔ **Blocked** — needs a restored copy on an x86_64 host with the client present. The pipeline is proven; what a copy DB establishes is that the registries match Eaglesoft's real schema. |
| Live reads → writes (WARP-1095 / 1096 / 1097 / 1098 / 1099) | ⛔ Blocked on WARP-1106; writes additionally gated on WARP-1100 (legal). |

**To unblock:** the SAP SQL Anywhere client vendored into the bridge image on an x86_64 host, **+** a copy of `PattersonPM.db` restored into a SQL Anywhere container (or a reachable test Eaglesoft server), plus the WARP-1100 legal sign-off before any production/real-PHI step. The bridge and the connector are no longer part of the blocker — with a client and a reachable server, the direct-SQL track connects. A **field-introspection spike** on a live box (WARP-1108) de-risks the driver work (capture the service command line, `SYS.SYSTABCOL` watermark/ownership scans, and `CONNECTION_PROPERTY('Encryption')`).

---

## 8. References

- **Build spec:** `EAGLESOFT-INTEGRATION-ARCHITECTURE-BRIEF.md` *(unpublished working doc — not in-repo)*
- **Deep research (10 corrections):** `EAGLESOFT-DIRECT-SQL-RESEARCH-2026-07-07.md` *(unpublished working doc — not in-repo)*
- **PR plan (dependency-ordered):** `EAGLESOFT-INTEGRATION-PLAN-AND-PRS-2026-07-07.md` *(unpublished working doc — not in-repo)*
- **Adversarial brief review:** `EAGLESOFT-BRIEF-REVIEW-2026-07-07.md` *(unpublished working doc — not in-repo)*
- **In-repo authority:** this file + [`README.md`](README.md)
- **Design packet + prototype:** `shared_brain/content/brand/handoffs/erp-integrations/`
- **Epic:** WARP-1093 · **legal gate:** WARP-1100 · **driver:** WARP-1106 · **field spike:** WARP-1108
