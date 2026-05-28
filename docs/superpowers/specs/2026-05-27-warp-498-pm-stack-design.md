# Plane (PM stack) on Droplet — design

**Date:** 2026-05-27
**Status:** Draft — 4 of 5 open questions resolved; OQ4 pending iOS/Android lead input
**Scope:** New `services/pm/` directory + `docker/docker-compose.yml` wiring + `apps/orchestrator/src/routes/pm/*` + `apps/web-dashboard/src/app/projects/page.tsx` + `packages/tools-core/src/handlers/pm/*` + `services/mcp-server` auto-discovery + `docs/mobile-api-contract.md` additions.
**ADR:** [ADR-007 — Plane self-hosted PM stack adoption](../../ADR-007-pm-stack-selection.md) (Proposed)
**Epic:** WARP-496
**Ticket:** WARP-498

> **Status update 2026-05-27 (Stefan):** OQ1, OQ2, OQ3, OQ5 resolved to the recommended defaults. OQ4 (mobile API envelope mapping) remains open — needs iOS + Android lead input on whether Plane's data shapes fit the existing envelope. Phase 1 tickets (WARP-500..504) can begin work on the resolved surfaces; Phase 4 ticket WARP-513 is blocked until OQ4 lands.

## Engineering handbook references (binding)

All implementation tickets under Epic WARP-496 must comply with:

