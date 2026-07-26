# Launch-readiness audit — droplet-onboard-services

**Date:** 2026-05-30
**Scope:** Full-repo audit against the bar of *"a clean, trustworthy commercial business application."*
**Method:** Six parallel specialist passes (security, architecture, data/persistence, code quality, ops/reliability, frontend) reading the actual code on `main` — **not** `docs/STATUS.md`, which is stale (see below) — followed by a 20-agent `/architecture` pass producing an ADR-style fix plan per launch blocker.
**Companion:** [`LAUNCH_READINESS_FIX_PLANS.md`](LAUNCH_READINESS_FIX_PLANS.md) — the full ADR-style fix plan (root cause → options → chosen fix → steps → acceptance → tests → risks) for every launch blocker, keyed by WARP ticket.

> **Bottom line.** The core architecture is genuinely sound — single canonical tool registry, clean ai-gateway/orchestrator boundary, disciplined agent loop, JWT auth with timing-safe comparisons, thoughtful health/degradation modelling, ~1,300 tests. The gap to "clean business application" is **not craftsmanship** — it is **release discipline and operational maturity**: CI is switched off (so a red test suite and a coding-standard violation reached `main`), there are no container resource limits or customer-data backups, and a handful of auth surfaces and concurrency paths need hardening. Everything below is ticketed.

---

## How this maps to Jira

All findings are tracked under existing topical epics (no new epics were created). Urgent = `Bug`, High/Highest. Nice-to-have = `Task`, Medium/Low. Labels: `audit`, `launch-readiness`, plus an area label.

