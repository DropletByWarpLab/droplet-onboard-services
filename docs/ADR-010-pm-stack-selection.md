# ADR-010: Adopt Plane as Droplet's embedded project-management stack

> **Superseded by [ADR-026](ADR-026-native-pm-supersedes-plane.md)** (2026-07-26 note).
>
> The embedded Plane PM stack this ADR selected has been removed: project
> management is now a **native module owned by the orchestrator** (native PM,
> ADR-026). See also the retired pilot runbook `docs/PM_PILOT.md`.

- **Status:** Accepted
- **Date:** 2026-05-27 (accepted 2026-05-29)
- **Authors:** Stefan Cruceru (CEO)
- **Related tickets:** WARP-496 (Epic), WARP-497 (this ADR), WARP-498 (spec)
- **Related ADRs:** ADR-002 (network page UX persona), ADR-004 (mobile API + RBAC), ADR-005 (AP onboarding pattern), ADR-006 (poc-rebuild → main reconciliation — concurrent work)

> **ADR-number note:** Originally drafted as ADR-006 against the 2026-05-25 engineering-handbook snapshot, then renumbered to ADR-007 after the ADR-006 collision. ADR-007 was subsequently claimed by `ADR-007-dashboard-redesign-violet-brand-dual-workspace.md` (Accepted, 2026-05-28) — along with ADR-008/ADR-009 for the native-mobile and canonical-architecture ADRs in the same renumber pass. Renumbered again to ADR-010 per `07-jira-workflow/adr-creation-flow.md` collision rule ("the later-merging branch renames before merging").

## Context

Droplet's wedge is regulated SMBs (legal, dental, real-estate, lending, healthcare) who cannot use SaaS productivity tools because the data leaves their compliance boundary. Today the appliance ships AI inference, file storage (Nextcloud), camera/NVR (Frigate), Matter smart-home, voice, and a unified dashboard — but no project-management surface. Customers track work in spreadsheets, email threads, or worse: free-tier SaaS that quietly exfiltrates client matters into a third-party data lake.

Adding a self-hosted PM tool to the appliance extends the compliance wedge into a workflow surface customers actually touch daily. It also creates a high-leverage AI integration target: the LLM agent can read tickets, summarize standups, surface lost opportunities, and create issues from voice — none of which is possible when PM data lives on a SaaS the appliance can't reach.

The decision is now (not later) because (1) the dental discovery on 2026-05-19 explicitly asked for "morning-huddle patient briefings" and "lost-opportunity ID" — both of which need a structured task store on the appliance, (2) Sprint capacity is available after the voice-assistant work (WARP-154) ships, and (3) the photo-studio pilot box is a willing first deployment target. Five FOSS PM tools are realistic candidates; one needs to be picked, with eyes open to the AGPL implications of the leading option.

## Decision

**Adopt Plane (AGPL-3.0) as the embedded PM tool shipped with every Droplet appliance.**

Plane runs as a compose service in `droplet-onboard-services/docker/`, behind the existing Nginx reverse-proxy and TLS cert, with profiles `single-box` and `multi-box` (per architecture-guard rule 17, no `poc` framing). The orchestrator owns user provisioning and the SSO handoff; tools-core gets a new `pm` handler domain so the LLM agent can read and write Plane via MCP. A new dashboard route `/projects` lands the user in Plane authenticated.

We ship vanilla Plane — pinned to upstream releases, with any local patches surfaced in `services/pm/PATCHES.md`. AGPL-3 §13 obligations are honored by linking to upstream from the dashboard footer and offering source on request. This posture matches the existing Nextcloud precedent (also AGPL-3, already shipping).

## Consequences

### Positive

- Compliance wedge extended into a daily-use workflow surface — strongest argument yet for prospects to choose Droplet over SaaS.
- AI integration: the agent gains read/write access to a structured task store, enabling voice-driven workflow features (standup summaries, lost-opportunity surfacing, dictation → ticket).
- Modern UX (Plane is the most Jira-like FOSS option) — SMBs adopt vs. abandoning to email.
- Clean REST API + webhooks + WebSocket — fits MCP tool integration with no custom protocol work.
- Compose deployment pattern matches existing services (Nextcloud, Frigate) — low operational risk.
- Active upstream project with funding — won't get abandoned mid-pilot.

### Negative

- AGPL-3 obligation imposes ongoing discipline: any local patches must be source-available to the customer on request. Mitigation: pin upstream, document patches, link to upstream from the dashboard footer.
- New dependency on a third-party project's release cadence — Plane breaking API changes propagate into our tools-core handlers.
- Storage growth: Plane DB + attachments compete with Frigate footage and Nextcloud files for the same SSD on `single-box`. Mitigation: storage budget in `SINGLE_BOX.md`; default attachment cap; `v2-6` has a dedicated storage brick per `pcb-claude-tool` modular platform spec.
- Adds ~200MB RAM and one Postgres + one Redis to the deploy. Acceptable on a large-memory single-box; tighter on a memory-constrained single-box.

### Neutral

- The PM tool runs inside the Droplet box, so we own the support burden for the integration. Plane-level bugs go upstream; Droplet-level integration bugs are ours.
- The internal Warp Lab Jira backlog (327 tickets in WARP project) stays on Atlassian Cloud for the foreseeable future — this ADR does not migrate internal use. A separate ADR can revisit if dogfooding becomes valuable.

## Alternatives considered

### Alternative 1: Taiga (MPL-2.0)

