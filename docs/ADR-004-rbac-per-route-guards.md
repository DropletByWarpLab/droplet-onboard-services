# ADR-004: RBAC — per-route role guards + Prisma `Role` enum

**Status:** Proposed
**Date:** 2026-05-25
**Deciders:** Stefan Cruceru
**Source:** [WARP-171](https://warp-lab.atlassian.net/browse/WARP-171), `docs/ROADMAP.md` §M2.2, GTM strategy doc (April 2026) §4.2

> **Numbering note:** Originally drafted as ADR-003 but renamed to ADR-004 because `docs/ADR-003-rag-techniques-adoption.md` (RAG techniques) landed on `main` first.

> **Schema-drift correction on first contact with code:** the ADR draft talked about `User.role`, but `apps/orchestrator/prisma/schema.prisma` has **no `model User`** — users live in Nextcloud and are surfaced via OCS. The only persistent role column in the schema is `UserInvite.role` (line 156), which the AC text actually cites by file/line. The implementation migrates `UserInvite.role` to the new `Role` enum; existing invite-accept semantics ("admin invite role" → "owner session role") are preserved by the route's existing transformation rule (`auth.ts:595`).

## Context

M1.3 (JWT auth) shipped a five-value role union in the access token claim:

```ts
// apps/orchestrator/src/services/jwt.service.ts:6
export type Role = "owner" | "admin" | "family" | "guest" | "service";
```

The middleware reads `req.user.role` correctly and the JWT signs it. But two gaps remain:

1. **The Prisma role column drifts from the TS type.** At `apps/orchestrator/prisma/schema.prisma:156` the column is `role String @default("user") // "admin" | "user"` — a free-form `String` with a stale two-value comment. (This column lives on `UserInvite`, not on a hypothetical `User` model — see drift note above.) Per project CLAUDE.md ("No guessing, ever — persistent state lives in explicit columns, not in the absence of other columns"), this needs to be an explicit enum.
2. **No route enforces the claim.** No `requireRole()` helper exists (`grep -r requireRole apps/orchestrator/src` returns zero). The four-role authorization in GTM M2.2 is unenforced; any authenticated user can hit any write endpoint.

Additionally, `roleFromGroups()` at `jwt.service.ts:33` is a stub — the existing `// TODO(Phase 3 / M2.2)` comment names the gap:

> "Today only `admin` group → `owner` and everything else → `family` is wired; `admin` and `guest` roles exist in the type but have no group mapping yet."

Service principals (`SERVICE_TOKEN_VOICE`, `SERVICE_TOKEN_MCP`) work today and assign the `service` role — that path must not regress.

## Decision

### 1. Prisma `Role` enum

Replace the `String @default("user")` column on `User` with a proper enum that mirrors the TS union one-to-one:

```prisma
enum Role {
  owner
  admin
  family
  guest
  service
}

model User {
  // ...
  role Role @default(guest)
}
```

`guest` is the least-privileged default. The TS `service` value is included in the enum so the table can represent a service principal if one is ever persisted; the in-memory service-principal path (constructed from `SERVICE_TOKEN_*` env vars in `auth.ts`) is unaffected.

Migration `prisma/migrations/<ts>_add_role_enum/migration.sql`:
- Creates the `Role` enum.
- `ALTER TABLE "User" ADD COLUMN "role_new" "Role" NOT NULL DEFAULT 'guest';`
- Backfill: existing `"admin"` strings → `'owner'`, existing `"user"` strings → `'family'` (matches the current `roleFromGroups` mapping), unknown values → `'guest'`.
- Drop the old `role` column; rename `role_new` → `role`.

### 2. `requireRole()` middleware

New export in `apps/orchestrator/src/middleware/auth.ts`:

```ts
import type { Role } from "../services/jwt.service.js";

export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role) {
      res.status(403).json({ error: "Forbidden: no role on session" });
      return;
    }
    if (!allowed.includes(role)) {
      res.status(403).json({ error: "Forbidden: role not permitted" });
      return;
    }
    next();
  };
}
```

**Fail-closed semantics:** absence of `req.user.role` returns 403, not 401. The auth middleware already returned 401 if no valid token was present; reaching `requireRole` means authenticated-but-unauthorized.

### 3. Per-route guard policy

Apply guards at route registration, not inside the handler. Mirror the existing `WRITE_TOOLS` allowlist pattern from `src/routes/llm.ts`. The matrix:

| Endpoint family | Allowed roles |
|---|---|
| `POST/PUT/DELETE /api/auth/users` (admin) | `owner`, `admin` |
| `POST /api/auth/invites*` | `owner`, `admin` |
| `POST/PUT/DELETE /api/network/*`, `/api/firewall/*`, `/api/vpn/*`, `/api/ddns/*` | `owner`, `admin` |
| `POST /api/services/*/restart` | `owner` |
| `POST/PUT/DELETE /api/cameras/*`, `/api/matter/*`, `/api/smart-home/*` | `owner`, `admin`, `family` |
| `POST/PUT/DELETE /api/files/*` (write) | `owner`, `admin`, `family` |
| `POST/PUT/DELETE /api/llm/sessions/*` (own session) | `owner`, `admin`, `family`, `guest` |
| All `GET` endpoints | unchanged (auth middleware still applies; no role gate) |

Service principals (`service` role) are read-only by design — they hit `GET` endpoints and the MCP tool surface only. The matrix above does NOT include `service` on any write row.

### 4. Expand `roleFromGroups()`

Update `apps/orchestrator/src/services/jwt.service.ts:33`:

```ts
export function roleFromGroups(groups: string[]): Role {
  if (groups.includes("admin")) return "owner";          // already wired
  if (groups.includes("staff")) return "admin";          // new: Nextcloud "staff" → admin
  if (groups.includes("guest")) return "guest";          // new: Nextcloud "guest" → guest
  return "family";                                       // unchanged default
}
```

Group-name choices match what Nextcloud already provisions out of the box. Documented in the new `docs/RBAC.md` (created in Phase 8 brain-sync, not this ADR).

### 5. Tests

`apps/orchestrator/src/__tests__/rbac.test.ts` — a single file driving the full role × route matrix:

- For each role in `Role`, for each guarded route, assert `200` (allowed) or `403` (denied) per the matrix above.
- Negative tests: `req.user.role` missing → 403; unknown role string → 403 (defense in depth — the enum should make this unreachable, but the middleware fails closed anyway).
- Service-principal regression test: a request with `Authorization: Bearer <SERVICE_TOKEN_VOICE>` is rejected on every guarded write route, accepted on `GET`s.

### 6. `req.user.id` shape contract (WARP-485 amendment)

After WARP-485, `req.user.id` is **always** the local `User.id` UUID, regardless of which auth path populated the session. Previously the OCS fallback in `auth.ts` set `req.user.id = ocs.data.id` (the Nextcloud username string), which silently broke any consumer that compared it against a UUID-shaped value — most visibly the WARP-480 self-action guard on `/api/people/:id` mutations (`req.params.id === req.user?.id`), which always returned false-negative under OCS auth and let an owner authenticated via the OCS fallback DELETE themselves.

Post-fix behavior:

- **JWT path:** `req.user.id = jwtPayload.sub` (unchanged — already a local UUID).
- **OCS path:** the middleware looks up `User` by `nextcloudUsername` (new column added by WARP-485 — see `prisma/migrations/20260526150000_warp_485_user_nextcloud_username/migration.sql`) and sets `req.user.id = localUser.id`. Fail-closed with **401 `USER_NOT_PROVISIONED`** when no matching row exists — silent auto-provision would be a privilege-escalation vector (an attacker holding a valid OCS token for an unrelated NC user could otherwise mint a local row with the default `family` role). Operators add new users via `/api/people` before they can authenticate.
- **`req.user.username`** keeps the Nextcloud username on the OCS path for display continuity. Consumers that need the human-readable handle (e.g. brain-memory route filters) keep using `username`; consumers that need a stable per-user key (e.g. `ScopeBinding.userId` FK lookups, self-action comparisons) use `id`.
- **Service principals** (`_service:voice`, `_service:mcp`) are unaffected — they have synthetic ids that never collide with user UUIDs.

The contract is pinned in `apps/orchestrator/src/__tests__/auth.req-user-id.test.ts`, which covers JWT, OCS-with-matching-User, OCS-without-User, prisma-not-initialised (defense-in-depth fail-closed), and the end-to-end WARP-480 self-guard regression under OCS auth.

## Consequences

**Positive:**
- Removes the `User.role` schema drift the project CLAUDE.md no-guessing rule already forbids.
- Closes the M2.2 GTM gap — four-role enforcement is concrete and testable.
- Service-principal read-only contract becomes explicit and enforced, not implicit.
- Future ABAC work ([WARP-248](https://warp-lab.atlassian.net/browse/WARP-248)) builds on a real role surface, not a tagged-string sidecar.

**Negative:**
- Existing user rows need a backfill; data is small (single-box deployments today) but the migration must be careful.
- One-time risk that a route already in production was unguarded and now returns 403 to legitimate guest users. Mitigated by: (a) the matrix above is conservative (writes only); (b) test matrix exercises every role × route pair before merge.
- Nextcloud `staff` and `guest` group conventions may not match every install. Surface in `docs/RBAC.md` and provide an env-override (`ROLE_GROUP_MAPPING_JSON`) as a follow-up if deployments need it. Not in this ticket.

**Follow-ups (NOT this ticket):**
- `docs/RBAC.md` operator-facing guide — Phase 8.
- Dashboard role-aware navigation rendering (hide admin links from `family` / `guest`) — separate ticket, would re-enter `droplet-gtm-execute` with UX phase active.
- ABAC for connector-source ACLs — [WARP-248](https://warp-lab.atlassian.net/browse/WARP-248).
- MFA gate (`require-recent-mfa`) on `owner`-only routes — WARP-230/238, in flight.

## Scope axis (WARP-455 extension)

> **Status of this section:** added 2026-05-25 by WARP-455. The Role
> axis below remains the canonical capability gate; this section
> documents the orthogonal **Scope** axis layered on top.

WARP-171 (this ADR's original scope) covered the capability axis —
"can this role hit this *kind* of route" (admin actions, household
reads, service-principal read-only). WARP-455 adds the second axis —
"can this user see this *information bucket*". A resource at scope
`exec_only` is invisible to a `family`-role user even if their role
would otherwise permit the operation.

### Decision

Add a Prisma `Scope` pgEnum mirroring a TS literal in
`src/middleware/scope.ts`:

```prisma
enum Scope {
  team           // household-wide default (most resources)
  exec_only      // founders + COO peers
  finance        // bookkeeping, invoices, payroll
  engineering    // code + technical-ops docs
  ops            // runbooks, vendor records
  private        // user-owned, never shared
}
```

Add a `ScopeBinding` (User ↔ Scope) join table so users hold an
explicit subset of scopes. `@@unique([userId, scope])` so the same
scope can't be granted twice. `grantedBy` + `grantedAt` audit columns
on the row let the dashboard render "granted by Alice 3 days ago"
without joining ActivityRow.

Add `requireScope(resource, loadUserScopes)` middleware in
`src/middleware/scope.ts`. The truth table:

| role | binding for `resource`? | result |
|---|---|---|
| `owner` | any | pass (no DB call) |
| `admin` | any | pass (no DB call) |
| `family` | yes | pass |
| `family` | no | 403 |
| `guest` | yes | pass |
| `guest` | no | 403 |
| `service` | any | 403 (read-only, scope axis is human-only) |
| missing | — | 403 |
| unknown | — | 403 |

Owners + admins short-circuit before the loader runs — keeps the hot
path off Postgres for the most common request profile. Service
principals never pass scope-guarded routes by design.

### File-scope registry

WARP-455 also adds a `File` model (keyed by Nextcloud's stable
`ncFileId`) carrying `scope: Scope @default(team)`. The migration
backfills one row per distinct ncFileId already in `FileContentChunk`
with scope `team`, idempotent via `ON CONFLICT (ncFileId) DO NOTHING`.
Scope-filtered file surfaces JOIN against this registry instead of
scanning per-chunk rows.

### Guest time-box

`GuestExpiry` carries an explicit `GuestExpiryStatus` enum (ACTIVE |
EXPIRED) — no IS-NULL guessing per the CLAUDE.md no-guessing rule.
Status follows the WARP-218 `BrainMemoryItemStatus` precedent: deriving
"is this guest expired" from `expiresAt < now()` at read time would
leak the cron tick cadence into UX (a guest is only "expired" once the
cron has actually denylisted their session).

A nightly cron at 03:15 (`guest-expiry-sweep` in
`services/guest-expiry-sweep.service.ts`, wired through
`cron-runtime.service`'s `scheduleCron`) flips ACTIVE rows past
`expiresAt` to EXPIRED and emits one `auth`-kind ActivityRow per flip.

The full live-revoke surface is intentionally scoped out of WARP-455 —
the 15-min access-token TTL is the hard cap, and a follow-up ticket
adds a refresh-handler short-circuit when User.role=guest AND
GuestExpiry.status=EXPIRED. The 15-min ceiling is acceptable for a
household-tier guest.

### Per-route guard policy (additions on top of §3)

| Endpoint family | Allowed roles |
|---|---|
| `GET /api/people` | `owner`, `admin` |
| `PATCH /api/people/:id/role` | `owner`, `admin` |
| `PATCH /api/people/:id/scope` | `owner`, `admin` |
| `DELETE /api/people/:id` | `owner`, `admin` |
| `GET /api/people/permissions` | every authenticated role (UX helper) |

These rows are mirrored in `__tests__/rbac.test.ts`'s MATRIX so a
guard regression on any of them trips a localized test failure.

## Alternatives considered

### A. Decorator-style guards on route handlers
Wrap each handler in a higher-order function (`withRoles(["owner", "admin"], handler)`). Rejected: Express middleware is already the team's idiom for cross-cutting concerns (auth, request-logger, error-handler). A decorator pattern would be a one-off and harder to introspect than `router.post(path, requireRole(...), handler)`.

### B. App-wide role policy table
A JSON file mapping path-regex → allowed-roles, evaluated by a single middleware at the top of the stack. Rejected: drifts from the route definitions and from grep-ability. Engineers adding new routes wouldn't see the gate.

### C. Keep `User.role` as `String`, just add the enum at the TS layer
Rejected: violates project CLAUDE.md's no-guessing rule (the canonical column type would still permit invalid values). Also re-introduces the WARP-218-class bug class — state derived from non-explicit columns.

### D. Defer to a third-party RBAC library (CASL, AccessControl)
Rejected for v1: introduces a dependency the team would need to audit, and the actual policy is small enough (one matrix table) that a 20-line helper carries it cleanly. Revisit if/when ABAC ([WARP-248](https://warp-lab.atlassian.net/browse/WARP-248)) requires conditional rules.

## Citations

- [`apps/orchestrator/src/services/jwt.service.ts`](../apps/orchestrator/src/services/jwt.service.ts) — `Role` type union (line 6), `roleFromGroups` TODO (line 30–36).
- [`apps/orchestrator/src/middleware/auth.ts`](../apps/orchestrator/src/middleware/auth.ts) — service-principal registry (lines 240–262); `requireRole` lands here.
- [`apps/orchestrator/prisma/schema.prisma`](../apps/orchestrator/prisma/schema.prisma) — `User.role String @default("user")` at line 156 (the drift).
- [`docs/ROADMAP.md`](ROADMAP.md) §M2.2 — GTM source of the four-role requirement.
- `shared_brain/projects/droplet-pi-platform/CLAUDE.md` — "No guessing, ever" rule (the explicit-column constraint).
- [WARP-171](https://warp-lab.atlassian.net/browse/WARP-171) — this ticket.
- [WARP-248](https://warp-lab.atlassian.net/browse/WARP-248) — ABAC follow-up, deferred.
- [WARP-327](https://warp-lab.atlassian.net/browse/WARP-327) — parent epic, Auth/RBAC/Identity.
- [WARP-480](https://warp-lab.atlassian.net/browse/WARP-480) — self-action + last-owner invariants on `/api/people` mutations (the consumer that surfaced the OCS-id-shape mismatch).
- [WARP-485](https://warp-lab.atlassian.net/browse/WARP-485) — `req.user.id` normalization across JWT + OCS auth paths (the §6 amendment above).
