# Plane (PM stack) on Droplet — design

**Date:** 2026-05-27
**Status:** Draft — 5 of 6 open questions resolved (OQ4 locked 2026-05-28); OQ6 (Plane SSO architecture) added 2026-05-28 after upstream-API verification, resolved same day to OIDC.
**Scope:** New `services/pm/` directory + `docker/docker-compose.yml` wiring + `apps/orchestrator/src/routes/pm/*` + `apps/web-dashboard/src/app/projects/page.tsx` + `packages/tools-core/src/handlers/pm/*` + `services/mcp-server` auto-discovery + `docs/mobile-api-contract.md` additions.
**ADR:** [ADR-010 — Plane self-hosted PM stack adoption](../../ADR-010-pm-stack-selection.md) (Proposed)
**Epic:** WARP-496
**Ticket:** WARP-498

> **Status update 2026-05-27 (Stefan):** OQ1, OQ2, OQ3, OQ5 resolved to the recommended defaults. OQ4 (mobile envelope) and OQ6 (SSO architecture, added below) still open. Phase 1 tickets (WARP-500..504) can begin work on the resolved surfaces.
>
> **Status update 2026-05-28 (Stefan):** OQ4 locked to **A** — orchestrator transforms Plane shapes into the existing mobile envelope, no new variant. WARP-513 unblocked.
>
> **Status update 2026-05-28 (Plane-API verification pass):** Hit reality during WARP-505 PR #307. Plane upstream API is **workspace-slug-centric** (`/api/v1/workspaces/{slug}/...`), uses **`X-API-Key`** auth header (not `Authorization: Bearer`), calls issues **`work-items`**, and exposes **no documented admin-mints-per-user-session-token endpoint**. Plane's only documented SSO path is **OIDC** (Plane is the relying party, an external IdP authenticates the user). Added OQ6 to capture this and locked it to **A** — orchestrator runs a minimal OIDC IdP for Plane. PR #307 (WARP-505) needs a redesign per OQ6 before merge.

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