Mature Django+Angular agile/scrum tool. REST API. MPL-2.0 is more permissive than AGPL-3 — fewer license obligations, simpler for redistribution. Smaller community than Plane, less modern UX, smaller plugin ecosystem.

**Why rejected:** UX gap is the headline — SMBs accustomed to Trello / Asana / Monday will find Taiga's interface dated. The AGPL cost on Plane is manageable given existing Nextcloud precedent. **Fallback choice if Romain rejects AGPL-3.**

### Alternative 2: OpenProject (GPL-3.0)

The most mature/enterprise-feeling FOSS PM tool. Strong Gantt + roadmaps + work-breakdown structures. Rails + Postgres + Memcached. Full REST API.

**Why rejected:** Heavier footprint (Rails warmup ~30s) for marginal UX gain over Plane. Enterprise feature surface (Gantt, work-breakdown) is overkill for SMB use cases — would obscure the simple "create task, assign, comment" flow most customers need.

### Alternative 3: Kanboard (MIT)

Tiny PHP kanban tool. Runs in <100MB. Permissive license. Minimal feature surface.

**Why rejected:** Too minimal — no project hierarchy, no rich roadmaps, weak API. Suits a side-feature, not a headline daily-use tool. Considered as a "lite" V0 but a real PM tool is the strategic ask.

### Alternative 4: Redmine (GPL-2.0)

Ancient (2006-vintage) Ruby on Rails issue tracker. Huge plugin ecosystem. Rock-solid stability. Tired UX.

**Why rejected:** UX is a generation behind every customer's expectations. Plugin sprawl creates per-deployment configuration drift. Stability advantage doesn't compensate for adoption friction.

### Alternative 5: Gitea/Forgejo (built-in issues + projects)

If Droplet were to ship a self-hosted git platform, issues + project boards would come for free. MIT (Gitea) / GPL-3 (Forgejo).

**Why rejected:** Droplet does not ship a git platform and adding one for the sake of PM is an inverted dependency. Issue-tracking is a secondary feature of these tools; the UX gap vs. Plane is large.

## How to apply

### Code-level placement

- **Compose service:** `droplet-onboard-services/services/pm/` (skeleton) + `droplet-onboard-services/docker/docker-compose.yml` (wiring). Profiles: `single-box`, `multi-box`.
- **Env-var prefix:** `DROPLET_PM_*` for every Plane-related env var. NEVER `MATTER_*` (architecture-guard rule 11). NEVER bare `PLANE_*` (collides with Plane's own internal env conventions).
- **Tools-core domain:** `packages/tools-core/src/handlers/pm/` — one file per tool, registered in `registry.ts` with explicit `requiresWrite` and `requiresConfirmation` flags.
- **MCP exposure:** auto-discovered via `services/mcp-server` — no manual registration. The orchestrator's `WRITE_TOOLS` set is derived from `requiresWrite` (architecture-guard rule 3).
- **Webhook receiver:** `apps/orchestrator/src/routes/pm/webhook.ts` (or whatever directory matches existing webhook patterns). HMAC signature verification + RBAC + rate limit. Fail-CLOSED.
- **Dashboard route:** `apps/web-dashboard/src/app/projects/page.tsx` — SSO handoff via `POST /api/pm/sso-token`.
- **Mobile contract:** `docs/mobile-api-contract.md` — new "Project Management" section. Mobile clients consume per architecture-guard rule 5.
- **Backup integration:** Plane's Postgres + attachments volume folded into the existing backup pipeline (whatever Nextcloud uses — mirror that).

### Naming conventions

- Branch: `feat/warp-NNN-<slug>` per `07-jira-workflow/lifecycle.md`. ADR branch: `adr/warp-497-pm-stack-selection`.
- PR titles include WARP key: `WARP-NNN: <subject>`.
- Tool names in `tools-core`: `pm.list_projects`, `pm.create_issue`, etc. (snake_case under `pm.` namespace).

### Things to grep for

- Existing AGPL service precedent: `grep -r "AGPL" droplet-onboard-services/services/`
- Existing webhook receiver patterns: `find apps/orchestrator/src/routes -name "*webhook*"`
- Existing third-party compose services: `grep -A 20 "nextcloud:" docker/docker-compose.yml`
- Existing tool-domain folder pattern: `ls packages/tools-core/src/handlers/`

### Tests to add

- Per `08-templates/new-service-checklist.md`: unit tests for the service, integration tests for the orchestrator routes, security tests for the webhook auth, ship-check + test-security additions for Plane-specific patterns. Every test added in the same PR as the feature, not as a follow-up.

## Open questions

1. **Shared Postgres vs. dedicated `postgres-pm`** — locked in spec WARP-498 before Phase 1 compose wiring (WARP-501) begins. Default proposal: dedicated, for backup/restore simplicity. ~200MB RAM cost.
2. **Iframe vs. full-redirect for dashboard `/projects`** — locked in spec WARP-498. Default: iframe (better UX). Fallback: full redirect (simpler CSP).
3. **Plane upstream pin strategy** — pin to a specific tag or commit SHA? Decision in spec WARP-498. Default: commit SHA, refreshed per Droplet release.
4. **Mobile API envelope mapping** — Plane's data shapes may not align cleanly with our existing mobile-API envelope. Surface in spec; adjust envelope (with mobile-lead sign-off) if needed before WARP-513 begins.
5. **Workspace-owner downgrade behavior** — Plane may not allow programmatic downgrade of the workspace owner. Document fallback in WARP-506 implementation.
