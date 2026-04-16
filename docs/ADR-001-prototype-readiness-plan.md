# ADR-001: Prototype Readiness Plan

**Status:** Proposed
**Date:** 2026-04-15
**Deciders:** Engineering team
**Source:** GTM strategy doc (April 2026), `docs/ROADMAP.md`, codebase audit

## Context

The edge-platform needs to be ready for prototype testing. The GTM strategy defines milestones M1.1–M3.6 across three stages. A full codebase audit was performed on 2026-04-15 to identify every stub, missing implementation, and gap that blocks a successful prototype demo.

**Key finding: the codebase is in better shape than the GTM doc assumes.** All 11 orchestrator route files are real implementations (zero mock/stub routes). HTTPS with self-signed certs is fully working. Session persistence has dual-mode (in-memory + Redis). The safety framework on smart-home/matter/network routes is production-grade. Device pairing has rate limiting and crypto.

The actual gaps are narrower and more specific than the GTM phases suggest. This plan identifies them precisely and orders them for prototype testing.

## Current State Summary

| Area | Status | Detail |
|------|--------|--------|
| Orchestrator routes (11 files) | Real | All functional; no stubs or mock data |
| HTTPS / TLS | Done | Self-signed cert auto-gen in `setup.sh`, HSTS, TLS 1.2/1.3 in nginx |
| Session persistence | Done | Redis store (7-day TTL) + in-memory fallback; factory pattern |
| Streaming (SSE) | Partial | Plumbing exists end-to-end; blocked on `inference-engine` upstream |
| Auth | Partial | Nextcloud OCS validation + Redis cache; no JWT, no roles |
| AI gateway rate limiting | **Stub** | `middleware/rate_limit.py` is an empty file |
| AI gateway usage tracking | **Stub** | `middleware/usage_tracking.py` is an empty file |
| `scripts/build-image.sh` | **Stub** | Contains only a TODO comment |
| Audit logging | Partial | 4/11 routes log to `CommandAuditLog`; no Postgres audit table for auth/files |
| CI/CD | Not started | `.github/` has only logo SVGs; zero workflows |
| RBAC | Not started | No role model in Prisma, no `requireRole()` middleware |
| Setup wizard | Partial | Admin account creation only; no WiFi/NAS/camera steps |
| CORS (AI gateway) | Permissive | `allow_origins=["*"]` with credentials |
| Input validation | Partial | No `max_tokens` upper bound; no message-size limits |

## Decision

Implement the plan below in six phases, ordered by prototype-testing impact. Each phase is independently testable — you can validate it before moving to the next.

---

## Phase 1 — Remove stubs, close security gaps (GTM M2.7 partial)

> **Goal:** Eliminate empty stub files and fix the most obvious security holes so the prototype doesn't embarrass us.

### 1.1 Implement AI gateway rate limiting

**File:** `services/ai-gateway/middleware/rate_limit.py` (currently empty)

**What to build:**
- Redis-backed sliding-window rate limiter middleware for FastAPI
- Limits per IP (or per authenticated user if token present)
- Configurable via env vars: `RATE_LIMIT_RPM` (default 60), `RATE_LIMIT_BURST` (default 10)
- Return `429 Too Many Requests` with `Retry-After` header
- Wire into `main.py` as FastAPI middleware on `/ai/chat` and `/ai/sessions/*/chat`

**Test:**
```bash
# Hit the chat endpoint rapidly and verify 429 after burst
for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/ai/chat -X POST -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"hi"}]}'; done
```

### ~~1.2 Implement AI gateway usage tracking~~ — SKIPPED

Usage tracking was descoped: local model inference does not need token billing or usage metering. The `usage_tracking.py` stub is left as a placeholder for future observability if needed.

### 1.3 Add input validation upper bounds

**File:** `services/ai-gateway/schemas.py`