Embed [Plane](https://plane.so) (AGPL-3.0) as a compose service inside `droplet`, behind the existing Nginx reverse-proxy. The orchestrator owns identity (JWT → Plane session handoff) and the LLM agent gets a new `pm` tool domain via `packages/tools-core` + MCP. Mobile clients consume read-only endpoints via the existing mobile-API contract.

This spec defines the contracts and surfaces; Phases 1–6 in [WARP-496](https://warp-lab.atlassian.net/browse/WARP-496) implement them.

---

## Container topology

> **Decision (OQ1 resolved):** Dedicated `postgres-pm` + `redis-pm` containers. Plane's schema migrations are quarantined from the orchestrator's Prisma migrations; backup/restore granularity is per-volume; ~200MB RAM cost is acceptable on every shipping deployment shape (architecture-guard rule 16 — every shape is shipping product).

**Final topology:**

```
┌─────────────────────────────────────────────────────────────────┐
│  droplet compose network                                        │
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
| `pm-worker` | `makeplane/plane-backend:<pinned-sha>` + `./bin/docker-entrypoint-worker.sh` | — | `single-box`, `multi-box` | Celery worker for async jobs. Plane does not publish a standalone worker image; the worker runs from the backend image via the bundled entrypoint (WARP-575). |
| `pm-migrator` | `makeplane/plane-backend:<pinned-sha>` + `./bin/docker-entrypoint-migrator.sh` | — | `single-box`, `multi-box` | One-shot Django migration runner (`restart: "no"`). `pm-api` runs `wait_for_migrations` and never migrates itself, so this must complete first; `pm-api`/`pm-worker` gate on it via `service_completed_successfully` (WARP-496). |
| `postgres-pm` | `postgres:15-alpine` | 5432 | `single-box`, `multi-box` | Dedicated per OQ1 resolution. Volume `postgres-pm-data`. |
| `redis-pm` | `redis:7-alpine` | 6379 | `single-box`, `multi-box` | Dedicated per OQ1 resolution. Volume `redis-pm-data`. |

---

## Nginx routing

> **Decision (OQ2 resolved):** Iframe at `/pm/` — keeps Droplet chrome (left nav, top bar) so the user feels like they're still on the appliance. Plane's CSP `frame-ancestors` must allow `'self'` (verified at Phase 1 start; patched if upstream doesn't allow it — patch recorded in `services/pm/PATCHES.md` per ADR-010 posture).

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
4. Orchestrator already authenticated via dashboard JWT → issues OIDC ID token + access token (signed with the orchestrator's existing JWT_SECRET HMAC key OR a dedicated RS256 keypair if Plane requires it).
5. Plane's OIDC callback receives the tokens, exchanges via `/auth/userinfo`, creates/updates the local Plane user with the `email` claim (and optional `first_name` / `last_name`).
6. Plane sets its own session cookie; user is in.

**Plane upstream config required (per https://developers.plane.so/self-hosting/govern/oidc-sso):**

- Plane god-mode → `/god-mode/authentication/oidc/` — set CLIENT_ID, CLIENT_SECRET, TOKEN_URL, USER_INFO_URL, AUTHORIZE_URL, JWKS_URL.
- Callbacks Plane expects:
  - Origin: `https://<gateway>/pm/auth/oidc/`
  - Callback: `https://<gateway>/pm/auth/oidc/callback/`
  - Logout: `https://<gateway>/pm/auth/oidc/logout/`

**Orchestrator OIDC IdP endpoints (per OQ6 resolution):**

- `GET /api/pm/oidc/.well-known/openid-configuration` — discovery doc
- `GET /api/pm/oidc/.well-known/jwks.json` — public key set
- `GET /api/pm/oidc/authorize` — redirects to dashboard login if no session, otherwise back to Plane callback with `code`
- `POST /api/pm/oidc/token` — exchanges `code` for ID token + access token
- `GET /api/pm/oidc/userinfo` — returns `{ sub, email, first_name, last_name }` from the existing dashboard session

**Failure modes:**

- Invalid JWT → 401 on the orchestrator side, OIDC flow short-circuits before Plane sees anything.
- Plane misconfigured → Plane displays its own error; orchestrator logs OIDC discovery probes as warnings.
- ID token signature mismatch → Plane refuses; orchestrator structured log emits `event_type=oidc_token_issued` with the requesting `sub`.

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

**Verified against Plane upstream API docs 2026-05-28:** endpoints are workspace-slug-centric, auth header is `X-API-Key` (NOT `Authorization: Bearer`), and issues are called `work-items`. Spec adjusted to match.

| Tool | Args | Plane endpoint | Notes |
|---|---|---|---|
| `pm.list_projects` | `(workspace_slug)` | `GET /api/v1/workspaces/{workspace_slug}/projects/` | Slug discovered via `pm.list_workspaces`. |
| `pm.list_workspaces` | `()` | `GET /api/v1/workspaces/` | New — workspace_slug discovery for downstream tools. |
| `pm.list_work_items` | `(workspace_slug, project_id, status?, assignee?, per_page?)` | `GET /api/v1/workspaces/{ws}/projects/{p}/work-items/` | `per_page` capped at 100 per rule 11. Cursor pagination. |
| `pm.get_work_item` | `(workspace_slug, project_id, work_item_id)` | `GET /api/v1/workspaces/{ws}/projects/{p}/work-items/{id}/` | |
| `pm.search_work_items` | `(workspace_slug, query, per_page?)` | `GET /api/v1/workspaces/{ws}/search/?query=...` | Fallback to client-side filter over `list_work_items` if upstream search is narrow. |

### Write tools (all `requiresWrite=true`, `requiresConfirmation=true`)

| Tool | Args | Plane endpoint | Notes |
|---|---|---|---|
| `pm.create_work_item` | `(workspace_slug, project_id, name, description_html?, assignees?, labels?)` | `POST /api/v1/workspaces/{ws}/projects/{p}/work-items/` | Confirmation prompt before execute. |
| `pm.update_work_item` | `(workspace_slug, project_id, work_item_id, fields)` | `PATCH /api/v1/workspaces/{ws}/projects/{p}/work-items/{id}/` | |
| `pm.add_work_item_comment` | `(workspace_slug, project_id, work_item_id, comment_html)` | `POST /api/v1/workspaces/{ws}/projects/{p}/work-items/{id}/comments/` | |
| `pm.transition_work_item` | `(workspace_slug, project_id, work_item_id, state_id)` | `PATCH /api/v1/workspaces/{ws}/projects/{p}/work-items/{id}/` (state field) | Confirmation includes from→to state. |

**Auth (verified 2026-05-28):** All Plane HTTP calls send `X-API-Key: <token>` — **NOT** `Authorization: Bearer`. The orchestrator-side `DROPLET_PM_ADMIN_TOKEN` is used for tools-core write actions (server-side LLM operation). Per-user API keys (issued via Plane's user-settings page or via OIDC-linked service tokens, depending on Plane's per-tenant config) attribute write-tool calls to the requesting user in Plane's audit log; spec leaves the per-user-token flow open until WARP-509 implementation surfaces the concrete path.

All HTTP calls go through `packages/tools-core/src/handlers/pm/pm-client.ts` — single auth + retry + error-mapping point.

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
| `GET` | `/api/mobile/pm/workspaces` | List of user's Plane workspaces (for slug discovery). |
| `GET` | `/api/mobile/pm/projects?workspace=<slug>` | Paginated list of projects (limit 50, max 100). |
| `GET` | `/api/mobile/pm/work-items?workspace=<slug>&project_id=&status=&assignee=` | Paginated work items. |
| `GET` | `/api/mobile/pm/work-items/{id}?workspace=<slug>&project_id=<id>` | Single work item with comments. |

Wraps Plane's upstream API with `X-API-Key` auth (verified 2026-05-28). Orchestrator transforms Plane's response shape into the existing mobile envelope per OQ4 resolution — no new envelope variant. JWT middleware from existing mobile-API stack.

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

**Decision (2026-05-27):** **A — iframe.** UX continuity matters more than CSP simplicity for the regulated-SMB persona (ADR-002 home-user supervision). Any required CSP patch is recorded in `services/pm/PATCHES.md` per ADR-010 AGPL posture. Cascade unblocked: WARP-512 (dashboard route).

### OQ3 — Plane upstream pin strategy — **RESOLVED**

**Question:** Pin Plane to a release tag (e.g. `v0.18.0`) or a commit SHA?

**Options:**
- **A (chosen):** Commit SHA. Reproducible across rebuilds. Updated explicitly per Droplet release.
- B: Release tag. Simpler. Plane could move the tag (unlikely but possible).

**Decision (2026-05-27):** **A — commit SHA.** Pinning to a SHA matches code-quality rule 1 (shipping-product mindset — no implicit drift between Droplet releases). The SHA refresh is a deliberate per-release decision, not an upstream-induced surprise. Cascade unblocked: WARP-500 (Dockerfile FROM line).

### OQ4 — Mobile API envelope mapping — **RESOLVED**

**Question:** Does Plane's data shape fit the existing mobile-API response envelope cleanly, or does the envelope need to flex?

**Options:**
- **A (chosen):** Plane data fits the existing envelope as-is. Map at the orchestrator wrapper.
- B: Envelope needs a new variant — coordinate with iOS/Android leads, possibly extend ADR-004.

**Decision (2026-05-28):** **A — transform at the orchestrator.** The orchestrator already wraps Plane's `X-API-Key` calls; folding Plane's `work-item` shape into the existing mobile envelope is one mapper layer in `apps/orchestrator/src/routes/mobile/pm.ts` and avoids a contract expansion that would ripple through iOS/Android/Windows. If a future endpoint surfaces a Plane shape that doesn't fit (e.g. nested comments with attachment arrays), AC-drift rule (`07-jira-workflow/lifecycle.md`) kicks in and we file a follow-up to extend ADR-004 in a scoped PR. **WARP-513 unblocked.**

### OQ6 — Plane SSO architecture — **RESOLVED (added 2026-05-28)**

**Background:** During WARP-505 PR #307 implementation we hit the Plane upstream API and discovered (per https://developers.plane.so/api-reference + https://developers.plane.so/self-hosting/govern/oidc-sso) that:

1. Plane has **no documented admin-mints-per-user-session-token endpoint**. The original SSO bridge plan (cache an admin-issued session token in Redis) is architecturally invalid against the real API.
2. Plane's only documented self-hosted SSO path is **OIDC** — Plane is the relying party; an external IdP authenticates the user.
3. Plane self-hosted exposes its own OIDC callback URLs: `https://<plane>/auth/oidc/`, `/auth/oidc/callback/`, `/auth/oidc/logout/`.

**Question:** What SSO architecture does Droplet use for Plane?

**Options:**
- **A (chosen):** Orchestrator runs a minimal OIDC IdP. Plane is configured to point at it. The dashboard JWT becomes the "primary" auth; OIDC discovery/userinfo/token endpoints on the orchestrator project the JWT identity to Plane.
- B: Operator stands up a separate OIDC provider (Keycloak, Authelia) alongside Plane. Both dashboard + Plane auth against it.
- C: Disable Plane auth entirely; rely on Nginx-level auth_request module + a header (`X-Auth-User`) trusted by Plane (would require a Plane upstream patch — AGPL obligation triggers per ADR-010 PATCHES.md).

**Decision (2026-05-28):** **A — orchestrator as mini-OIDC IdP.** Keeps the appliance self-contained (B violates on-prem self-hosted posture; C requires an AGPL patch we'd have to maintain). Implementation: 5 new orchestrator endpoints under `/api/pm/oidc/*` — `.well-known/openid-configuration`, `.well-known/jwks.json`, `authorize`, `token`, `userinfo`. ID-token signing uses a new dedicated RS256 keypair generated by `setup.sh` (HMAC won't work — Plane needs to verify via JWKS).

**Phase impact:** WARP-505 PR #307 needs a redesign per OQ6 — current code (admin-token-mints-session-token) is invalid. The file structure (pm.client.ts, pm-session.service.ts, routes/pm.ts) is reusable scaffolding; the inner logic is replaced with the OIDC IdP endpoints. New env vars: `DROPLET_PM_OIDC_PRIVATE_KEY_PEM`, `DROPLET_PM_OIDC_KID`. New compose-time prep: an `setup.sh` keypair generator. **WARP-505 needs a follow-up commit before merge.**

### OQ5 — Workspace-owner downgrade behavior — **RESOLVED**

**Question:** Plane's workspace-role API may not allow programmatic downgrade of the workspace owner. What's the fallback?

**Options:**
- **A (chosen):** Document that the workspace owner cannot be downgraded automatically; surface as a manual reconciliation alert.
- B: Re-create the workspace under a different owner whenever a Droplet admin downgrades the original.

**Decision (2026-05-27):** **A — manual reconciliation alert.** B is heavyweight and destructive (re-creating a workspace loses local history, breaks integrations). The reconciliation alert routes through the existing alert channel (per security-rules.md fail-CLOSED posture — user is denied PM access until reconciled). Cascade unblocked: WARP-506 (RBAC mapping).

---

## References

- ADR: [ADR-010 — Plane self-hosted PM stack adoption](../../ADR-010-pm-stack-selection.md)
- Epic: WARP-496
- Tickets: WARP-497 (ADR), WARP-498 (this spec), WARP-499 (legal), WARP-500..517 (implementation)
- Plane upstream: [makeplane/plane](https://github.com/makeplane/plane)
- Engineering handbook: `08-templates/new-service-checklist.md`, `04-coding-standards/code-quality-rules.md`, `03-claude-harness/skills/droplet-architecture-guard/SKILL.md`
- Closest service precedent: Nextcloud (in `docker/docker-compose.yml`) — third-party customer-facing compose service with auth handoff and backup integration.
- Closest tool-domain precedent: `packages/tools-core/src/handlers/rag/` — new-domain folder structure to mirror.
