# Eaglesoft dry-setup harness (WARP-1106)

A **Dockerized mock of Eaglesoft's `PattersonPM` database** so you can walk the
whole Droplet ↔ Eaglesoft setup — provisioning, least-privilege reads, the
optimistic-guarded write — **without a real dental office, a live server, or any
PHI.**

There are three variants:

| Variant | Faithful to | Runs today? | Use it to |
|---|---|---|---|
| **`./eaglesoft-api/` (dummy REST box)** | the **Patterson REST API** on HTTPS :9888 — auth handshake, `/help` discovery, TLS, HTTP failure modes | ✅ yes, no SAP dependency, no Docker needed | **drive the real `EaglesoftApiConnector` end-to-end over a real socket** |
| **`./` (PostgreSQL)** | the **schema + data shapes + privilege model** | ✅ yes, zero SAP dependency | dry-run the connector's actual read/write SQL + the `droplet_ro`/`droplet_rw` model |
| **`./sqlanywhere/` (real dbsrv17)** | the **SQL Anywhere wire protocol, port 2638, catalog views** | ⛔ needs the (free) SAP Developer Edition binaries | prove the native driver + `provision.sql` against a real engine (the WARP-1106 driver-bridge target) |

> **Why two?** SQL Anywhere is proprietary — there is no official Docker image,
> and the client the connector needs is license-governed. The Postgres mock lets
> you exercise everything *except* the SQL Anywhere wire protocol **now**; the
> `sqlanywhere/` variant closes that last gap once you drop in the SAP binaries.

## Which harness do I want?

Eaglesoft is **two providers**, and only one of them can be connection-tested
today. Pick by the track you are installing:

| Track | Provider key | Harness | Can our connector actually talk to it? |
|---|---|---|---|
| Patterson REST API (HTTPS :9888) | `eaglesoft-api` | [**`eaglesoft-api/`**](eaglesoft-api/) | ✅ **Yes — end-to-end over real TLS.** The HTTP machinery is real code; only the route map and credentials are injected. |
| Direct SAP SQL Anywhere (:2638) | `eaglesoft` | `./` (Postgres) or `sqlanywhere/` | ⛔ **No.** `EaglesoftConnector` is entirely stubbed — every method throws `ConnectorBlockedError`. There is no driver to connect *with*. |

That asymmetry is the important thing to understand before an install. On the
SQL track the blocker is **not** the absence of a server to test against — it is
the missing Python/unixODBC (`libdbodbc17_r.so`) driver bridge. Standing up a
real `dbsrv17` would not change that; the connector still has no way to dial it.
So the Postgres harness proves the **SQL text, schema shape, and privilege
model**, and [`__tests__/harness-postgres-drift.test.ts`](../__tests__/harness-postgres-drift.test.ts)
keeps it honest — it parses `init/01-schema.sql`, rebuilds every registered
query against it, and fails if `smoke.sql` or the grants drift from the code.

---

## Variant A — Postgres mock (runs now)

**One command** (up + seed + smoke, leaves it running; add `--down` to tear down):
```bash
./services/erp-connector/harness/dry-run.sh
```
Or step by step:

### 1. Bring it up
```bash
docker compose -f services/erp-connector/harness/docker-compose.yml up -d
```
It stands up `postgres:16-alpine` on host **port 2638** (Eaglesoft's port), auto-seeded from `init/`:
`01-schema.sql` (the `dba`-owned PattersonPM schema) → `02-seed.sql` (fictional patients/appointments/accounts) → `03-provision.sql` (`droplet_ro` SELECT-only + `droplet_rw` with only the one column-scoped write capability). Data is on `tmpfs` — every `up` is a fresh seed.

### 2. Run the dry-setup smoke test
```bash
cd services/erp-connector/harness
docker compose exec -T mock-eaglesoft psql -U postgres -d pattersonpm < smoke.sql
```

It runs the erp-connector's **actual built SQL** (quoted-identifier style, straight from `read-queries.ts` / `write-commands.ts`) and proves the safety model. Expected output:

```
== 1. droplet_ro :: get_schedule_today ==            -> 3 of today's appointments
== 2. droplet_ro :: find_patient ("Lis") ==          -> Barbara Liskov
== 2b. PHI-overfetch defense ("%") ==                -> 0 rows (escaped)
== 3. droplet_ro :: get_ar_summary ==                -> account_count 5, total_balance 634.50
== 4. droplet_ro READ-ONLY write ==                  -> ERROR: permission denied (expected)
== 5. droplet_rw reschedule, guard MISS ==           -> UPDATE 0 (stale write rejected)
== 6. droplet_rw reschedule, guard HIT ==            -> UPDATE 1 (applied)
== 7. verify ==                                      -> new time + last_modified advanced (trigger fired)
== 8. droplet_rw on forbidden account table ==       -> ERROR: permission denied (expected)
```

### 3. Connect a SQL client (or, later, the connector)
```
postgresql://droplet_ro:droplet_ro_dev_pw@localhost:2638/pattersonpm
```
Dev passwords are in `init/03-provision.sql` (throwaway mock only).

### 4. Tear down
```bash
docker compose -f services/erp-connector/harness/docker-compose.yml down
```

### Known mock divergences (Postgres ≠ SQL Anywhere)
- **Case sensitivity:** Postgres identifiers/`LIKE` are case-sensitive; SQL Anywhere is case-insensitive by default. Seed names + the `find_patient` prefix are cased to match.
- **Catalog views:** `SYS.SYSTAB*` don't exist here — introspection (`introspection.ts`) reads them on the real engine; against this mock you'd supply the schema map from a fixture.
- **Watermark:** `appointment.last_modified` uses a `BEFORE UPDATE` trigger to mimic SQL Anywhere's `DEFAULT TIMESTAMP` (set on insert + every update).
- **Not** protocol-faithful — the erp-connector's native SAP ODBC path can't point at Postgres. That's what Variant B is for.

---

## Variant B — real SQL Anywhere (protocol-faithful; needs SAP binaries)

See [`sqlanywhere/README.md`](sqlanywhere/README.md). In short: SAP's **SQL Anywhere 17 Developer Edition** is free for dev use (an SAP-account-gated download; it can't be bundled here). Once you have the Linux binaries, `sqlanywhere/` gives you a container that `dbinit`s a real `PattersonPM.db`, creates the synthetic schema with a true `DEFAULT TIMESTAMP` watermark, runs the **real** `../sql/provision.sql`, and starts `dbsrv17 -x tcpip` on 2638 — the exact target the WARP-1106 driver bridge connects to.

---

## How this fits the roadmap

This harness is the **copy-DB half of WARP-1106**. The other half — the Python/unixODBC (`libdbodbc17_r.so`) driver bridge that lets the erp-connector actually connect — is still to build, and needs the SAP client (x86_64; no aarch64 client exists). Until then, this harness lets you dry-run everything at the SQL layer and gives the driver work a target to develop against. See `EAGLESOFT-INTEGRATION-PLAN-AND-PRS-2026-07-07.md` (PR-2) and `EAGLESOFT-DIRECT-SQL-RESEARCH-2026-07-07.md` §5.