**What to change:**
- `max_tokens`: add `le=4096` (or model-specific caps)
- Add `max_items=50` on the `messages` list
- Add message content length validation (e.g., 32,000 chars per message)

**Test:**
```bash
# Send request with max_tokens=999999, expect 422
curl -X POST http://localhost:8000/ai/chat -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":999999}'
```

### 1.4 Restrict CORS in AI gateway

**File:** `services/ai-gateway/main.py`

**What to change:**
- Replace `allow_origins=["*"]` with configurable `CORS_ORIGINS` env var
- Default to `["http://localhost:3001", "https://localhost:3001"]` (web-dashboard)
- In Docker, set to the gateway's origin

**Test:** Verify cross-origin request from an unlisted origin is rejected.

---

## Phase 2 — JWT authentication (GTM M1.3)

> **Goal:** Self-contained auth that doesn't require Nextcloud to be running for every token validation.

### 2.1 Add JWT infrastructure

**Files:**
- `apps/orchestrator/package.json` — add `jsonwebtoken`, `@types/jsonwebtoken`
- `apps/orchestrator/src/services/jwt.service.ts` — new file

**What to build:**
- `signAccessToken(user, role)` → 15-minute JWT with claims `{sub, username, displayName, role}`
- `signRefreshToken(user)` → 7-day JWT stored in HTTP-only cookie
- `verifyToken(token)` → decoded payload or throw
- Secret from `JWT_SECRET` env var (generated by `setup.sh`)

### 2.2 Add login + refresh endpoints

**File:** `apps/orchestrator/src/routes/auth.ts`

**What to change:**
- `POST /api/auth/login`: after Nextcloud credential validation succeeds, issue JWT access + refresh tokens instead of passing through the Nextcloud token
- `POST /api/auth/refresh`: verify refresh token cookie, issue new access token
- `POST /api/auth/logout`: clear refresh cookie, add refresh token to Redis denylist (TTL = remaining expiry)

### 2.3 Update auth middleware to verify JWT

**File:** `apps/orchestrator/src/middleware/auth.ts`

**What to change:**
- Primary path: verify JWT from `Authorization: Bearer` header
- Fallback path: keep Nextcloud OCS validation for backward compat during migration
- Extract `role` from JWT claims into `req.user.role`
- Remove Redis cache for JWT path (JWT is self-verifying)

### 2.4 Generate JWT_SECRET in setup.sh

**File:** `scripts/setup.sh` (or `scripts/lib/secrets.sh`)

**What to add:**
- Generate `JWT_SECRET` (64-byte random hex) alongside other device secrets
- Add to `.env` template

**Test:**
```bash
# Login, get JWT, decode it, verify role claim exists
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"..."}' | jq -r '.token')
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | jq .
# Should show {sub, username, role, exp, iat}
```

---

## Phase 3 — RBAC + audit log (GTM M2.2, M1.2 partial)

> **Goal:** Four-role system with per-endpoint guards and a Postgres-backed audit trail.

### 3.1 Add Role enum and User model to Prisma

**File:** `apps/orchestrator/prisma/schema.prisma`

