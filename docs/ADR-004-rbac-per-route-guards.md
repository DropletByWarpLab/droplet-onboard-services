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
