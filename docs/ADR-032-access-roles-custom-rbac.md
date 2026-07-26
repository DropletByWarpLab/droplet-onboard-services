# ADR-032 — Access & roles (RBAC v2): custom-role data model + enforcement

- **Status:** Accepted (founder ratification, Stefan Cruceru, 2026-07-24 — open decisions O-1..O-4 all resolved; see §Decisions)
- **Date:** 2026-07-24 (ratified); landed 2026-07-25 — build state pinned at `main` `dc625ca0`
- **Ticket:** [WARP-1524](https://warp-lab.atlassian.net/browse/WARP-1524) (this doc) · epic [WARP-1522](https://warp-lab.atlassian.net/browse/WARP-1522) · tickets WARP-1523 + WARP-1525–1534 (§Rollout)
- **Deciders:** Stefan Cruceru (founder); grounded by two read-only research agents against real code
- **Source briefs:** `ACCESS-AND-ROLES-ARCHITECTURE-BRIEF.md` (long-form architecture; its §1 carries the full file:line ground-truth audit) and `ACCESS-AND-ROLES-ADMIN-PANEL-DESIGN-BRIEF.md` + `access-roles-prototype.html` (UI spec), all in the `warp-lab-engineering-handbook` repo. This ADR is the terse in-repo record; the brief is the long form.
- **Amends:** ADR-004 (per-route guard catalog — ERP read floor, Decision §6; the note is operationalized in `ADR-004-rbac-per-route-guards.md` by T10/WARP-1534)
- **Relates:** ADR-029 (rows-not-enums precedent, two-layer enforcement shape, `NcSyncState` reconciler convergence; owns per-library Files rights), ADR-013 (Nextcloud is a write-only projection), WARP-455/WARP-481 (Scope axis — middleware seam reused, enum untouched), WARP-1273 (`Group`/`GroupMembership` stay deprecated), WARP-1306/WARP-1368 (App-Modules registry), WARP-116 (session revocation), WARP-248 (ABAC — later)

## Context

The Access & Roles admin panel ("custom roles across four axes, grown into `/users`") needs admin-authored roles that control, per role:

- **(a) features** — which modules a person sees and uses;
- **(b) action levels** — `view / act / manage` within a feature;
- **(c) usage** — storage-quota / upload-cap / LLM-daily-cap defaults;
- **(d) AI tools & off-box** — tool domains, cloud-model access, lock operation, connector level.

Grounding (brief §1) found every ask maps onto shipped substrate — the ADR-004 `requireRole` floors, the live-but-inert WARP-455 Scope seam, the App-Modules registry + `requireModuleEnabled`, `UserUsagePolicy`, the tools-core domain catalog, the `cloud_model_escape` workspace gate (enforced in ai-gateway, HTTP 451, fail-closed), and `IntegrationConnection.writeEnabled` + the staged ERP outbox. The design **extends, never rebuilds**.

Two facts shaped the shape:

1. **The `Role` pgEnum cannot grow.** It is migration-gated and triple-duplicated in TS by design (canonical copies in `jwt.service.ts` and `packages/tools-core`, plus inlined arrays and zod/UI subsets) — any enum change is a migration plus a multi-file fan-out. Custom roles therefore have to be **rows**: the exact ADR-029 departments precedent.
2. **Grounding surfaced a live privilege escalation** (WARP-1523): the `ROLE_RANK` cap covered only the create/invite sites, not the role-update paths — an admin could promote a user to `owner` via `PATCH /people/:id`. Fixed first, ahead of everything else (PR #1221).

## Decision

### 1. Core decision

A custom role is a **row** — `AccessRole` — whose `startingPoint` **is** the built-in enum tier its people receive: assigning a role sets `User.role = accessRole.startingPoint` **in the same transaction**. Every ADR-004 route floor keeps working unchanged, and the role's per-axis grant rows can only **narrow** within that floor.

Enforcement is **two independent layers**, the ADR-029 shape:

- **Layer 1 (unchanged):** the coarse enum floor — `requireRole` guards stay exactly as registered.
- **Layer 2 (new):** one **effective-access resolver**, consulted by the module gate, the tool-catalog builder and dispatch, the cloud router, and the connector routes.

Nextcloud-affecting changes converge via the existing `NcSyncState` reconciler pattern; nothing is client-trusted; every mutation is Activity-audited. A user with `accessRoleId = null` resolves to the tier's full catalog — today's behavior, bit-for-bit.

### 2. Data model — as built (T1/WARP-1525, merged PR #1222)

Migration `apps/orchestrator/prisma/migrations/20260724000000_warp_1525_accessrole_rbac_v2/` — additive and idempotent (`IF NOT EXISTS` / `duplicate_object` guards throughout), no backfill, no seeds, nothing destructive. Doc comments trimmed below; `apps/orchestrator/prisma/schema.prisma` is the truth.

```prisma
enum FeatureAccessLevel    { view act manage }
enum ToolAccessLevel       { view use }
enum ConnectorAccessLevel  { read read_write }   // absence of row = none
enum AccessExceptionEffect { allow deny }

model AccessRole {
  id            String  @id @default(uuid())
  name          String
  slug          String  @unique
  description   String?
  startingPoint Role     // admin|family|guest — never owner/service; service-layer + zod (T3), deliberately NOT a DB CHECK
  state         String  @default("active")       // active | archived (service-managed; archive keeps rows)
  // axis c — usage DEFAULTS; a person's UserUsagePolicy row overrides
  storageQuotaBytes  BigInt?
  maxUploadSizeMb    Int?
  llmDailyMessageCap Int?                        // rendered; enforcement stays deferred (llm.ts)
  // axis d — the two off-box booleans that are per-role, not per-domain
  cloudModelsAllowed Boolean @default(false)     // under the workspace cloud_model_escape backstop
  mayOperateLocks    Boolean @default(false)     // Tier-2; handler-side confirm stays regardless
  createdBy String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  users           User[]
  invites         UserInvite[]
  featureGrants   AccessRoleFeatureGrant[]
  toolGrants      AccessRoleToolGrant[]
  connectorGrants AccessRoleConnectorGrant[]
}

model AccessRoleFeatureGrant {           // axes a+b — absent row = feature OFF
  roleId   String                        // (chat/home/settings always-on floor is service-enforced, not a row)
  moduleId ModuleId                      // reuses the App-Modules enum — ONE feature vocabulary, no drift
  level    FeatureAccessLevel
  role     AccessRole @relation(fields: [roleId], references: [id], onDelete: Cascade)
  @@id([roleId, moduleId])
}

model AccessRoleToolGrant {              // axis d on-box — absent row = domain OFF
  roleId String
  domain String                          // tools-core ToolDomain value (TS-only union, so TEXT; T5 validates at write)
  level  ToolAccessLevel
  role   AccessRole @relation(fields: [roleId], references: [id], onDelete: Cascade)
  @@id([roleId, domain])
}

model AccessRoleConnectorGrant {         // axis d off-box — absent row = none
  roleId   String
  provider String                        // IntegrationConnection.provider ("eaglesoft")
  level    ConnectorAccessLevel
  role     AccessRole @relation(fields: [roleId], references: [id], onDelete: Cascade)
  @@id([roleId, provider])
}

model UserAccessException {              // design D-A / O-3: feature-axis only in v1
  id        String                @id @default(uuid())
  userId    String
  moduleId  ModuleId
  effect    AccessExceptionEffect
  level     FeatureAccessLevel?          // required when effect=allow — service-enforced (T3)
  grantedBy String
  createdAt DateTime              @default(now())
  user      User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([userId, moduleId])
}

// User gains:       accessRoleId String?  + accessRole (onDelete: Restrict) + accessExceptions + @@index([accessRoleId])
// UserInvite gains:  accessRoleId String?  + accessRole (onDelete: Restrict)
```

**As-built deltas from the brief's §2 sketch** (the merged schema is now the truth):

- **`onDelete: Restrict` on both `User.accessRole` and `UserInvite.accessRole`.** The brief specified "deleting an in-use role is blocked server-side"; as built the DB backs that rule up. The invite-side Restrict deliberately covers **any** invite row that references the role — pending, accepted, revoked, or expired alike (invite rows are retained state, never deleted) — so an invitee's intended access can never silently degrade to the bare tier, and role deletion stays an explicit "reassign first" service flow.
- **`@@index([accessRoleId])` on `User`** (roster and resolver lookups).
- **`AccessRole.invites UserInvite[]` back-relation** — the invite column landed with T1, not deferred to T9; T9 wires the accept path.
- **Grant and exception rows `onDelete: Cascade`** with their role/user — they are composition, not references.

Rules the service layer enforces (never the client): `startingPoint ∈ {admin, family, guest}`; a feature grant's level may not exceed the design-brief §9 catalog ceiling for the role's `startingPoint` (the ADR-004 floor); tool/connector/cloud grants auto-drop when their feature is off; assignment sets `User.role` in-transaction, then fires `revokeAllSessions(target)` and records Activity. `BigInt` fields string-encode at the API boundary.

### 3. Enforcement — two layers plus one resolver

**`effective-access.service.ts`** (T3) is the single resolver — scope-loader-shaped, DB-read per request (box scale is tens of users; no cache in v1), bound at boot:

```
effectiveAccess(userId) = {
  tier          = User.role                                   // the floor
  features      = tier==owner ? ALL
                  : clamp( roleFeatureGrants ⊕ exceptions, catalogFloor(tier) ) ∩ workspaceModules
  toolDomains   = writeFilter(tier) ∩ moduleToolDomains(features) ∩ roleToolGrants
  locks         = role.mayOperateLocks && smart-home ∈ features    // handler confirm stays on top
  cloud         = workspace.cloud_model_escape && role.cloudModelsAllowed
  connectors[p] = min( roleConnectorGrant(p), connection.writeEnabled ? read_write : read )
  usage         = UserUsagePolicy(userId) ?? roleDefaults ?? box default    // shipped early — T7, §Rollout
  deptRights    = read-only reference — ADR-029 owns them; never merged into grants
}
```

Only **`owner`** bypasses layer 2. **Admins do not** — narrowing Admin-based roles is the point of Admin-based custom roles; `requireScope`'s owner/admin short-circuit is deliberately **not** copied into this layer. `service` principals keep their dedicated paths (`requireRoleOrService`), untouched.

Per-axis wiring:

- **(a) features/nav:** `GET /api/modules` grows a per-user effective view (workspace ∩ role); all three nav surfaces inherit through the existing gated `visibleItems` list. Server-side, a new `requireFeatureAccess(moduleId, minLevel)` registers **beside** `requireRole` on module route groups, 404-consistent with `requireModuleEnabled`. The three known nav-gate gaps (child `requiresModule` no-op, ungated Integrations item, fail-open client hook) are fixed while wiring (T4) — the server gate stays the boundary.
- **(b) action levels:** `view/act/manage` maps to route granularity per the design-brief §9 catalog; where a single floor route serves two levels, the level check lives in `requireFeatureAccess`.
- **(d) tools:** the catalog builder **and** the dispatch path intersect with the resolver's `toolDomains` (dispatch re-checks, fail-closed — a stale client tool shelf cannot call a dropped tool); lock ops additionally require `locks`, with the handler's forced confirmation remaining the last line.
- **(d) cloud:** the orchestrator consults `cloud` before selecting a cloud provider for a person's request; ai-gateway's workspace-level 451 gate stays untouched as the identity-free backstop — two independent layers, both fail-closed.
- **(d) connectors:** `erp.ts`'s `canRead`/`canWrite` become resolver checks per O-2 (Decision §6); the `writeEnabled` connection flag and the staged-outbox human confirm remain in force above any role grant.

### 4. Guardrails — one service, in-transaction, both surfaces

`role-mutation-guard.service.ts` (T2), called inside the same serializable `$transaction` by **every** path that creates, changes, or removes a person or assignment:

1. **Owner untouchable** — reject any mutation targeting a `User.role = owner` (new; previously another admin could edit the owner).
2. **Self-action** — the existing check, extended to exception/usage self-strip.
3. **Rank cap on every mutation** — `ROLE_RANK[assignedTier] ≤ ROLE_RANK[actor]`, where assignedTier is the role's `startingPoint` (or the tier directly); also caps role authoring (no Admin-based roles from non-admins). Shipped early for the update paths as WARP-1523/PR #1221, with the assignment ladder consolidated into `jwt.service.ts` (SCIM's separate `ROLE_PRIVILEGE` ladder is tracked epic-side).
4. **Last-owner invariant** — existing, kept.
5. **Last-operator** — block demote/disable/remove that would leave zero non-disabled `owner ∪ admin`.
6. **Post-commit effects** — `revokeAllSessions(target)`, Activity write, NC cascade enqueue.

**Canonical-surface decision:** `/api/people` is the canonical mutation surface (it has the invariants and the sync-state responses the UI needs). The legacy `/api/auth/users*` write paths call the same guard service and are deprecated-for-role-changes in docs — never left divergent again.

**NC cascade:** the best-effort `droplet-admins` group call on admin-tier crossings is replaced by reconciler convergence (the ADR-029 / usage-policy pattern).

### 5. API contract (people.ts conventions: UUIDs everywhere, BigInt as strings, owner/admin + guard service)

- `GET/POST /api/access/roles` · `GET/PATCH/DELETE /api/access/roles/:id` — CRUD + duplicate (POST with `sourceRoleId`) + archive (`state`); NC-affecting responses carry `syncState`.
- `POST /api/access/roles/:id/assign { userIds: [] }` and per-person `PATCH /api/people/:id/access` — the §2/§4 assignment transaction; responds `{ syncState: "pending" }`.
- `GET /api/people/:id/effective-access` — the §3 resolver output verbatim; powers the person editor's drawer and every honest disabled state.
- `PATCH /api/people/:id/usage-policy` — pre-existing, unchanged; role defaults fill when no per-person row (shipped, T7).
- `PUT /api/people/:id/access-exceptions` — small list, feature-axis only (v1, per O-3).
- `GET /api/modules` — gains `effectiveForUser` alongside the workspace view.
- Invite: `POST /api/people/invite` accepts `accessRoleId` (rank-capped via the role's `startingPoint`); the accept path assigns it in the same mint transaction (T9, the WARP-1051 pattern).

**T8-established wire extensions.** The UI (T8, PR #1224) was built contract-first against this section, with every contract guess quarantined in `apps/web-dashboard/src/lib/api.ts` + `lib/types.ts`; T3 must honor or explicitly reconcile the alignment list in #1224's review notes:

- `PATCH /api/people/:id/access { accessRoleId: null, tier }` — the **`tier`** field is a contract extension: assigning a *built-in* tier has no role row to point at.
- Response envelopes `{roles}` / `{role}` / `{syncState}` / `{exceptions}`.
- `AccessRole` wire extras `peopleCount`, `syncState`, `state`; `EffectiveAccess.exceptions`; the `AccessSyncState` vocabulary.
- Roster extension `RosterUser.role` / `.accessRoleId` — T3/T7 ship it, or roster role chips stay degraded.

**Activity vocabulary** (kind `auth`, free-text `what`, refs carry role/user UUIDs): `"Access role created/updated/archived/deleted"`, `"Access role assigned"`, `"Access exception set/removed"`, `"Usage policy updated"` — the shipped naming style (`"Department member added"`), not dotted event names.

### 6. ADR-004 catalog amendment (O-2 — the ERP read floor)

Resolution O-2 amends the ADR-004 per-route guard catalog for the ERP connector surface: **reads become family-and-up *with* a per-role connector grant** — what makes a "Reception" role useful — where `erp.ts:62-63` at `dc625ca0` has owner/admin today (the ADR-004 catalog predates the ERP surface and is silent; T10 adds its first ERP rows); the file's header comment always intended family reads, and the header's intent wins, gated through the grant. **Writes stay admin-tier**, under connection-level `writeEnabled` and the staged-outbox human confirm, and **Read & write grants are only selectable on Admin-based roles** (floor honesty: a Family-based role caps at Read). T10 (WARP-1534) operationalizes this note in `ADR-004-rbac-per-route-guards.md` itself, alongside the E2E pass; T6 (WARP-1530) is the code change.

## Alternatives considered

- **Extending the `Role` or `Scope` pgEnums** — both migration-gated and TS-duplicated; rows are the ADR-029 precedent. The Scope axis keeps its own WARP-481 journey; this feature reuses its middleware seam, not its enum.
- **Reviving `Group`/`GroupMembership`** — `@deprecated` dead code (WARP-1273). `AccessRole` is one-role-per-person ("the role is the headline"), not a group system.
- **Per-user tool allowlists in v1** — per-role only, plus feature-axis exceptions; per-person tool/connector exceptions are a v2 candidate.
- **New enforcement in ai-gateway** — it keeps the workspace-level fail-closed 451; per-person cloud gating lives where user identity lives (the orchestrator).
- **A second Files-rights editor** — ADR-029 owns per-library rights; the resolver only *reads* department rights for display.
- **A `requireBusiness` middleware** — the build is business-only (WARP-1341); there is nothing to gate by type.
- **Impersonation, per-role colors, a permission-matrix UI** — design non-goals.

## Consequences

**Positive**

- Zero-risk floor compatibility: `startingPoint → User.role` in one transaction means every existing `requireRole` route is correct on day one, and legacy users (`accessRoleId = null`) behave bit-for-bit as today.
- Grants only narrow. The workspace gates — module settings, `cloud_model_escape`, connector `writeEnabled`, handler-forced lock confirms — all remain independent backstops above any role grant.
- One feature vocabulary: grants reuse the App-Modules `ModuleId` enum, so the module registry, `ModuleSetting` rows, and role grants cannot drift apart.
- The WARP-1523 escalation class is closed structurally: one rank ladder, applied by one guard service on every mutation path.

**Negative / costs**

- More authz truth to keep converged (enum floor + role grants + workspace settings); the resolver is the single reading point precisely to contain this.
- DB-read-per-request resolution (no cache) is a deliberate v1 simplicity trade at tens-of-users box scale; caching is a measured later change.
- `AccessRoleToolGrant.domain` is TEXT against a TS-only union — write-time validation lives in the service (T5), not the DB.
- The UI shipped contract-first (T8 review-ready before T3/T4 exist): against a live box it renders honest error/empty states until T3/T4 land, and the #1224 alignment list is a real reconciliation obligation on T3, not optional.

## Rollout — epic WARP-1522 (build state at landing, `main` @ `dc625ca0`, 2026-07-25)

| # | Key | Scope | Depends | State |
|---|---|---|---|---|
| T0 | WARP-1523 | Rank cap on role-update paths + ladder consolidation | — | **Merged** (PR #1221) |
| — | WARP-1524 | This ADR in `docs/` | brief ratified | **This doc** |
| T1 | WARP-1525 | Schema: `AccessRole` + grant tables + `accessRoleId` columns | — | **Merged** (PR #1222; migration `20260724000000_warp_1525_accessrole_rbac_v2`) |
| T2 | WARP-1526 | `role-mutation-guard.service.ts` — rails 1–6, both surfaces | T0 | In flight |
| T3 | WARP-1527 | `effective-access.service.ts` + effective-access route + roles CRUD/assign | T1, T2 | In flight (T2 chain) |
| T4 | WARP-1528 | Per-user module gate + `requireFeatureAccess` + the 3 nav-gate fixes | T3 | In flight (T2 chain) |
| T5 | WARP-1529 | Tool-domain narrowing at catalog build + dispatch; `mayOperateLocks` | T3 | In flight (T2 chain) |
| T6 | WARP-1530 | Cloud + connector grants wired (O-2) | T3 | In flight (T2 chain) |
| T7 | WARP-1531 | Role usage defaults in effective resolution | T1 | **Merged** (PR #1223; `effective-usage.service.ts`) |
| T8 | WARP-1532 | UI: Roles & access tab + role builder + person-editor/People extensions | T3–T7 + design packet | **Review-ready** (PR #1224, contract-first; merge after T3/T4/T7) |
| T9 | WARP-1533 | Invite-modal extension + accept-path assignment | T1, T8 | Pending |
| T10 | WARP-1534 | E2E + ADR-004 catalog note + handbook sync | all | Pending |
| F1 | WARP-1580 | ToolSpec runner consults the §3 resolver; scheduled fires run as the spec's attributed creator | T3, T5 | In flight |

One PR per ticket through the harness, bottom-up merges (the WARP-1117..1123 precedent).

### F1 (WARP-1580) — the scheduled-principal decision

T5 narrowed the two surfaces a chat turn reaches tools through. The ToolSpec
runner reaches the same registry through neither, so a spec was a laundering
path around the narrowing — and a **scheduled** spec had no principal at all
to narrow against.

Interactive run-now (`POST /api/tools/:slug/runs`) is the easy half: there IS a
principal, so it resolves the same `resolveToolAccessScope` a chat turn does
and hands it to the runner, which re-checks with the same `toolDispatchDenial`
the agent loop runs before `mcp.callTool`. One predicate, now three
enforcement points, still zero copies.

**Scheduled fires run as the spec's CREATOR (`ToolSpec.ownerId`), and that
identity's CURRENT effective access is resolved at EVERY fire.** Resolving at
fire time rather than schedule time is the load-bearing part: grants, tier and
directory status all change after a schedule is written, so a schedule-time
check is stale by construction — and stale in the fail-OPEN direction. Per-fire
resolution is what makes "the creator was demoted last week" actually stop the
run. The two alternatives were rejected for the same underlying reason: an
explicit **system principal** is by construction un-narrowable and any
operator-authored spec could borrow it (this hole, one hop further away), and
**refusing to schedule** specs that touch narrowed domains refuses at the wrong
moment and goes stale identically.

Fail-closed, deliberately inverted against the request path: there, "no
principal" means `AUTH_ENABLED=false` and resolves to owner; on the attributed
path it means we do not know who is asking, so an absent `ownerId`, a missing
or `DEACTIVATED` creator, or a failed read all resolve to `DENY_ALL_TOOL_SCOPE`
and the fire is skipped, audited with its reason, and `nextFireAt` advanced.
Deactivation is checked ahead of the owner bypass — an identity that may not
act cannot be acted AS.

## Decisions (O-1..O-4) — resolved 2026-07-24 (founder: "go with your recommendations")

| # | Decision | Resolution |
|---|---|---|
| O-1 | `family` display label | **"Staff."** Copy-only; the enforced enum value stays `family`. "Member" would collide with the UI's generic "member(s)" noun; "Staff" matches the tier's own caption ("everyday staff access") and the business-box audience. |
| O-2 | ERP floor | Reads **family-and-up with a connector grant**; writes stay admin-tier + `writeEnabled` + outbox confirm; Read & write grants only on Admin-based roles. Also resolves the `erp.ts` header-vs-code discrepancy — the header's intent wins, gated through the grant. Amends ADR-004 (Decision §6). |
| O-3 | Exceptions | **Ship in v1, feature-axis only** (`UserAccessException`); tool/connector exceptions deferred to v2. |
| O-4 | Ticket filing | **T1–T10 filed under WARP-1522** on 2026-07-24 (T0 = WARP-1523, filed earlier); keys stamped in §Rollout. |

## References

- **Long-form brief:** `ACCESS-AND-ROLES-ARCHITECTURE-BRIEF.md` (`warp-lab-engineering-handbook` repo), ratified 2026-07-24 — its §1 (ground truth, file:line) and §3/§9 (per-axis wiring + feature catalog) are the detail behind this ADR. UI spec: `ACCESS-AND-ROLES-ADMIN-PANEL-DESIGN-BRIEF.md` + `access-roles-prototype.html` (same repo).
- **Sibling ADRs:** `ADR-004-rbac-per-route-guards.md` (amended — Decision §6), `ADR-029-teams-departments-files.md` (rows + two-layer + reconciler precedent), `ADR-013-builtin-directory-vs-nextcloud.md` (write-only projection).
- **As-built code (`main` @ `dc625ca0`):**
  - `apps/orchestrator/prisma/schema.prisma` — `AccessRole`, `AccessRoleFeatureGrant`, `AccessRoleToolGrant`, `AccessRoleConnectorGrant`, `UserAccessException`, `User.accessRoleId`, `UserInvite.accessRoleId`
  - `apps/orchestrator/prisma/migrations/20260724000000_warp_1525_accessrole_rbac_v2/migration.sql`
  - `apps/orchestrator/src/services/effective-usage.service.ts` (T7) · `apps/orchestrator/src/services/jwt.service.ts` (consolidated rank ladder, T0)
  - `apps/orchestrator/src/routes/erp.ts:62-63` (pre-O-2 floor; changes in T6)
- **Jira:** epic [WARP-1522](https://warp-lab.atlassian.net/browse/WARP-1522); prereqs WARP-449 (Done), WARP-1051 (Done); relates WARP-327 (auth umbrella), WARP-455/WARP-481 (Scope axis), WARP-1251/ADR-029 (Teams), WARP-248 (ABAC later).
