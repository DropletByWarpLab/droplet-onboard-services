# ADR-026: Native Droplet PM module supersedes the embedded Plane stack

- **Status:** Accepted
- **Date:** 2026-06-21
- **Authors:** Stefan Cruceru (CEO)
- **Supersedes:** ADR-010 (Adopt Plane as Droplet's embedded project-management stack)
- **Related ADRs:** ADR-007 (dashboard redesign / design system), ADR-004 (mobile API + RBAC), ADR-011 (hardware-agnostic codebase), ADR-014 (LLM client-dispatched actions), ADR-002 (home-user persona)
- **Related tickets:** native-PM epic (to be filed); supersedes the Plane epic WARP-496 and its children (WARP-497/498/502/505/506/507/508/509/511/512/513, WARP-867, WARP-870)

## Context

ADR-010 adopted **Plane (AGPL-3.0)** as the embedded PM tool: a 10-container compose stack
(`pm` profile) fronted by a dedicated `:8443` TLS origin and embedded in the dashboard's
`/projects` tab via an `<iframe>`. SSO was designed (WARP-505/512) as **OIDC with Plane as the
relying party and the orchestrator as the IdP** — the user's dashboard session was supposed to
mint an ID token so they land in Plane already authenticated.

That design has a fatal, unfixable flaw discovered in deployment:

1. **Plane Community Edition no longer ships OIDC/SAML SSO — it was moved into the paid Commercial
   tier** ([Plane docs](https://developers.plane.so/self-hosting/govern/oidc-sso), upstream
   [issue #8047](https://github.com/makeplane/plane/issues/8047); live-probed on `192.168.1.87`
   2026-06-11). The orchestrator's entire OIDC IdP (`routes/pm.ts`, `pm-oidc.service.ts`,
   `pm-session.service.ts`) is therefore wired against a feature CE cannot consume. The iframe
   falls through to Plane's own email/password login → **the user is forced to sign in a second
   time**, and the tab frequently surfaces a blocked/empty iframe.
2. **It can't be made cohesive or de-branded.** Plane is a whole third-party React application with
   its own design language; an embedded `:8443` iframe fundamentally cannot match Droplet's
   bento/indigo design system, violating the standing cross-viewport UI-cohesion rule. Asset
   interception (WARP-870) only reaches the logo/favicon; "Plane" strings live in content-hashed JS
   bundles and surface throughout the product.
3. **It is heavy.** The `pm` profile is **10 containers + 4 volumes** (~2.5 GB always-on, up to
   ~4.8 GB) plus an ongoing AGPL-3 §13 source-availability obligation and a dependency on Plane's
   upstream release cadence.

The three things the product needs from a PM surface — **one login, fully Droplet-branded, and
LLM-native** — are exactly the three things the embedded Plane CE cannot provide without paying
per-seat Commercial licensing on an offline, one-time-purchase appliance. The integration work was
not wasted understanding: it produced a clean, stable **MCP tool contract** (9 `pm_*` tools) and a
mobile read contract that we keep verbatim — only the backend behind them changes.

## Decision

**Replace the embedded Plane stack with a native, first-class project-management module owned by the
Droplet control plane, then remove Plane entirely.**

- **Data** lives in the orchestrator's own Postgres via Prisma (`Pm`-prefixed models). Plane held
  all PM state and we keep none of it, so this is greenfield — no data migration.
- **Auth/RBAC is the existing one.** Routes sit behind `authMiddleware` + `requireRole(...)` and the
  `Role` enum (owner/admin/family → write, guest → read-mostly, service → denied). There is no second
  login, no IdP, no OIDC — the dashboard session *is* the auth.
- **The LLM/MCP contract is preserved byte-for-byte.** The 9 `pm_*` tools keep their exact input/
  output schemas and `requiresWrite`/`requiresConfirmation` flags; their handlers are repointed from
  Plane's `/api/v1` to the orchestrator's native `/api/pm/*` routes via `ctx.http.orchestrator`
  (tool dispatch routes through the orchestrator, per architecture-guard). A single seeded `home`
  workspace keeps the contract's `workspace_slug` meaningful.
- **The dashboard renders it natively** in the bento design system (`/projects` page, ADR-007 tokens)
  — Kanban board, list, and work-item detail — so it is indistinguishable from the rest of Droplet.
- **Target is full Plane-equivalent:** projects, work items (status/priority/assignee/labels/due
  dates/sub-issues), comments, cycles/sprints, modules, custom fields, attachments, and an activity
  feed.

Then the Plane stack is deleted: the 10 compose services + 4 volumes, the `:8443` nginx origin and
`/pm/` redirect, the OIDC IdP routes/services, the `DROPLET_PM_*` secrets/env/config, and the old
tools-core Plane client.

## Consequences

### Positive

- **One login.** PM authenticates with the dashboard session by construction — the headline user
  complaint is resolved structurally, not patched.
- **Fully Droplet-branded and cohesive.** The surface is ours, built on the design system; it
  satisfies the cross-viewport UI-cohesion rule that an iframe never could.
- **LLM-native.** The agent reads/writes real Droplet PM data through the same MCP tools, backed by
  the orchestrator rather than a third party — and gains the orchestrator's auth, audit, and
  confirmation gating for free.
- **~2.5 GB+ RAM reclaimed** on the single-box and 10 fewer containers to operate, monitor, and back
  up; PM data joins the orchestrator's existing Postgres backup path.
- **No AGPL-3 obligation, no upstream-cadence coupling.** We own the surface end-to-end.

### Negative

- **A real build.** Re-implementing the PM data model, API, and UI is substantial (six phased PRs).
  Mitigation: the MCP/mobile contracts and the dashboard slot already exist as fixed targets, and
  each phase ships independently with the box bootable; Plane is removed only after native is proven.
- **We now own PM features outright** — parity items (Gantt, advanced reporting) are our backlog, not
  an upstream's. Acceptable: the SMB use cases ADR-010 targeted are squarely in the equivalent scope.
- **Rich text + attachments are net-new infra.** Mitigation: Tiptap (Plane's own editor) for HTML
  bodies and a single orchestrator-managed `pm-attachments` volume served via an authenticated route
  — no MinIO, no new services.

### Neutral

- Reverses an Accepted ADR. The AGPL posture was Romain's sign-off item in ADR-010; this change
  *removes* that obligation, so it is informational for him, not blocking.
- The internal Warp Lab Jira backlog stays on Atlassian Cloud — unchanged by this ADR.

## Alternatives considered

### Alternative 1: Buy Plane Commercial (per-seat SSO)

Pay for the Commercial tier to restore OIDC. **Rejected:** per-seat SaaS licensing on an offline,
one-time-purchase appliance is antithetical to the product (and to the regulated-SMB privacy wedge),
and it still leaves the un-cohesive, un-brandable iframe and the 10-container footprint.

### Alternative 2: Fork/patch the Plane image for SSO + de-brand

Carry local patches to inject session auth and rewrite branding. **Rejected:** patching auth into a
large third-party React/Django app is a permanent maintenance liability across upstream bumps
(explicitly avoided in WARP-870, which kept the image vanilla), and it still can't match the design
system.

### Alternative 3: Swap Plane for another self-hosted PM (Taiga/OpenProject/etc.)

ADR-010's fallbacks. **Rejected:** every embedded third-party tool has the same two structural
problems — a separate auth realm and a foreign design language in an iframe — plus its own footprint.
The cohesion and single-login requirements are only satisfiable by a native surface.

## How to apply

Phased, one PR per phase; the box stays bootable throughout and Plane is removed last.

1. **Foundation (this ADR):** `Pm`-prefixed Prisma models in
   `apps/orchestrator/prisma/schema.prisma` + migration `…/migrations/20260621000000_native_pm_foundation/`.
   No behavior change.
2. **Orchestrator API:** `apps/orchestrator/src/routes/pm/*` REST routes (projects/states/labels/
   work-items/comments + transition) behind `authMiddleware`/`requireRole`; every mutation writes a
   `PmActivity` row. Template: `routes/calendar.ts`.
3. **MCP + mobile repoint:** rewrite the 9 handlers in `packages/tools-core/src/handlers/pm/` to call
   `ctx.http.orchestrator` (template: `handlers/cameras/list-cameras.ts`); repoint
   `routes/mobile/pm.ts`. `GET /api/llm/tools` must be byte-identical before/after.
4. **Dashboard:** replace the `apps/web-dashboard/src/app/projects/page.tsx` iframe with a native
   bento surface; repoint the setup wizard `PmStep.tsx` to auto-seed the `home` workspace + an
   `Inbox` project with a default state set.
5. **Full-equivalent extensions:** cycles, modules, sub-issues, custom fields, attachments
   (orchestrator-managed volume + authenticated `GET /api/pm/attachments/:id`), activity feed.
6. **Remove Plane:** delete the `pm` compose profile, the nginx `:8443` origin + `/pm/` redirect, the
   `DROPLET_PM_*` secrets/env/config, and the OIDC routes/services + old tools-core Plane client.
   Validate via a full `192.168.1.87` reflash before merge.

### Naming conventions

- All Prisma models and DB tables are `Pm`-prefixed to stay clear of the existing dashboard
  `Workspace`/`WorkspaceType` (ADR-007) and `ActivityRow`.
- Native HTTP routes live under `/api/pm/*`; no `DROPLET_PM_*` env vars are introduced (the native
  module needs none — it uses the orchestrator's DB + session auth).
- MCP tool names are unchanged (`pm_list_projects`, `pm_create_work_item`, …) to preserve the contract.

### Tests to add

- vitest on the orchestrator routes (CRUD + RBAC matrix + activity rows) and on the repointed
  tools-core handlers (wire-shape parity), per the new-service checklist — in the same PR as each
  phase, not as a follow-up.