- [`04-coding-standards/code-quality-rules.md`](https://github.com/DropletByWarpLab/warp-lab-engineering-handbook) — rules 1 (shipping-product mindset), 7 (no `any`), 9 (no `while True` scheduling), 11 (no `MATTER_*` env vars), 13 (one configured LLM only), 14 (no host-specific defaults), 17 (no "poc"/"test"/"dev"/"prototype" framing in user-facing surfaces).
- `04-coding-standards/security-rules.md` — fail-CLOSED on auth, no fail-OPEN, secrets in `.env` mode 0600.
- `04-coding-standards/pr-scope-and-coherence.md` — body matches diff, no mixed-scope PRs; sweep on rename.
- `08-templates/new-service-checklist.md` — every item required before any Phase 1 PR can merge.
- `07-jira-workflow/lifecycle.md` — AC-drift rule applies if Plane's actual API diverges from this spec mid-implementation: STOP, surface, decide.
- `03-claude-harness/skills/droplet-architecture-guard/SKILL.md` — rules 1–21, especially repo-boundary rules 1–8 and the pre-flight checklist for every coding ticket.
- `02-architecture/adrs/ADR-004-rbac-per-route-guards.md` — authority for the JWT shape, role claims, and mobile API contract conventions.

---

## Overview

Embed [Plane](https://plane.so) (AGPL-3.0) as a compose service inside `droplet-pi-platform`, behind the existing Nginx reverse-proxy. The orchestrator owns identity (JWT → Plane session handoff) and the LLM agent gets a new `pm` tool domain via `packages/tools-core` + MCP. Mobile clients consume read-only endpoints via the existing mobile-API contract.

This spec defines the contracts and surfaces; Phases 1–6 in [WARP-496](https://warp-lab.atlassian.net/browse/WARP-496) implement them.

---

## Container topology

> **Decision (OQ1 resolved):** Dedicated `postgres-pm` + `redis-pm` containers. Plane's schema migrations are quarantined from the orchestrator's Prisma migrations; backup/restore granularity is per-volume; ~200MB RAM cost is acceptable on every shipping deployment shape (architecture-guard rule 16 — every shape is shipping product).

**Final topology:**

```
┌─────────────────────────────────────────────────────────────────┐
│  droplet-pi-platform compose network                            │
│                                                                  │
│   nginx ─────► pm-web (port 3000 internal) ──┐                  │
│      │                                        │                  │
│      └─► dashboard, nextcloud, ...            ▼                  │
│                                          pm-api (8000)           │
│                                               │                  │
│                                               ├─► postgres-pm    │
│                                               ├─► redis-pm       │
│                                               └─► pm-worker      │
│                                                                  │
│   orchestrator ──► pm-api (admin token, server-to-server)        │
└─────────────────────────────────────────────────────────────────┘
```

| Service | Image | Internal port | Profile | Notes |
|---|---|---|---|---|
| `pm-web` | `makeplane/plane-frontend:<pinned-sha>` | 3000 | `single-box`, `multi-box` | Next.js. Behind Nginx; never exposed on host. |
| `pm-api` | `makeplane/plane-backend:<pinned-sha>` | 8000 | `single-box`, `multi-box` | Django REST API. Server-to-server only from orchestrator. |
| `pm-worker` | `makeplane/plane-worker:<pinned-sha>` | — | `single-box`, `multi-box` | Celery worker for async jobs. |
| `postgres-pm` | `postgres:15-alpine` | 5432 | `single-box`, `multi-box` | Dedicated per OQ1 resolution. Volume `postgres-pm-data`. |
| `redis-pm` | `redis:7-alpine` | 6379 | `single-box`, `multi-box` | Dedicated per OQ1 resolution. Volume `redis-pm-data`. |

---

## Nginx routing

> **Decision (OQ2 resolved):** Iframe at `/pm/` — keeps Droplet chrome (left nav, top bar) so the user feels like they're still on the appliance. Plane's CSP `frame-ancestors` must allow `'self'` (verified at Phase 1 start; patched if upstream doesn't allow it — patch recorded in `services/pm/PATCHES.md` per ADR-007 posture).

**Final routing:**

```nginx
location /pm/ {
    proxy_pass http://pm-web:3000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    # Plane's CSP needs frame-ancestors loosened — see OQ2
}
```

`WEB_URL` env on Plane must match the LAN-facing URL so generated emails / share links point to the appliance, not localhost.

---

## Env-var schema

All Plane-related env vars use the `DROPLET_PM_*` prefix. **Never `MATTER_*`** (collides with matter.js VariableService per code-quality rule 11). **No host-specific defaults** (rule 14) — defaults must work on a brand-new install or fail loud.

| Var | Default | Required | Validated at | Description |
|---|---|---|---|---|
| `DROPLET_PM_SECRET_KEY` | generated by `setup.sh` on first run | yes | service start (Zod-equivalent in Plane config) | Plane's Django `SECRET_KEY`. Written to `.env` mode 0600. |
| `DROPLET_PM_DB_PASSWORD` | generated by `setup.sh` on first run | yes | service start | Postgres password for `postgres-pm`. |
| `DROPLET_PM_ADMIN_TOKEN` | generated by `setup.sh` on first run | yes | orchestrator startup | Used by orchestrator to provision users (NOT exposed to dashboard). |
| `DROPLET_PM_WEB_URL` | `https://${HOSTNAME}/pm` | yes | service start | LAN-facing URL for generated links. |
| `DROPLET_PM_WEBHOOK_SECRET` | generated by `setup.sh` on first run | yes | orchestrator startup | HMAC signing key for Plane → orchestrator webhooks. |
| `DROPLET_PM_DEFAULT_WORKSPACE` | `customer-business-name` (from setup wizard) | no | onboarding wizard endpoint | First workspace seeded on fresh install. |

---

## Identity bridge (SSO)

> Implemented in WARP-505.

Flow:

```
1. User clicks "Projects" in dashboard.
2. Dashboard JS calls POST /api/pm/sso-token (orchestrator).
3. Orchestrator validates the dashboard JWT (existing middleware per ADR-004).
4. Orchestrator looks up the Plane user by email claim:
   - If user exists → reuse.
   - If absent → create via DROPLET_PM_ADMIN_TOKEN against pm-api.
5. Orchestrator exchanges admin-token for a per-user session token via Plane's API.
6. Orchestrator returns { url: "https://gateway/pm/?token=...", expires_at }.
7. Dashboard redirects (or sets iframe src) to the returned URL.
```

**Failure modes:**

- Invalid JWT → 401, no Plane user touched.
- Plane API down → 503, dashboard shows actionable error per UX guidelines.
- Per-user token issuance fails → 500, structured log emitted, no fail-OPEN.

Session lifetime: ≤ 15 min, refreshable via the same endpoint.

---

## RBAC mapping

> Implemented in WARP-506. Authority: ADR-004 (RBAC per-route guards).

| Droplet role | Plane workspace role | Notes |
|---|---|---|
| `admin` | `admin` | Full workspace control. |
| `user` | `member` | Standard project participation. |
| (anonymous) | (denied) | No SSO handoff issued. |

Sync triggers:
- SSO handoff (`POST /api/pm/sso-token`) — confirms current role before exchange.
- Droplet role-change event (existing auth-service event) — calls Plane's update-role API.

**Fail-CLOSED:** If role sync API call fails, user is denied PM access until reconciled. Reconciliation alert emitted via the existing alert channel.

---

## MCP tools (read + write)

> Read tools implemented in WARP-508. Write tools in WARP-509. MCP integration in WARP-510.

Per architecture-guard rule 3: tools live ONLY in `packages/tools-core/src/handlers/pm/`. The orchestrator's `WRITE_TOOLS` set is **derived** from each tool's `requiresWrite` field — DO NOT hand-edit.

### Read tools (all `requiresWrite=false`, `requiresConfirmation=false`)

| Tool | Args | Plane endpoint | Notes |
|---|---|---|---|
| `pm.list_projects` | `(workspace_id?)` | `GET /api/v1/workspaces/{ws}/projects/` | Default = user's primary workspace. |
| `pm.list_issues` | `(project_id, status?, assignee?, limit?)` | `GET /api/v1/workspaces/{ws}/projects/{p}/issues/` | Limit capped at 100 per rule 11. |
| `pm.get_issue` | `(project_id, issue_id)` | `GET /api/v1/.../issues/{id}/` | |
| `pm.search_issues` | `(query, project_id?, limit?)` | `GET /api/v1/workspaces/{ws}/search/` | Fallback to client-side filter if Plane search is too narrow. |

### Write tools (all `requiresWrite=true`, `requiresConfirmation=true`)

| Tool | Args | Plane endpoint | Notes |
|---|---|---|---|
| `pm.create_issue` | `(project_id, title, description?, assignee?, labels?)` | `POST /api/v1/.../issues/` | Confirmation prompt before execute. |
| `pm.update_issue` | `(issue_id, fields)` | `PATCH /api/v1/.../issues/{id}/` | |
| `pm.add_comment` | `(issue_id, body)` | `POST /api/v1/.../issues/{id}/comments/` | |
| `pm.transition_issue` | `(issue_id, state)` | `PATCH /api/v1/.../issues/{id}/` (state field) | Confirmation includes from→to state. |

All HTTP calls go through `packages/tools-core/src/handlers/pm/pm-client.ts` — single auth + retry + error-mapping point. Write tools attribute to the user via the per-user token from SSO (not admin token), so Plane's audit log is correct.

---

## Webhook design

> Implemented in WARP-511.

`POST /api/pm/webhook` on the orchestrator. Plane fires on: issue created, updated, transitioned, commented.

**Authentication:**
- HMAC signature header (Plane's outgoing-webhook secret), validated using `DROPLET_PM_WEBHOOK_SECRET`.
- Replay-window: 5 min (validated via Plane's timestamp header).
- **Fail-CLOSED** on any auth failure → 401, payload discarded, structured log (`event_type=webhook_auth_failure`).

**Rate limit:** 100 req/min per source IP (existing rate-limit middleware).

**Routing:** Valid payload → in-process event bus (or NATS if already in use; spec to confirm). Downstream consumers (AI summarization, voice notifications, mobile push) are **out of scope** for V1 — only the receiver lands.

---

## Mobile API contract

> Implemented in WARP-513. Lives in `docs/mobile-api-contract.md` per architecture-guard rule 5.

V1 = read-only on mobile. Endpoints:

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/mobile/pm/projects` | Paginated list of user's projects (limit 50, max 100). |
| `GET` | `/api/mobile/pm/issues?project_id=&status=&assignee=` | Paginated issues. |
| `GET` | `/api/mobile/pm/issues/{id}` | Single issue with comments. |

All wrap Plane's API via per-user token from SSO. JWT middleware from existing mobile-API stack. Response envelope mirrors existing mobile endpoints (no new envelope shape).

**Out of scope for V1:** writes from mobile, push notifications, native UI beyond list/detail views.

---

## Backup / restore

> Implemented in WARP-514.

Plane's `postgres-pm` volume + attachments volume folded into the existing Droplet backup pipeline (mirror Nextcloud's pattern — it's the closest precedent, also stores customer data in PG + filesystem volumes).

- Backup runs on the existing schedule (no `while True` per rule 9 — use the team's scheduler).
- Restore tested end-to-end on the lab box before WARP-514 closes: take backup → wipe Plane volumes → run restore → verify projects + issues + attachments + users restored.
- Backup-failure alerting flows through the existing alert channel.
- No PII in backup logs (rule 9 — scrubbed structured logs).

---

## Observability

- `/health` endpoint on `pm-web` returns `{"status":"ok","service":"pm","version":"<plane-version>"}` per `engineering-handbook/08-templates/new-service-checklist.md`.
- Structured JSON logs from orchestrator's PM-touching code (tool name, requesting user, target Plane object) — no PII per rule 9.
- Plane's own logs forwarded via the existing log pipeline.
- Metrics (if Plane exposes `/metrics`) scraped by the existing Prometheus stack.

---

## Open questions

Originally 5 gates on Phase 1. As of 2026-05-27, 4 are resolved (locked to the recommended default by Stefan). OQ4 remains open — Phase 1 + Phases 2–3 can proceed; only WARP-513 (mobile contract) is blocked.

### OQ1 — Shared vs. dedicated Postgres/Redis — **RESOLVED**

**Question:** Does Plane share the orchestrator's existing Postgres + Redis containers, or get its own?

**Options:**
- **A (chosen):** Dedicated `postgres-pm` + `redis-pm` containers. Costs ~200MB RAM. Simplifies backup/restore (separate volumes). Plane's schema migrations don't touch orchestrator data.
- B: Shared with the orchestrator. Saves RAM. Complicates backup (must restore at table-granularity). Forces coordination between Plane's migration tooling and Droplet's Prisma migrations — risk of one breaking the other.

**Decision (2026-05-27):** **A — dedicated.** The migration-coordination risk in B outweighs the RAM saving on every shipping deployment shape (architecture-guard rule 16 — `single-box`, `multi-box`, `v2-6` are all production). Cascade unblocked: WARP-501 (compose wiring) + WARP-514 (backup design).

### OQ2 — Iframe vs. full redirect for dashboard `/projects` — **RESOLVED**

**Question:** Does the dashboard `/projects` route iframe Plane (keeping Droplet chrome) or redirect to it (showing Plane chrome)?

**Options:**
- **A (chosen):** Iframe. Better UX — left nav and top bar stay. Requires Plane's CSP `frame-ancestors` to allow `'self'` (verify in Plane config; potentially patch).
- B: Full redirect. Simpler CSP. Worse UX — user feels like they left the appliance.

**Decision (2026-05-27):** **A — iframe.** UX continuity matters more than CSP simplicity for the regulated-SMB persona (ADR-002 home-user supervision). Any required CSP patch is recorded in `services/pm/PATCHES.md` per ADR-007 AGPL posture. Cascade unblocked: WARP-512 (dashboard route).

### OQ3 — Plane upstream pin strategy — **RESOLVED**

**Question:** Pin Plane to a release tag (e.g. `v0.18.0`) or a commit SHA?

**Options:**
- **A (chosen):** Commit SHA. Reproducible across rebuilds. Updated explicitly per Droplet release.
- B: Release tag. Simpler. Plane could move the tag (unlikely but possible).

**Decision (2026-05-27):** **A — commit SHA.** Pinning to a SHA matches code-quality rule 1 (shipping-product mindset — no implicit drift between Droplet releases). The SHA refresh is a deliberate per-release decision, not an upstream-induced surprise. Cascade unblocked: WARP-500 (Dockerfile FROM line).

### OQ4 — Mobile API envelope mapping — **STILL OPEN**

**Question:** Does Plane's data shape fit the existing mobile-API response envelope cleanly, or does the envelope need to flex?

**Options:**
- A: Plane data fits the existing envelope as-is. Map at the orchestrator wrapper.
- B: Envelope needs a new variant — coordinate with iOS/Android leads, possibly extend ADR-004.

**Status:** Awaiting iOS + Android lead input. **Next action:** before WARP-513 starts, post a side-by-side of Plane's `Issue` + `Project` JSON vs. the existing mobile envelope in the WARP-513 ticket comment; request explicit A/B from both leads. If B, escalate per AC-drift rule (`07-jira-workflow/lifecycle.md`) and extend ADR-004 in a separate PR before WARP-513 begins.

**Phase impact:** does NOT block Phase 1, Phase 2, Phase 3, or Phase 5. Blocks only Phase 4's WARP-513 (mobile contract). Phase 4's WARP-512 (dashboard route) is unblocked by OQ2 resolution.

### OQ5 — Workspace-owner downgrade behavior — **RESOLVED**

**Question:** Plane's workspace-role API may not allow programmatic downgrade of the workspace owner. What's the fallback?

**Options:**
- **A (chosen):** Document that the workspace owner cannot be downgraded automatically; surface as a manual reconciliation alert.
- B: Re-create the workspace under a different owner whenever a Droplet admin downgrades the original.

**Decision (2026-05-27):** **A — manual reconciliation alert.** B is heavyweight and destructive (re-creating a workspace loses local history, breaks integrations). The reconciliation alert routes through the existing alert channel (per security-rules.md fail-CLOSED posture — user is denied PM access until reconciled). Cascade unblocked: WARP-506 (RBAC mapping).

---

## References

- ADR: [ADR-007 — Plane self-hosted PM stack adoption](../../ADR-007-pm-stack-selection.md)
- Epic: WARP-496
- Tickets: WARP-497 (ADR), WARP-498 (this spec), WARP-499 (legal), WARP-500..517 (implementation)
- Plane upstream: [makeplane/plane](https://github.com/makeplane/plane)
- Engineering handbook: `08-templates/new-service-checklist.md`, `04-coding-standards/code-quality-rules.md`, `03-claude-harness/skills/droplet-architecture-guard/SKILL.md`
- Closest service precedent: Nextcloud (in `docker/docker-compose.yml`) — third-party customer-facing compose service with auth handoff and backup integration.
- Closest tool-domain precedent: `packages/tools-core/src/handlers/rag/` — new-domain folder structure to mirror.
