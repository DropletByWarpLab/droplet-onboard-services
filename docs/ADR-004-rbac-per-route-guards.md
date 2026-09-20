# ADR-004: RBAC — per-route role guards + Prisma `Role` enum

**Status:** Accepted — shipped (status corrected 2026-07-27; see Status audit below)
**Date:** 2026-05-25
**Deciders:** Stefan Cruceru
**Source:** [WARP-171](https://warp-lab.atlassian.net/browse/WARP-171), `docs/ROADMAP.md` §M2.2, GTM strategy doc (April 2026) §4.2

> **Amended by ADR-032 (RBAC v2, 2026-07):** custom access roles do not add
> `Role` enum values and do not move any floor in this document. A role is a
> row whose `startingPoint` **is** one of the tiers below, so every guard here
> keeps enforcing unchanged; the per-role grant rows only narrow *within* a
> floor via `requireFeatureAccess` (§3). Two catalog changes landed with it,
> both in §3: the first-ever **ERP connector rows**, and the note on how the
> layer-2 feature gate composes with these floors.

> **Numbering note:** Originally drafted as ADR-003 but renamed to ADR-004 because `docs/ADR-003-rag-techniques-adoption.md` (RAG techniques) landed on `main` first.

> **Schema-drift correction on first contact with code:** the ADR draft talked about `User.role`, but `apps/orchestrator/prisma/schema.prisma` has **no `model User`** — users live in Nextcloud and are surfaced via OCS. The only persistent role column in the schema is `UserInvite.role` (line 156), which the AC text actually cites by file/line. The implementation migrates `UserInvite.role` to the new `Role` enum; existing invite-accept semantics ("admin invite role" → "owner session role") are preserved by the route's existing transformation rule (`auth.ts:595`). [Update 2026-07-26: this "no `model User`" claim is historical — the schema has since grown a `model User` (schema.prisma, with the `Role` enum). The text above is kept as written for the record of the original decision.]

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
| `POST/PUT/DELETE /api/network/*`, `/api/firewall/*`, `/api/vpn/*`, `/api/switch/*` (mutations) | `owner`, `admin` |
| `POST /api/services/*/restart` | `owner` |
| `POST/PUT/DELETE /api/cameras/*`, `/api/matter/*`, `/api/smart-home/*` | `owner`, `admin`, `family` |
| `POST/PUT/DELETE /api/files/*` (write) | `owner`, `admin`, `family` |
| `POST/PUT/DELETE /api/llm/sessions/*` (own session) | `owner`, `admin`, `family`, `guest` |
| All `GET` endpoints | unchanged (auth middleware still applies; no role gate) |

Service principals (`service` role) are read-only by design — they hit `GET` endpoints and the MCP tool surface only. The matrix above does NOT include `service` on any write row.

#### Voice smart-home control exception (WARP-1398 amendment)

> **Status of this note:** added 2026-07-18 by WARP-1398, approved by Stefan.
> A single, scoped exception to the read-only default above.
>
> The always-on voice assistant runs as the **`_service:voice`** principal. So
> that "hey Droplet, turn off the kitchen lights" works, `_service:voice` — and
> ONLY that exact principal id, never the coarse `service` role — is granted the
> smart-home **control** write tool (`control_device`) on top of its read tools.
> Every other service principal (`_service:mcp`, `_service:email`, …) stays
> read-only.
>
> Enforced in `routes/llm.ts`: `narrowAllowedToolsForRole(role, requested, isVoice)`
> keeps `VOICE_WRITE_TOOLS = {control_device}` for the voice principal and strips
> every other write tool; the replay spoof-guard exempts the same set. The grant
> is deliberately narrow:
>
> - **No `run_scene`** — a routine can contain a lock command, which would bypass
>   the per-command lock refusal below. Voice-run scenes wait on scene-level lock
>   analysis.
> - **Locks refused via voice.** `control_device` *can* carry a lock command, but
>   locks are Tier-2 (the matter safety layer answers `confirmation_required`) and
>   the voice flow has no way to complete a confirmation — and there is no speaker
>   authentication until per-speaker enrollment (WARP-1056). So a voice lock/unlock
>   is refused at the Tier-2 gate, matching the WARP-336 voice design ("verbal
>   confirm for everything except locks; locks refused via voice").
> - **No network/file/system writes** — only the smart-home control tool.
>
> Human RBAC is unchanged; this widens exactly one non-human principal by exactly
> one tool, with the lock carve-out preserved.

#### Managed-switch control surface (WARP-559)

> **Status of this note:** added 2026-05-31 by WARP-559. The switch
> router (`src/routes/switch.ts`) is part of the network-infrastructure
> control surface and carries the same `owner`+`admin` posture as
> `/api/network/*` and `/api/vpn/*`. It is called out explicitly here
> because it shipped *unguarded* — the lone hardware-control router with
> no `requireRole` wrapper, leaving every mutation reachable by any
> authenticated session (a guest/family or stolen low-priv session could
> disable PoE to cameras, disable ports, or rewrite VLAN membership).

The router mounts bare at `/api` (like `vpn`/`network-wifi`) and applies
`requireRole("owner", "admin")` **per mutating route** (WARP-171 idiom).
The in-handler `evalSwitchCommand` is the WARP-76 safety/confirmation/
audit tier — a complementary layer, NOT the authorization gate — and is
left unchanged; a `requireUserId()` helper now asserts the (post-guard
guaranteed) user id instead of forwarding `undefined` into that tier.

| Endpoint | Allowed roles |
|---|---|
| `POST /api/switch/ports/:port/enable` | `owner`, `admin` |
| `POST /api/switch/ports/:port/disable` | `owner`, `admin` |
| `POST /api/switch/vlans` | `owner`, `admin` |
| `DELETE /api/switch/vlans/:vlanId` | `owner`, `admin` |
| `POST /api/switch/vlans/:vlanId/membership` | `owner`, `admin` |
| `POST /api/switch/poe/:port/enable` | `owner`, `admin` |
| `POST /api/switch/poe/:port/disable` | `owner`, `admin` |
| `POST /api/switch/wan/detect` | `owner`, `admin` |
| `POST /api/switch/setup/cameras` | `owner`, `admin` |
| `POST /api/switch/command/confirm` | `owner`, `admin` |
| `GET /api/switch/*` (status: ports, vlans, poe, system) | every authenticated role (no role gate) |

`POST /api/switch/command/confirm` carries the guard too: confirming a
queued token *executes* the mutation, so leaving it open would be an
unguarded execution bypass even with the create-routes guarded. All ten
mutations are mirrored in `__tests__/rbac.test.ts` (declarative MATRIX +
a real-`createSwitchRouter` wiring block) so a future unguarded switch
route trips a localized test failure.

#### ERP connector surface (WARP-1530 / ADR-032 resolution O-2)

> **Status of this note:** added 2026-07-26 by WARP-1534 (RBAC v2 T10),
> operationalizing the amendment ADR-032 §6 records. The catalog above
> predates `src/routes/erp.ts` entirely and carried **no ERP rows at all** —
> the surface that reaches patient data was the one family the matrix never
> named. These are its first rows. The code change is T6 (WARP-1530); this
> section states the shipped floors, read off `routes/erp.ts` and
> `services/erp.service.ts` on `main`.
>
> **Amended 2026-07-26 by WARP-1579:** the write rows gained a connector-grant
> column. T6 shipped O-2's read half and left writes authorising off the tier
> alone, so an Admin-based role holding a deliberately read-only grant could
> still stage and confirm writes — the level was a label the enforcement
> ignored. See "…and a read-only grant NARROWS them" below.

The floors here are **not** uniform across the surface, which is why they need
their own rows: reads were deliberately widened, writes were deliberately not —
though writes are now **narrowable** by the grant's level, which is a different
thing from being widened by it.

| Endpoint | Allowed roles | Additional gate |
|---|---|---|
| `GET /api/erp/schedule` | `owner`, `admin`, `family` | `AccessRoleConnectorGrant` for `eaglesoft` (see below) |
| `GET /api/erp/patients` | `owner`, `admin`, `family` | same |
| `GET /api/erp/patient/:id` | `owner`, `admin`, `family` | same |
| `GET /api/erp/ar-summary` | `owner`, `admin`, `family` | same |
| `GET /api/erp/recall-due` | `owner`, `admin`, `family` | same |
| `POST /api/erp/write-requests` | `owner`, `admin` | connector grant not `read` (see below) + `IntegrationConnection.writeEnabled` + staged `ErpWriteRequest` outbox |
| `GET /api/erp/write-requests/:id` | `owner`, `admin` | connector grant not `read` |
| `POST /api/erp/write-requests/:id/confirm` | `owner`, `admin` | connector grant not `read` + `writeEnabled` re-checked at apply time + human confirm |

**Reads — family-and-up WITH a grant.** This replaces the flat `owner`/`admin`
gate the route shipped with, and settles the long-standing
header-says-family / code-says-owner-admin discrepancy in favour of the
header, *gated through a grant*. It is what makes a "Reception" role useful.
Both halves are required and neither is sufficient:

- the **tier floor** is real middleware — `requireRole("owner","admin","family")`
  runs first, so guests and `service` principals are refused before any DB
  read. It is load-bearing rather than decorative. When these rows were
  written, `normalizeGrants` (`routes/access.ts`) clamped a connector grant's
  *level* on a non-admin starting point but never **dropped** the grant, so a
  Guest-based role could hold one and the resolver faithfully reported it —
  reading `connectors[provider]` alone would have handed that role PHI.
  WARP-1578 closed that at the write end (a Guest starting point now holds no
  connector grant at all — `clampConnectorLevel`, and the builder shows the
  levels disabled with the reason instead of offering them), but the floor
  stays, for two reasons: rows written before that clamp existed are still in
  the database until their role is edited, and a floor enforced at the
  CONSUMER survives a change to whatever writes the rows, which one enforced
  only at the writer does not;
- the **grant** is `AccessRoleConnectorGrant` for the provider, surfaced by the
  ADR-032 §3 resolver as `connectors[eaglesoft]`. An `admin` with no grant is
  refused too — admins do **not** bypass layer 2 (that is the point of
  Admin-based custom roles). `owner` is the one tier that bypasses the
  resolver entirely.

Two deliberate fall-backs to the pre-O-2 gate, both answering with today's
byte-identical 403 body and `recordAccessDenied` row rather than inventing a
new one: when **no `IntegrationConnection` row exists at all** (the resolver
returns `{}` for everyone, owner included — "there is nothing to see" is not
an authorization answer), and when the **resolver read fails** (no reach is
invented, none is lost). `erp.service.ts` asserts the same floor a second time
on its own (`assertCanReadPhi`), so a change to the resolver cannot silently
widen PHI reach.

**Writes — admin-tier, and no wider.** No role grant widens them: a
`read_write` connector grant is selectable only on an Admin-based role, and it
still does not by itself authorize a write. `IntegrationConnection.writeEnabled`
(the per-practice opt-in kill-switch), the staged `ErpWriteRequest` outbox, and
the human confirm all sit above it, and `writeEnabled` is re-checked at apply
time as well as at stage time so a request staged before writes were turned off
cannot slip through.

**…and a read-only grant NARROWS them (WARP-1579).** The tier is necessary,
not sufficient. An Admin-based role holding a deliberately `read` connector
grant is refused at `erpConnectorWriteGate` — until WARP-1579 the write path
authorised off the tier alone, so "read-only Admin" was a label the
enforcement ignored. The gate reads the **raw** grant
(`connectorGrants[provider]`, WARP-1579's addition to the ADR-032 §3 resolver),
never `connectors[provider]`: the latter is `min(grant, writeEnabled ?
read_write : read)`, so a `read` there cannot distinguish a read-only ROLE
(403, "ask for a read & write grant") from a write-disabled CONNECTION (409
`WRITE_NOT_ENABLED`, "turn writes on in Integrations"), and each names a
different remedy.

The same fall-backs to the pre-narrowing gate apply, for the same reasons:
`owner` bypasses layer 2, a person with **no custom role** is not narrowed at
all (today's world for every admin before RBAC v2), and both a resolver
**throw** and a box with **nothing connected** fall through to the admin-tier
floor. That last posture is deliberate and stated plainly in ADR-032: on this
axis the widening is hard-closed and **the narrowing is soft**, so it is not
an availability-independent control and must not be relied on as one for
compliance.

A resolver **`null`** is not one of those fall-backs. `req.user` is built from
JWT claims alone, so a session can outlive its `User` row and still present a
syntactically valid admin token; the resolver then returns `null`, which is a
*successful* read with a negative answer rather than an outage. Both gates give
that principal the same answer — the grant-absent decision, i.e. 403
`erp-connector-grant-missing` where a connection is configured — so writes are
never softer than reads for the same person. Likewise the raw-grant field is
read as an explicit tri-state (`null` = unnarrowed, `{}` = a role holding no
grants = a denial, absent = fail **closed**), never for truthiness.

`erp.service.ts` asserts the same rule a second time below the route
(`assertCanWrite` refuses an explicit `read`), with absence never a denial.
That assertion reads `ErpUser.connectorGrantLevel`, which the route gate
populates — so it hardens the gate rather than replacing it, and a NEW write
route must register `erpConnectorWriteGate` to be covered.

#### `requireFeatureAccess` narrows within these floors — it never widens them

> **Status of this note:** added 2026-07-26 by WARP-1534, describing the
> WARP-1528 layer that now sits beside every row in this document.

`requireFeatureAccess(moduleId, minLevel)` (`middleware/feature-gate.ts`) is
**layer 2**. Every row in this ADR — the matrix in §3, the switch table, the
ERP table above — remains the authoritative **floor**, enforced by
`requireRole` at layer 1 exactly as before. Layer 2 can only take reach away
from a person *within* a floor they already passed, based on their resolved
ADR-032 §9 grant level. It has no path to grant reach the enum tier does not
already carry, so **no row in this document needs re-reading when a custom role
is created.**

Three passes layer 2 must never narrow, all of them today's-world correctness:
`service` principals (they keep their `requireRoleOrService` paths), a
principal with no local `User` row (the `AUTH_ENABLED=false` dev session and
the Nextcloud OCS fallback — no row means no grants to narrow *by*), and a
request with no principal at all (`authMiddleware` owns the 401). Denials are
**404-consistent** with `requireModuleEnabled` — byte-identical body — so a
feature a person may not open reads as ABSENT rather than FORBIDDEN; a 403
would leak both that the surface exists and that someone else can reach it. The
audit trail stays honest server-side regardless: every denial emits its own
WARP-237 policy-violation row.

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

> **Superseded in part by WARP-1636 — this mapping is a hint, not an authority.** The `admin` group above is Nextcloud's own *instance-administrator* group, which `buildNcGroups` grants to every owner/admin-tier user; reading it back as `owner` let a deliberately-narrowed admin mint the top tier through the Nextcloud OCS auth fallback. The mapping itself is unchanged, but the OCS fallback now mints through `resolveNcSessionRole`, which caps it at the holder's stored `User.role`. Never mint a session from `roleFromGroups` directly. See ADR-032 §7.1.

### 5. Tests

`apps/orchestrator/src/__tests__/rbac.test.ts` — a single file driving the full role × route matrix:

- For each role in `Role`, for each guarded route, assert `200` (allowed) or `403` (denied) per the matrix above.
- Negative tests: `req.user.role` missing → 403; unknown role string → 403 (defense in depth — the enum should make this unreachable, but the middleware fails closed anyway).
- Service-principal regression test: a request with `Authorization: Bearer <SERVICE_TOKEN_VOICE>` is rejected on every guarded write route, accepted on `GET`s.

### 6. `req.user.id` shape contract (WARP-485 amendment)

After WARP-485, `req.user.id` is **always** the local `User.id` UUID, regardless of which auth path populated the session. Previously the OCS fallback in `auth.ts` set `req.user.id = ocs.data.id` (the Nextcloud username string), which silently broke any consumer that compared it against a UUID-shaped value — most visibly the WARP-480 self-action guard on `/api/people/:id` mutations (`req.params.id === req.user?.id`), which always returned false-negative under OCS auth and let an owner authenticated via the OCS fallback DELETE themselves.

WARP-485 shipped in two rounds: round 1 fixed the OCS auth middleware so `req.user.id` is a UUID when the OCS fallback populates the session; round 2 extended the same fix to the **JWT signing path** (login / refresh / invite-accept), which was the dashboard's primary auth path and was independently feeding the NC username string into `JWT.sub` — meaning round 1 alone would have left the bypass open under JWT auth.

Post-fix behavior (both rounds combined):

- **JWT signing — login (`routes/auth.ts:/auth/login`):** after OCS validates the credentials, the route looks up the local `User` row by `nextcloudUsername` and signs the access + refresh tokens with `id = localUser.id` (UUID). The NC app-password is stored in Redis under the UUID key so logout's `getNcToken(req.user.id)` hits the same slot. Fail-closed with **401 `USER_NOT_PROVISIONED`** when no local row exists (or when the prisma client isn't wired into the legacy `createAuthRouter` shim) — silent auto-provision would let an attacker holding a valid OCS credential for an unrelated NC user mint a default-`family`-role local row.
- **JWT signing — refresh (`routes/auth.ts:/auth/refresh`):** re-looks up the local `User` by `id = jwtPayload.sub` before rotating. If no row matches (owner removed the user mid-session, OR the refresh token is a pre-WARP-485 legacy token carrying the NC username in `sub`), the old token is denied, cookies are cleared, and the response is **401 `USER_NOT_PROVISIONED`**. Legacy refresh-token holders re-authenticate on next request and receive a properly-shaped pair from `/auth/login` — this is the deliberate JWT-layer cache bump for the round-2 deploy.
- **JWT signing — invite-accept (`routes/auth.ts:/auth/invites/accept/:token`):** upserts a local `User` row keyed by `nextcloudUsername = invite.username` before signing the JWT, so the freshly-provisioned invitee's first session ships a UUID in `JWT.sub` (not the invite username string). Upsert (not create) so concurrent accept-POSTs that race past the single-use `userInvite.update` don't trip `P2002`-unique on `nextcloudUsername`.
- **Token verification — JWT path (`middleware/auth.ts:verifyAccessToken`):** `req.user.id = jwtPayload.sub`. Post-round-2, every issued `sub` is a local UUID, so this passthrough is correct.
- **Token verification — OCS path (`middleware/auth.ts:validateNextcloudTokenDetailed`):** looks up the local `User` row by `nextcloudUsername` (new column added by WARP-485 — see `prisma/migrations/20260526150000_warp_485_user_nextcloud_username/migration.sql`) and sets `req.user.id = localUser.id`. Same fail-closed posture as the JWT signing paths above.
- **NC token store (`services/nextcloud-session.service.ts`):** every `storeNcToken` / `getNcToken` / `deleteNcToken` / `touchNcToken` call is keyed by the local User.id UUID. Legacy NC-username-keyed entries from pre-WARP-485 deployments orphan and self-expire on the refresh-token TTL (7 days). Long-running deploys can hard-flush by restarting the Redis cache container (`docker compose restart cache`) — runbook unchanged.
- **`req.user.username`** keeps the Nextcloud username (or, post-round-2 for fresh JWT sessions, the canonical user handle) for display continuity. Consumers that need the human-readable handle (brain-memory route filters, audit-log rendering) keep using `username`; consumers that need a stable per-user key (`ScopeBinding.userId` FK lookups, self-action comparisons, NC token cache keys) use `id`.
- **Service principals** (`_service:voice`, `_service:mcp`) are unaffected — they have synthetic ids that never collide with user UUIDs.

The contract is pinned in two test files:
- `apps/orchestrator/src/__tests__/auth.req-user-id.test.ts` — round-1 coverage: JWT-path passthrough, OCS-with-matching-User, OCS-without-User, prisma-not-initialised fail-closed, and the end-to-end WARP-480 self-guard regression under OCS auth.
- `apps/orchestrator/src/routes/auth.jwt-uuid.test.ts` — round-2 coverage: real `/auth/login` → decode the issued JWT → assert `sub === localUser.id` UUID, plus the corresponding 401 fail-closed branches at login / refresh / invite-accept and the UUID-keyed NC token cache slot at logout.

**Out of scope (deferred to follow-ups):**
- The brain-memory on-disk layout uses `BRAIN_ROOT/<userId>/` directories (`services/brain-memory.service.ts:~37`). With round 2, new sessions write under the UUID directory; pre-existing username-named directories remain for users provisioned before this deploy. A targeted follow-up (widened scope of WARP-488) will reconcile the on-disk layout to UUIDs consistently — this ADR's contract is about the in-memory request shape, not the on-disk filesystem layout.

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
- `shared_brain/projects/droplet-onboard-services/CLAUDE.md` — "No guessing, ever" rule (the explicit-column constraint).
- [WARP-171](https://warp-lab.atlassian.net/browse/WARP-171) — this ticket.
- [WARP-248](https://warp-lab.atlassian.net/browse/WARP-248) — ABAC follow-up, deferred.
- [WARP-327](https://warp-lab.atlassian.net/browse/WARP-327) — parent epic, Auth/RBAC/Identity.
- [WARP-480](https://warp-lab.atlassian.net/browse/WARP-480) — self-action + last-owner invariants on `/api/people` mutations (the consumer that surfaced the OCS-id-shape mismatch).
- [WARP-485](https://warp-lab.atlassian.net/browse/WARP-485) — `req.user.id` normalization across JWT + OCS auth paths (the §6 amendment above).
- [`docs/ADR-032-access-roles-custom-rbac.md`](ADR-032-access-roles-custom-rbac.md) — RBAC v2. Decision §6 is the amendment the ERP rows in §3 operationalize; §3 defines the layer-2 resolver those rows depend on.
- [`apps/orchestrator/src/routes/erp.ts`](../apps/orchestrator/src/routes/erp.ts) — `erpConnectorReadGate` (the O-2 tier floor + connector-grant check) and `erpConnectorWriteGate` (the same admin-tier floor, plus the raw grant's level — WARP-1579).
- [`apps/orchestrator/src/services/erp.service.ts`](../apps/orchestrator/src/services/erp.service.ts) — `assertCanReadPhi` / `assertCanWrite`, the second assertion of the same floors below the route.
- [`apps/orchestrator/src/services/access-catalog.ts`](../apps/orchestrator/src/services/access-catalog.ts) — `clampConnectorLevel`, the one authoritative statement of O-2's two connector floors (`read_write` is Admin-only; a Guest starting point holds no grant at all).
- [`apps/orchestrator/src/middleware/feature-gate.ts`](../apps/orchestrator/src/middleware/feature-gate.ts) — `requireFeatureAccess`, the layer-2 narrowing described in §3.
- [WARP-1530](https://warp-lab.atlassian.net/browse/WARP-1530) — RBAC v2 T6, the ERP floor code change these rows document.
- [WARP-1534](https://warp-lab.atlassian.net/browse/WARP-1534) — RBAC v2 T10, which added the ERP rows + the layer-2 note.
- [WARP-1579](https://warp-lab.atlassian.net/browse/WARP-1579) — the write rows' connector-grant column: writes stopped authorising off the tier alone, so a read-only Admin-based role is now enforceable.
- [WARP-1578](https://warp-lab.atlassian.net/browse/WARP-1578) — the Guest connector floor referenced in the read note (a Guest-based role can no longer be saved holding a grant).

## Status audit — 2026-07-27

Flipped `Proposed` → `Accepted`. This ADR had been marked Proposed since
2026-05-25 while being the live authorization model for the whole orchestrator.

Evidence on `main`: `apps/orchestrator/src/middleware/auth.ts` implements the
guards, and **69 route files** import and apply `requireRole`. ADR-032 §6
further *amends* this ADR's per-route guard catalog (the ERP read floor,
operationalized by WARP-1534) — an ADR cannot be amended by a ratified
successor while still being a proposal.
