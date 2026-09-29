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
| 2 | **Naming.** Module id `doors`, routes `/api/doors/*`, and — when they land in P4b — chat tools in the `doors_` namespace. Not `access`: that belongs to ADR-032. The brief's `access_list_doors` and friends are renamed accordingly. | registry, `routes/doors.ts` |
| 3 | **`AccessEvent` retention defaults to 365 days** (`DOORS_EVENT_RETENTION_DAYS`). The brief makes retention a design input of the first slice (§11.3, §10 GDPR row) without giving a number. | `doors.service.ts`, daily purge |
| 4 | **Out of scope for P4a:** `services/access-control/` (§11.1 — the cartridge interface is unspecified); credentials, grants and enrolment models (they depend on AC-017); the ADR-059 `SecurityEvent` bridge (§11.8) and any `Security*` enum change (waits for #2350); any dashboard page (P4b), beyond the vocabulary the module-registry consistency tests force; and the shipped Matter lock path, which is untouched (AC-014 is open). | — |

## What P4a builds

- **Schema.** `AccessPoint` (a door: name, `doorPositionSource ∈ {lock, dp1, none}`, held-open time, an explicit `active | retired` status) and `AccessEvent` (the §11.3 fourteen-value `kind`, append-only). Every state is an explicit enum column. `doorPositionSource = none` is a value, not a missing one.
- **Append-only in the database, not by convention.** A BEFORE UPDATE OR DELETE trigger refuses every UPDATE and every DELETE except inside the retention function (`access_event_purge`). A BEFORE INSERT trigger holds §9.7/§11.3: a `forced_door` or `held_open` row must reference a `door_open` row of the same door (a unique index allows one alarm of each kind per opening), and a door whose `doorPositionSource` is `none` can have no `door_open`, `door_closed`, `forced_door` or `held_open` row at all.
- **Door position and claims (§9.7)**, pure: a door's position from its newest event, and what a door may claim (a `none` door claims no forced-door or held-open alarm). Position turns `unknown` when link supervision lapses, and that ships with the supervision writer (P1 link): it is not aged out by the last event, because a device that reports only on change would read `unknown` after every close. The forced-door, held-open, relock and position-unknown derivations are **not built**: they have no caller until `services/access-control/` writes events. Their rules are recorded in `door-derivations.ts`. One must come back with a test when its derivation returns: held-open arms only after a grant or REX, never after `key_override` (§9.7).
- **Module `doors`**, registered in the App-Modules registry and feature-gated from day one, with a boot assertion that it is where it claims to be (§11.2).
- **Routes** under `/api/doors`: list doors, recent events (cursor-paged), and create / update / retire an `AccessPoint`. Reads are for owner and admin; writes are `owner` alone (§11.4) and never a service principal. Every change to a door is audited.
- **No chat tool.** The two reads, `doors_list` and `doors_recent_events`, are deferred to P4b, when the module goes live: while it ships dark, no customer may see the product through the assistant. What P4a keeps is the §11.5 rule as a forward guard: any future tool in the `doors_` namespace must be a read and must never unlock (`packages/tools-core/__tests__/doors-read-only.test.ts`).
- **Retention:** one daily purge at 03:55 on the cron runtime, `DOORS_EVENT_RETENTION_DAYS` days (365 by default), running whether or not `DOORS_ENABLED` is on — rows already written keep identifying people.
- **A boot assertion** (§11.2) that fails the start if the module is on and any list downstream of its descriptor is missing, including the append-only trigger in the database.

## What P4b builds

The dashboard page, and nothing else. Branch `feat/adr-055-doors-dashboard`, stacked on P4a.

- **`/doors`** (`apps/web-dashboard`): the doors with each one's name, position **and when it reported it** ("Closed since 6:02 PM"), where the position comes from, and status; the recent-activity log with cursor paging; and, for the **owner alone**, add / change / retire. Admins read; the controls are not rendered for them, and a 403 that arrives anyway is a friendly toast that withdraws the controls for the visit. A position is never shown without its time, and a report with no time reads as unknown, never as current. A `none` door says plainly that Droplet can't tell whether it is forced open or left open (§9.7); a forced-door row says which claim it makes.
- **Nav, all three surfaces:** one row in Systems (owner/admin, module `doors`) and one Operations chip in the Workspace layout. The registry's `navHrefs` becomes `["/doors"]`.
- **Absent means absent, in the dashboard too.** `listedWhenUnavailable: false` removes the module from `GET /api/modules`, and the dashboard's gate reads "not in the payload" as "a module we can't classify: show it". For a module that ships dark that is wrong, so `ABSENT_UNLESS_LISTED` (`useModuleGate.ts`) names `doors` and reads absent as off. With the module off there is no nav entry and `ModuleRouteGuard` shows its standard "isn't available" card.
- **Copy** follows the Security rules and has its own lint (`components/doors/doors-copy.test.ts`): no monitor, alarm, secure, armed, "all locked" and the rest, and nothing that presents a position as current ("live", "right now", "currently").
- **Held-open time is not on the form.** It is stored (30 s by default) but nothing reads it until the derivation that arms held-open exists, so a control for it would advertise something that does nothing.
- **No chat tools.** WARP-2972 (module gating does not reach the chat pool) is still open on `stage` and on this branch, so `doors_list` and `doors_recent_events` are not added: with the module off the model would still be offered them. They also still need the MCP path narrowed to the acting person's tier. `packages/tools-core/__tests__/doors-read-only.test.ts` keeps guarding the namespace.
- **The role builder still does not offer doors.** A safe deny, unchanged.

## Deviations from the brief, on purpose

- **No tools in P4a, and never four in this slice.** §11.5 lists four read tools. P4a builds none (see above). Two of them, `access_device_status` and `access_cell_health`, read models (`AccessDevice`, `Cell`) that belong to the service slice, so they are not P4b's either.
- **A trigger that covers DELETE.** The `SecurityEvent` trigger (ADR-059) covers UPDATE only and lets retention `DELETE` through by not being asked. Decision 3's retention and §11.3's "never updated" are both honoured here by covering DELETE too and giving the purge one sanctioned path: a plpgsql function that carries the bypass as a function-level `SET`, so the setting holds for exactly that call and is restored on the way out. No application code names it, and a source guard fails if any `.ts` file does.
- **Retention counts from receipt (`createdAt`), not from the device's `occurredAt`.** A device with a wrong clock must not be able to keep a row forever or expire it at once.
- **Corrections are not modelled.** §11.3 says a correction is a new row referencing the old one, but the fourteen kinds include no correction kind, so there is nothing to give that row. It waits for the service slice to say what a correction is.
- **Read floor is `admin`.** The brief asks for grants per door group and an emptied grant set denies (§11.4). Door groups and grants are out of scope, so until they exist the module's own grant is the only narrowing and the floor is set high. The floor is enforced twice: the role list in `routes/doors.ts`, and the access catalog's `view` floor, which for doors is a refusal (`refuseBelowFloor`): a family or guest role cannot store `doors:view` at all, and one stored earlier grants nothing. Widening to `family` is those two lines. The dashboard's role builder does not offer doors yet (P4b), which is a safe deny.
- **The access catalog offers `view` and nothing above it.** Door writes are the owner's and an owner holds every level through the §3 bypass, so a `manage` rung could only advertise a grant no non-owner can use. This adds `doors` to the one documented exception in the "admin ceiling is each module's top level" invariant (beside `team_chat`), pinned exactly.
- **P4b's tools start out of default chat.** Module gating does not yet reach the chat pool for an owner or a role-less user (WARP-2972), so with the module off the model would still be offered a tool whose only answer is "not switched on". They also need the MCP path narrowed to the acting person's tier (the routes admit `_service:mcp` before any role check, so a role-less staff member could otherwise ask the assistant for what the browser refuses them). Both belong with the tools, which wait on WARP-2972 (see [What P4b builds](#what-p4b-builds)).
- **The held-open time defaults to 30 s.** §9.7 names "the door's held-open time" and gives no number. It is a default the owner edits, not a spec value.
- **A strike-only door's unused grant stays outstanding until the door next closes.** There is no latch report there to say the strike re-secured, and the brief defines relock by state, never by a timer. It is part of why that claim is the weaker one. (A note for the derivation that lands with the service slice; nothing here derives it yet.)

## Cross-cutting negative suite (§14)

Applied now: no `doors_*` tool can unlock or write (a forward guard: P4a ships none); no `/api/doors` route lacks the RBAC grant; no in-place `AccessEvent` UPDATE or DELETE (against the trigger, on real Postgres); no forced-door or held-open claim on a `none` door (pure function and database); the module is absent when `DOORS_ENABLED` is off.

Deferred, with the reason: a UID accepted as a credential and an outside-lever turn registering as request-to-exit (no credential model, no device firmware — AC-017 and the firmware repo); a fail-safe device commissioned on cells (no `AccessDevice`); a lock that stops opening from the inside under any software state (a mechanical property, tested on hardware, P1/P3).

## Open

- **AC-001** — is this a product line or a Droplet feature? Founder. Nothing in this slice depends on the answer, and nothing in it commits to a SKU.
- **AC-014** — does the shipped Matter / `control_device` lock path get narrowed to §11.5's rule, or do two locking surfaces with two policies coexist? Stefan / Romain. Untouched here: `control_device` can still carry a lock command through the confirmation-token flow, which §11.5 says no `doors_*` tool may use.
- **AC-017** — where does the credential decision execute, the cartridge's MCU or the Vault? Stefan / Romain. It gates every credential, grant and enrolment model, so none exists here.