| Epic | Area |
|---|---|
| [WARP-327](https://warp-lab.atlassian.net/browse/WARP-327) | Auth, RBAC & Identity |
| [WARP-328](https://warp-lab.atlassian.net/browse/WARP-328) | Trust, Compliance & Security |
| [WARP-326](https://warp-lab.atlassian.net/browse/WARP-326) | Infra, CI & Deployment |
| [WARP-325](https://warp-lab.atlassian.net/browse/WARP-325) | Dashboard, Design System & A11y |
| [WARP-321](https://warp-lab.atlassian.net/browse/WARP-321) | Networking, Router & Switch |
| [WARP-320](https://warp-lab.atlassian.net/browse/WARP-320) | LLM Agent, MCP & Chat |
| [WARP-319](https://warp-lab.atlassian.net/browse/WARP-319) | RAG & Knowledge |
| [WARP-496](https://warp-lab.atlassian.net/browse/WARP-496) | Embedded PM (Plane) — superseded by native PM (ADR-026); Plane removed |
| [WARP-534](https://warp-lab.atlassian.net/browse/WARP-534) | OTA update system |

---

## 🔴 URGENT — must fix before launch

Ordered roughly by severity. Each carries a full fix plan in [`LAUNCH_READINESS_FIX_PLANS.md`](LAUNCH_READINESS_FIX_PLANS.md).

| Ticket | Pri | Finding | Key evidence |
|---|---|---|---|
| [WARP-559](https://warp-lab.atlassian.net/browse/WARP-559) | Highest | Managed-switch control API has **no role/scope guard** — the mount sits behind `authMiddleware` but applies no per-role gate, so any authenticated session (incl. `guest`) can disable ports/PoE/VLANs | `switch.ts` 0× `requireScope`/`requireRole` across 10 mutating routes (mounted at `app.ts:165`, after `authMiddleware` at `app.ts:128`, but without a scope guard) |
| [WARP-560](https://warp-lab.atlassian.net/browse/WARP-560) | Highest | AI Gateway has **no inbound authentication** — any LAN client can run inference, read any session, write BYOK keys | `ai-gateway/main.py:193`; `nginx.conf:84` no `auth_request` |
| [WARP-561](https://warp-lab.atlassian.net/browse/WARP-561) | High | BYOK provider keys are **device-global**, not per-user → cross-user read/overwrite | `auth/byok.py:36`, `keystore.py:71` |
| [WARP-562](https://warp-lab.atlassian.net/browse/WARP-562) | High | Orchestrator **CORS reflects any origin** with credentials | `app.ts:75` `cors({credentials:true, origin:true})` |
| [WARP-563](https://warp-lab.atlassian.net/browse/WARP-563) | High | MCP server grants **full tool trust from absent claims** with **no type-level enforcement of the stdio/HTTP split** — the HTTP transport always synthesizes verified `Claims`, so the invariant holds today, but it lives in a comment + the dev's head, not the type system; one new transport/refactor away from a silent full-privilege grant | `mcp-server/src/server.ts:30` (`claims === undefined ⇒ trusted`) |
| [WARP-564](https://warp-lab.atlassian.net/browse/WARP-564) | High | Pairing-code claim is a **non-atomic check-then-act** → double redemption | `device-clients.ts:220-289` (false "single tx" comment) |
| [WARP-565](https://warp-lab.atlassian.net/browse/WARP-565) | High | `VpnPeer.assignedIp` has **no unique constraint**; allocator race → duplicate tunnel IPs | `schema.prisma:808`; `vpn.ts:248` (no tx/retry the service comment assumes) |
| [WARP-566](https://warp-lab.atlassian.net/browse/WARP-566) | High | ~~Plane webhook **HMAC over re-serialized JSON**, not raw bytes (bug against WARP-511)~~ — **moot:** the Plane webhook receiver was removed with the embedded stack (native PM has no webhook; ADR-026) | ~~`pm-webhook.ts:96`~~ |
| [WARP-567](https://warp-lab.atlassian.net/browse/WARP-567) | High | Global error handler returns **HTTP 500 for every error** incl. client errors | `middleware/error-handler.ts:13` |
| [WARP-568](https://warp-lab.atlassian.net/browse/WARP-568) | High | **18 orchestrator tests fail** on a correctly-bootstrapped `main` (email/scenes/home/tools) | `__tests__/{email,scenes,home,tools}.routes.test.ts` |
| [WARP-569](https://warp-lab.atlassian.net/browse/WARP-569) | High | **No resource limits** on any container → one runaway OOM-kills the appliance | `docker-compose.yml` (no `mem_limit`/`cpus` anywhere) |
| [WARP-570](https://warp-lab.atlassian.net/browse/WARP-570) | High | **No backup / DR** for core customer data | `factory-reset.sh:162-182` (the dedicated Plane `pm-backup.sh` was removed with the embedded stack — native PM data now lives in the orchestrator's own Postgres and rides its backup path; ADR-026) |
| [WARP-571](https://warp-lab.atlassian.net/browse/WARP-571) | High | systemd boot unit omits `--env-file`/`--profile`; `ExecReload` uses `restart` → power-cycled box comes up wrong | `scripts/lib/systemd.sh:30-33` |
| [WARP-572](https://warp-lab.atlassian.net/browse/WARP-572) | High | **No `unhandledRejection`/`uncaughtException` handler** — a background throw can kill the control plane | `index.ts` (none); `cron-runtime.service.ts:205`, `reminders-poller.ts:94` |
| [WARP-573](https://warp-lab.atlassian.net/browse/WARP-573) | High | **Migration-on-boot is unguarded** (no advisory lock, no snapshot) → a power-cut mid-migrate bricks the orchestrator | `apps/orchestrator/Dockerfile:153` |
| [WARP-574](https://warp-lab.atlassian.net/browse/WARP-574) | High | **CI is effectively disabled** — 16/20 workflows are `workflow_dispatch`-only; nothing gates `main` | `.github/workflows/*.yml` |
| [WARP-575](https://warp-lab.atlassian.net/browse/WARP-575) | High | ~~PM worker image `makeplane/plane-worker:v0.24.1` **404s** → enabling the `pm` profile aborts the stack~~ — **moot:** the `pm` profile and all Plane images were removed (native PM; ADR-026) | ~~`docker-compose.yml:1071`~~ |
| [WARP-576](https://warp-lab.atlassian.net/browse/WARP-576) | High | Dashboard has **no error boundary / not-found page** → any render throw white-screens the app | `apps/web-dashboard/src/app/` (missing `error.tsx` etc.); `page.tsx:431` |
| [WARP-577](https://warp-lab.atlassian.net/browse/WARP-577) | High | Setup-detection **fails open into the wizard** → provisioned box stranded on `/setup` after a transient error | `lib/api.ts:65-70`, `AuthGate.tsx:22-25` |
| [WARP-221](https://warp-lab.atlassian.net/browse/WARP-221) | — | **Enriched** (not new): camera-discovery top-level `discovery_loop` is a banned `while True` scheduler not previously in scope | `camera-discovery/main.py:570`; no `apscheduler` in requirements |

---

## 🟡 NICE-TO-HAVE (Medium / Low)

Should-fix items that move the product toward "clean business application" quality but are not strict launch blockers. Tracked as **WARP-579 → WARP-602** (24 tickets), Jira label `launch-readiness` priority Medium/Low. (WARP-578 is a separate, pre-existing OpenWrt-provisioning bug — unrelated to this audit.)

- **security** — Rate-limit auth endpoints (login brute-force); reconsider fail-open limiter
- **security** — Default `AUTH_ENABLED=true`; enforce JWT/secret strength in production
- **security** — BYOK keystore: fail-closed on missing `DEVICE_SECRET`
- **security** — Gate `/auth/login?return=body` to native clients; `files.ts` stop defaulting to `admin`
- **security** — Cert-pinned TLS for switch + camera-init (remove `verify=False`)
- **ops** — Self-signed cert: document trust-flow UX + rotation story
- **ops/sec** — Threat-model + harden the privileged single-box OpenWrt container (WARP-585) — boundary documented + scoped cap set staged: [`security/openwrt-container-threat-model.md`](security/openwrt-container-threat-model.md)
- **data** — Retention/seal-and-truncate for `ActivityRow`/`CommandAuditLog`/`NotificationLog`
- **data** — Verify `FileContentChunk` vector index recreated after DROP; consider HNSW
- **data** — Make ai-gateway in-memory session fallback fail loud in production
- **data/ci** — Enforce unique Prisma migration timestamps in CI
- **ops** — Pin mutable image tags (frigate/whisper/piper/ollama)
- **ops** — Configure Docker log rotation (bound json-file logs)
- **ops** — Env-reload tooling: `up -d --force-recreate`, not `restart`
- **ops** — Fix `compose.sh` pre-pull image mismatch (postgres vs pgvector)
- **ops** — Phone-home heartbeat + push alerting so a dead appliance is detected
- **ops** — Make `setup.sh` re-run safe against half-applied state (OTA groundwork)
- **tech-debt** — Python lint/format/type-check config (ruff + mypy) across all services
- **tech-debt** — Pin Python deps (`==`) + per-service lockfiles
- **ops** — Add `/health` to file-indexer + wire into health-monitor; consider `/metrics`
- **tech-debt** — oled-display swallowed exceptions → log; route `console.*` through pino
- **frontend** — Dashboard polish: ESLint config, manifest theme color, `translateError`, SW kill-switch, remove phase placeholder copy
- **docs** — Reconcile canonical docs with reality (inference path, ADR-011, undocumented services/env, regenerate STATUS.md)
- **tech-debt** — Burn down orchestrator `any`/non-null-assertion density; reconsider Redis as hard dependency

---

## What's genuinely good (don't regress)

Single canonical tool registry (`packages/tools-core/src/registry.ts`) consumed by both the agent loop and the MCP server with no duplication; clean ai-gateway/orchestrator boundary (gateway is a pure provider router, doesn't dispatch tools); disciplined agent loop with bounded iterations + defense-in-depth `tool_choice="none"`; JWT service with typed access/refresh separation + full-SHA-256 denylist + timing-safe service-token compare; thoughtful `health-monitor.service.ts` hard/soft dependency classification; `db` healthcheck using a real `SELECT 1` (fixed a documented cold-boot race); nginx per-request DNS resolution; device-unique `openssl rand` secrets with `chmod 600`; `depends_on: service_healthy` for Postgres; cookie-based dashboard auth (no localStorage tokens — STATUS.md was wrong); `react-markdown` without `rehype-raw` (no HTML injection); destructive actions behind `ConfirmDialog`; excellent TODO/FIXME hygiene; `ROUTING_MODE` real/mock/disabled resilience pattern mirrored across services; `test-security.sh` as a real static guard.

---

## Note on `docs/STATUS.md`

`docs/STATUS.md` is dated **2026-04-15** and is materially stale — it predates the JWT/RBAC work, the embedded PM stack, the dashboard rebrand, and the CI build-out. During this audit it was contradicted by the actual code on several load-bearing points (it claims dashboard tokens live in `localStorage` — they're in HTTP-only cookies; that the setup wizard is "stubbed" — it's a complete 9-step flow; that `.github/` is "logo assets only, no workflows" — there are 20 workflows, just disabled). **Do not use STATUS.md for decisions until it is regenerated** (tracked under the docs-reconciliation nice-to-have ticket).
