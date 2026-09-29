# ADR-055: Physical access control — the doors control-plane spine

- **Status:** Draft. Nothing here is ratified. This file records the decisions taken so far and what the first software slice (P4a) builds; the design of record is the handbook brief it points to. Three of the brief's decisions are still open and are listed under [Open](#open).
- **Date:** 2026-09-29
- **Ticket:** none yet. The branch is `feat/adr-055-doors-spine`; a WARP key is to be filed before the PR opens.
- **Brief:** `PHYSICAL-ACCESS-CONTROL-ARCHITECTURE-BRIEF.md` in `warp-lab-engineering-handbook` (itself headed "ADR-055 draft"). Sections cited below (§9.7, §11.x, §14) are the brief's.
- **Builds on:** [`ADR-032`](ADR-032-access-roles-custom-rbac.md) (RBAC v2 — the module grant resolver this module narrows within, never a parallel permission system), [`ADR-004`](ADR-004-rbac-per-route-guards.md) (role floors), ADR-059 (the Security module is the pattern for a gated, append-only event store; the brief's §11.8 bridge to it is not built here).
- **Not to be confused with:** ADR-032. `/api/access`, `routes/access.ts`, `lib/access.ts` and `components/access/` are the RBAC surface. Doors is a different thing and takes a different name everywhere (decision 2).
- **Number:** claimed here, in `docs/`, on `stage`. Checked 2026-09-29: none of the 742 refs on `origin` (every branch head and `stage`) carries a `docs/ADR-055*` file; the handbook's register lists ADR-055 as this brief. A claimed number reserves nothing, so re-check before merge.

> **What this file is.** A stub. It builds nothing by being merged. Its job is to fix the four decisions below in the tree where the code lives, so the code's comments have something to cite.

## Decisions (Stefan, 2026-09-29) — these override the brief where they differ

| # | Decision | Where it shows up |
|---|---|---|
| 1 | **Ship dark.** P4a is built in full behind an explicit boolean `DOORS_ENABLED`, default off, following the `DOCS_ENABLED` pattern: never derived from another variable's emptiness. When it is off the module is **absent** — `available: false` in the module registry, the same gate `cameras` reads `FRIGATE_URL` through — not present-and-empty. | `config.ts`, `docs/ENVIRONMENT.md`, `module-registry.ts` |
| 2 | **Naming.** Module id `doors`, routes `/api/doors/*`, chat tools in the `doors_` namespace (`doors_list`, `doors_recent_events`). Not `access`: that belongs to ADR-032. The brief's `access_list_doors` and friends are renamed accordingly. | registry, `routes/doors.ts`, `@droplet/tools-core` |
| 3 | **`AccessEvent` retention defaults to 365 days** (`DOORS_EVENT_RETENTION_DAYS`). The brief makes retention a design input of the first slice (§11.3, §10 GDPR row) without giving a number. | `doors.service.ts`, daily purge |
| 4 | **Out of scope for P4a:** `services/access-control/` (§11.1 — the cartridge interface is unspecified); credentials, grants and enrolment models (they depend on AC-017); the ADR-059 `SecurityEvent` bridge (§11.8) and any `Security*` enum change (waits for #2350); any dashboard page (P4b), beyond the vocabulary the module-registry consistency tests force; and the shipped Matter lock path, which is untouched (AC-014 is open). | — |

## What P4a builds

- **Schema.** `AccessPoint` (a door: name, `doorPositionSource ∈ {lock, dp1, none}`, held-open time, an explicit `active | retired` status) and `AccessEvent` (the §11.3 fourteen-value `kind`, append-only). Every state is an explicit enum column. `doorPositionSource = none` is a value, not a missing one.
- **Append-only in the database, not by convention.** A BEFORE UPDATE OR DELETE trigger refuses every UPDATE and every DELETE except inside the retention job's own transaction. A BEFORE INSERT trigger holds the derived-alarm rules of §9.7/§11.3: a `forced_door` or `held_open` row must reference a `door_open` row of the same door, and cannot exist for a door whose `doorPositionSource` is `none`.
- **Derivations (§9.7)** as pure functions: forced door, held open, relock, position unknown. A `none` door yields no forced-door or held-open claim.
- **Module `doors`**, registered in the App-Modules registry and feature-gated from day one, with a boot assertion that it is where it claims to be (§11.2).
- **Routes** under `/api/doors`: list doors, recent events (cursor-paged), and create / update / retire an `AccessPoint`. Reads are for owner and admin; writes are `owner` alone (§11.4).
- **Two read-only chat tools**, `doors_list` and `doors_recent_events`, with the §11.5 rule enforced at dispatch: nothing in the `doors_` namespace may write or ask to confirm, whatever registered it.
- **Retention:** a daily purge on the cron runtime, 365 days by default.

## Deviations from the brief, on purpose

- **Two tools, not four.** §11.5 also lists `access_device_status` and `access_cell_health`. Both read models (`AccessDevice`, `Cell`) that belong to the service slice, so they are not built.
- **A trigger that covers DELETE.** The `SecurityEvent` trigger (ADR-059) covers UPDATE only and lets retention `DELETE` through by not being asked. Decision 3's retention and §11.3's "never updated" are both honoured here by covering DELETE too and giving the purge one sanctioned path: a transaction-local setting only `purgeExpiredAccessEvents` sets. A source guard pins that no other file names it.
- **Retention counts from receipt (`createdAt`), not from the device's `occurredAt`.** A device with a wrong clock must not be able to keep a row forever or expire it at once.
- **Corrections are not modelled.** §11.3 says a correction is a new row referencing the old one, but the fourteen kinds include no correction kind, so there is nothing to give that row. It waits for the service slice to say what a correction is.
- **Read floor is `admin`.** The brief asks for grants per door group and an emptied grant set denies (§11.4). Door groups and grants are out of scope, so until they exist the module's own grant is the only narrowing and the floor is set high. Widening to `family` is one line in the access catalog and one in the router.

## Cross-cutting negative suite (§14)

Applied now: no `doors_*` tool can unlock or write; no `/api/doors` route lacks the RBAC grant; no in-place `AccessEvent` UPDATE or DELETE (against the trigger, on real Postgres); no forced-door or held-open claim on a `none` door (pure function and database); the module is absent when `DOORS_ENABLED` is off.

Deferred, with the reason: a UID accepted as a credential and an outside-lever turn registering as request-to-exit (no credential model, no device firmware — AC-017 and the firmware repo); a fail-safe device commissioned on cells (no `AccessDevice`); a lock that stops opening from the inside under any software state (a mechanical property, tested on hardware, P1/P3).

## Open

- **AC-001** — is this a product line or a Droplet feature? Founder. Nothing in this slice depends on the answer, and nothing in it commits to a SKU.
- **AC-014** — does the shipped Matter / `control_device` lock path get narrowed to §11.5's rule, or do two locking surfaces with two policies coexist? Stefan / Romain. Untouched here: `control_device` can still carry a lock command through the confirmation-token flow, and §11.5 refuses exactly that flow for `doors_*`.
- **AC-017** — where does the credential decision execute, the cartridge's MCU or the Vault? Stefan / Romain. It gates every credential, grant and enrolment model, so none exists here.