**What to add:**
```prisma
enum Role {
  OWNER
  ADMIN
  FAMILY
  GUEST
}

model User {
  id          String   @id @default(uuid())
  username    String   @unique
  role        Role     @default(FAMILY)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

### 3.2 Add `requireRole()` middleware

**File:** `apps/orchestrator/src/middleware/auth.ts` (or new `rbac.ts`)

**What to build:**
```typescript
function requireRole(...allowed: Role[]) {
  return (req, res, next) => {
    if (!allowed.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}
```

Apply to routes:
| Route pattern | Minimum role |
|---|---|
| `GET /api/*` (reads) | GUEST |
| `POST /api/llm/chat` | FAMILY |
| `POST /api/network/*` (writes) | ADMIN |
| `POST /api/auth/users` | OWNER |
| `DELETE /api/auth/users/*` | OWNER |

### 3.3 Add Postgres-backed AuditLog table

**File:** `apps/orchestrator/prisma/schema.prisma`

**What to add:**
```prisma
model AuditLog {
  id        String   @id @default(uuid())
  userId    String
  action    String   // e.g. "user.login", "network.reboot", "file.delete"
  target    String?  // resource identifier
  metadata  Json?
  createdAt DateTime @default(now())

  @@index([userId])
  @@index([createdAt])
  @@index([action])
}
```

### 3.4 Add audit logging service

**File:** `apps/orchestrator/src/services/audit.service.ts` (new)

**What to build:**
- `logAudit(userId, action, target?, metadata?)` — async insert, fire-and-forget (don't block the request)
- `GET /api/audit` endpoint (ADMIN+ only) with pagination, date range, and action filters

**Test:**
```bash
# Login as guest, try to create a user → 403
# Login as owner, create a user → 200
# Check audit log → should show the create event
curl http://localhost:3000/api/audit?action=user.create
```

---

## Phase 4 — CI/CD pipeline (GTM M1.8)

> **Goal:** Automated lint, test, and build on every push.

### 4.1 Add GitHub Actions CI workflow

**File:** `.github/workflows/ci.yml` (new)

**What to build:**
```yaml
name: CI
on: [push, pull_request]
jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx turbo lint
      - run: npm test
  
  ai-gateway-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: cd services/ai-gateway && pip install -r requirements.txt -r requirements-dev.txt
      - run: cd services/ai-gateway && pytest

  docker-build:
    runs-on: ubuntu-latest
    needs: [lint-and-test, ai-gateway-tests]
    steps:
      - uses: actions/checkout@v4
      - run: docker compose -f docker/docker-compose.yml build
```

### 4.2 Add image-publish workflow (main only)

**File:** `.github/workflows/publish.yml` (new)

**What to build:**
- Triggered on push to `main`
- Builds and pushes images to GHCR (`ghcr.io/nahast/edge-platform/*`)
- Tags with `latest` and git SHA

**Test:** Push a branch, verify CI runs. Merge to main, verify images appear in GHCR.

---

## Phase 5 — Setup wizard completion (GTM M2.5)

> **Goal:** First-run experience walks through WiFi, storage, and camera setup.

### 5.1 Extend setup wizard backend

**File:** `apps/orchestrator/src/routes/auth.ts` (or new `setup.ts`)

**What to add:**
- `GET /api/setup/status` — returns which steps are complete (account, wifi, storage, cameras)
- `POST /api/setup/wifi` — proxy to routing service for SSID/password config
- `POST /api/setup/storage` — configure Nextcloud/Samba share paths
- `POST /api/setup/cameras` — trigger ONVIF scan and accept discovered cameras

### 5.2 Extend setup wizard frontend

**File:** `apps/web-dashboard/src/app/setup/page.tsx`

**What to change:**
- Multi-step wizard: Account (existing) → WiFi → Storage → Cameras → Done
- Each step calls the corresponding `/api/setup/*` endpoint
- Progress indicator with step validation
- Skip option for optional steps (cameras)

**Test:** Factory reset, navigate to device — should see full wizard flow.

---

## Phase 6 — Prototype polish (GTM M1.2, M1.7)

> **Goal:** Close remaining gaps that affect prototype credibility.

### 6.1 Implement `scripts/build-image.sh`

**File:** `scripts/build-image.sh` (currently a TODO stub)

**What to build:**
- Build all Docker images with proper tags
- Optional `--push` flag to push to registry
- Version tagging from `package.json` or git tag
- Used by CI (Phase 4) and manual builds

### 6.2 Add Playwright E2E test scaffold

**Files:**
- `apps/web-dashboard/playwright.config.ts` (new)
- `apps/web-dashboard/e2e/setup.spec.ts` (new)
- `apps/web-dashboard/e2e/login.spec.ts` (new)

**What to build:**
- Smoke tests: setup wizard flow, login, dashboard loads, chat sends a message
- Run against `docker-compose.test.yml`
- Add to CI as a separate job (needs service containers)

### 6.3 Storage stats endpoint hardening

**File:** `apps/orchestrator/src/routes/storage.ts`

**What to change:**
- Add disk usage from host filesystem (`FILES_ROOT` path)
- Add per-user quota breakdown (from Nextcloud OCS)
- Add storage health indicators (disk space warnings at 80%/90%)

**Test:**
```bash
curl http://localhost:3000/api/storage
# Should return: used, total, available, percentage, disk_health, per_user breakdown
```

---

## Trade-off Analysis

| Approach | Pros | Cons |
|----------|------|------|
| **JWT + keep Nextcloud fallback** (chosen) | Non-breaking migration; Nextcloud remains the user store; JWT adds speed + offline validation | Two auth paths to maintain during transition |
| **JWT + drop Nextcloud auth** | Simpler single path | Breaking change; need to migrate user store to Prisma; loses Nextcloud SSO |
| **Keep Nextcloud-only auth** | Zero work | Every request hits Nextcloud OCS; no role claims; can't work if Nextcloud is down |

| Approach | Pros | Cons |
|----------|------|------|
| **Redis rate limiting** (chosen) | Shared state across workers; ai-gateway already has Redis | Redis dependency for rate limiting |
| **In-memory rate limiting** | No external dependency | Doesn't share state; resets on restart |

## Consequences

- **Easier:** Self-contained demo without Nextcloud dependency for auth; visible security posture; automated quality gates via CI
- **Harder:** Two auth paths during transition period; more Prisma models to maintain
- **Revisit:** Phase 2-3 transition plan (when to drop Nextcloud OCS fallback entirely); CORS origins list for production deployment

## Action Items

Phases are ordered by prototype impact. Each is independently shippable.

1. [x] **Phase 1** — Remove stubs + security gaps — DONE (rate limiting, input validation, CORS restriction; usage tracking descoped)
2. [x] **Phase 2** — JWT authentication — DONE (sign/verify/refresh, Nextcloud fallback, role claims, JWT_SECRET in setup.sh)
3. [ ] **Phase 3** — RBAC + audit log (est. scope: 3 files, ~200 lines + migration)
4. [ ] **Phase 4** — CI/CD pipeline (est. scope: 2 new workflow files)
5. [ ] **Phase 5** — Setup wizard (est. scope: 2 files backend + 1 file frontend)
6. [ ] **Phase 6** — Polish: build script, E2E tests, storage hardening

## Out of Scope (for prototype)

These are tracked in `docs/ROADMAP.md` but are **not needed for prototype testing:**

- M1.6 Response streaming — blocked on `inference-engine` upstream; existing SSE plumbing is sufficient for demo
- M2.3 Device pairing QR — already has a working pairing flow; QR is a UX enhancement
- M2.4 PWA / mobile-responsive — web dashboard works; mobile polish is beta scope
- M2.6 WireGuard — remote access is not a prototype requirement
- M2.8 SD card image — manual `setup.sh` is fine for prototype
- M3.x milestones — all product launch scope

## GTM Milestone Coverage

| Milestone | Phase | Notes |
|-----------|-------|-------|
| M1.2 Real Device Control API | 3, 6 | Audit log + storage hardening |
| M1.3 JWT authentication | 2 | Full implementation |
| M1.4 HTTPS | — | **Already done** (reclassify from `[~]` to `[x]`) |
| M1.5 Conversation persistence | — | **Already done** (Redis + in-memory, verified) |
| M1.7 Test suite foundation | 6 | Playwright E2E scaffold |
| M1.8 CI/CD pipeline | 4 | GitHub Actions |
| M2.2 Full RBAC | 3 | Four-role system |
| M2.5 Guided first-run | 5 | Multi-step wizard |
| M2.7 Prompt-injection hardening | 1 | Rate limiting + input validation |
