# ADR-029 — Teams / Departments for Droplet Files

- **Status:** accepted
- **Date:** 2026-07-11
- **Ticket:** WARP-1252 (ADR doc); epic WARP-1251 + tickets WARP-1252–1275
- **Deciders:** Stefan, Romain (gate: WARP-449 + WARP-1051 merged before any dept route ships)
- **Supersedes / relates:** ADR-002 (home/small-team persona), ADR-004 (RBAC per-route guards), ADR-007 (dual-workspace personal/household), ADR-013 (orchestrator is identity source; Nextcloud is write-only projection), ADR-027 (Files SharePoint-parity), WARP-878 (Files epic), WARP-449 (~22 unguarded routes, blocking prereq), WARP-1051 (invite-admin gets owner session, blocking prereq), WARP-1245 (manager right absorbs this)

## Amendment — 2026-07-11 (Stefan: founder sign-off on open decisions)

Three critical decisions finalized on the day of filing:

1. **D-1 APPROVED: Admin access to personal homes, `owner` role only.** Company owns the data (Google Workspace model: the domain admin can access a user's Gmail). Gated to `owner` (super-admin tier) only, read-only, NC-admin-credential (never raw disk), one HMAC ActivityRow per listing **and per download**, persistent "every access is logged" banner. T19b (WARP-1272) is un-gated and scheduled **after T16** (platform hardening). The `admin` role does **not** get this — only `owner`. Enforcement: role-change hooks (WARP-116 machinery) sync droplet-admins on promote/demote.

2. **D-3 RESOLVED: Both Departments AND Teams — teams nest inside departments one level deep.** The hierarchy is `Department` (top) → `Team` (child). Model change: `DepartmentKind` gains `TEAM` and `Department` gains self-referential `parentId` (validation: a TEAM's parent must be `kind=DEPARTMENT`; HOUSEHOLD and bare DEPARTMENT have null parent). Every team is still its own space — own groupfolder + own `dept-<deptslug>-<teamslug>{,-ro}` groups — so `requireSpaceAccess`, the reconciler, search sentinels, and the two-layer enforcement are **unchanged in shape**; teams are rows like departments, just with a parent. NC mount point: nested `<Dept>/<Team>` if the T2 spike validates nested mount_points (WARP-1254), else flat `<Dept> — <Team>`. **Inherited-manager rule:** a `manager` of the parent department holds implicit `manager` right on its child teams (one extra indexed lookup in the middleware); plain department members get NO implicit team access — team membership is explicit.

3. **Build directive:** work the epic now, lowest-cost models, PR per ticket through the harness (review-ready, bottom-up merge chain where stacking is unavoidable). A Claude Design input brief for the new UI surfaces ships alongside this amendment.

---

## Context

Droplet already ships a household-wide shared library (WS-5 from ADR-027: the Nextcloud **`groupfolders`** app, bound to the household group). What is missing:

| Ask | Shipped substrate | What's missing (this feature) |
|---|---|---|
| Dynamic departments with own file libraries | WS-5: ONE "Household" Nextcloud groupfolder + space switcher | N dynamic department libraries with lifecycle (create/archive/delete) |
| Individual/private files | Per-user private NC homes, per-user app-passwords (shipped) | Nothing — stays as-is |
| Admins see all files | — (admins have NO see-all today) | `droplet-admins` NC group at full mask on every library + audited entry (D-1) |
| Per-user rights | Role enum + raw OCS share proxy; **Scope axis is live** (`requireScope` guards the 3 `exec_only` people-mutation routes, WARP-455) but is **not** yet applied to files routes (WARP-481 To Do) | `reader / contributor / manager` per-department membership rights |
| Per-user usage settings | NC quota read/set proxy exists; **zero** local quota/usage columns | `UserUsagePolicy` (storage quota, upload cap, optional LLM cap) |
| Seamless | Space switcher, member-picker sharing, comments/tags, FTS — all shipped (WS-1..5) | Departments surface in the same switcher; Home mode pixel-identical |

Ground-truth audit confirmed:

- **Role axis is live** — `Role` enum + `requireRole` guard 33 routes (WARP-171/ADR-004). No implicit owner short-circuit; every guarded route lists owner explicitly.
- **Scope axis is shipped and LIVE** (corrected 2026-07-12) — `Scope` pgEnum + `ScopeBinding` + `requireScope` (WARP-455) are **not** dead: `requireScope("exec_only", loadUserScopes)` guards **three** live, mounted production routes — `PATCH /api/people/:id/role` (people.ts:345), `PATCH /api/people/:id/scope` (people.ts:464), and `DELETE /api/people/:id` (people.ts:552), all mounted via `app.use("/api", createPeopleRouter(...))` (app.ts:365). `ScopeBinding` is read by `loadUserEffectiveScopes` (scope-loader.service.ts:78) and written by the scope-PATCH route (people.ts:504/507). What is still **To Do (WARP-481)** is *extending* Scope enforcement to files routes — which this ADR explicitly declines (departments are the v1 grouping mechanism for files; see Non-goals). Separately, the `File` scope-registry model (also WARP-455) has zero Prisma-client usage — **that** is the schema-only dead code we now repurpose (§1).
- **`Group`/`GroupMembership` are 100% dead code** — no CRUD, no reads anywhere. Deprecate now, drop post-GA.
- **Enforcement base is not yet trustworthy** — WARP-449 (~22 unguarded routes) and WARP-1051 (invite-admin gets owner session) are **blocking prerequisites** before any dept route ships.
- **Search corpus staleness** — `householdSearchUserIds` uses WebDAV probes + 300 s Redis cache: a revoked member keeps search hits for up to 5 min. This design kills the class structurally.
- **WARP-882 (WS-4 OnlyOffice)** is status Done but contradictory — ground-truth verification is a hard gate (T2, WARP-1254) before any dept co-editing copy ships.

---

## Decision

Departments are **Prisma rows** (dynamic, operator-created), each mapped to one Nextcloud **groupfolder** + two NC groups (`dept-<slug>` [mask 15: read+write, **share bit withheld**] and `dept-<slug>-ro` [mask 1]). Nextcloud stays a **write-only projection** (ADR-013): local Prisma rows with explicit sync-state enums are the only truth; a 5-minute reconciler converges NC toward Prisma and overwrites out-of-band drift. Enforcement is **two independent layers** — orchestrator policy (`requireSpaceAccess` middleware + membership rows) and NC group masks (bytes) — both must fail before a byte leaks.

### 1. Data model (exact Prisma, additive migration)

All state is explicit enums — never IS-NULL-derived. All user FKs are the **local `User.id` UUID**, never the NC username (WARP-881 IDOR rule).

```prisma
enum DepartmentRight {
  reader        // list/download/search/read metadata
  contributor   // + upload/mkdir/rename/move/copy/delete/trash/versions/favorite
  manager       // + create shares on dept content, manage dept membership (absorbs WARP-1245)
}

enum DepartmentKind {
  HOUSEHOLD     // the seeded WS-5 system department — legacy NC group adopted verbatim (zero NC mutation)
  DEPARTMENT
  TEAM          // 2026-07-11 amendment: nested one level under a DEPARTMENT parent
}

enum ProvisionState { pending  provisioning  active  failed  archiving  archived }
enum NcSyncState    { pending  synced  failed  removing }

model Department {
  id              String            @id @default(uuid())
  name            String            @unique              // display + groupfolder mount_point
  slug            String            @unique              // lowercase-dash; NC groups dept-<slug>{,-ro}; teams: dept-<deptslug>-<teamslug>
  parentId        String?                                // TEAM → its DEPARTMENT; null for HOUSEHOLD/DEPARTMENT
  parent          Department?       @relation("DeptHierarchy", fields: [parentId], references: [id])
  teams           Department[]      @relation("DeptHierarchy")
  description     String?
  kind            DepartmentKind    @default(DEPARTMENT)
  state           ProvisionState    @default(pending)
  provisionError  String?
  ncGroupRw       String?           @unique              // "dept-<slug>"; household: legacy householdGroupName()
  ncGroupRo       String?           @unique              // "dept-<slug>-ro"; null for kind=HOUSEHOLD
  ncGroupfolderId Int?              @unique              // discovered via gfListFolders; NEVER a sentinel key
  quotaBytes      BigInt?                                // null = unlimited; pushed via gfSetQuota
  aclVersion      Int               @default(0)          // bumped in-tx on EVERY membership/state mutation
  createdBy       String                                 // local User.id
  createdAt       DateTime          @default(now())
  updatedAt       DateTime          @updatedAt
  archivedAt      DateTime?
  memberships     DepartmentMembership[]
  shares          DepartmentShare[]
  inviteGrants    UserInviteDepartment[]
  @@index([state])
}

model DepartmentMembership {
  id               String           @id @default(uuid())
  departmentId     String
  userId           String                                // local User.id UUID
  right            DepartmentRight  @default(contributor)
  syncState        NcSyncState      @default(pending)
  syncError        String?
  ncPermissionMask Int?                                  // last mask confirmed pushed (15 | 1) — drift forensics
  grantedBy        String
  grantedAt        DateTime         @default(now())
  updatedAt        DateTime         @updatedAt
  department Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)
  user       User       @relation(fields: [userId],       references: [id], onDelete: Cascade)
  @@unique([departmentId, userId])
  @@index([userId])
  @@index([syncState])
}

// Shares on dept content are minted by the NC admin credential (members' masks withhold the share
// bit), so NC's uidOwner is the admin account — this table holds the TRUE creator for authz.
model DepartmentShare {
  id            String   @id @default(uuid())
  departmentId  String
  ncShareId     Int      @unique
  createdById   String                        // local User.id of the manager who minted it
  shareType     Int                           // 0=user, 1=group (phase 2), 3=link
  path          String                        // dept-root-relative, display/audit only
  createdAt     DateTime @default(now())
  revokedAt     DateTime?
  department Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)
  @@index([createdById])
}

model UserInviteDepartment {
  id           String          @id @default(uuid())
  inviteId     String
  departmentId String
  right        DepartmentRight @default(contributor)
  invite     UserInvite @relation(fields: [inviteId],     references: [id], onDelete: Cascade)
  department Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)
  @@unique([inviteId, departmentId])
}

model UserUsagePolicy {
  userId              String      @id                    // FK User, onDelete Cascade
  storageQuotaBytes   BigInt?                            // local desired state → ncUpdateUser(...,'quota',...)
  quotaSyncState      NcSyncState @default(pending)
  maxUploadSizeMb     Int?                               // per-user override of config.MAX_UPLOAD_SIZE_MB
  llmDailyMessageCap  Int?                               // optional (decision D-7)
  updatedBy           String
  updatedAt           DateTime    @updatedAt
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

**Repurposed:** the dead WARP-455 `File` **registry model** (the schema-only, zero-client-usage table — *not* the live Scope axis) gains `departmentId String?` + index and finally gets writers (upload-route upsert + file-indexer backfill) — it becomes the O(1) `ncFileId → space` resolver that gates comments/tags/citations/editor-session against cross-department leakage.

**Deprecated now, dropped post-GA:** `Group` + `GroupMembership`.

**Untouched:** `Role` enum, and the **live** `Scope`/`ScopeBinding`/`requireScope` axis — its three `exec_only` people-mutation guards (people.ts:345/464/552, WARP-455) stay exactly as shipped and keep running as info-classification defense-in-depth. WARP-481 (extend Scope enforcement to *files* routes) is proposed closed as superseded-for-files; closing it removes nothing from those live guards — decision for Stefan.

### 2. Enforcement model — two independent layers

#### 2.1 Route guard — `requireSpaceAccess(minRight)`

New `middleware/space.ts`, composed after `authMiddleware`/`requireRole`. `?space=` is threaded **server-side into every files route, reads AND writes** — killing the client-side `toHomeRelativePath` duplication that caused WARP-1140/WARP-1200.

| Caller | `personal` | `dept:<id>` (active) | pending/failed/archiving/archived | unknown space |
|---|---|---|---|---|
| owner/admin | pass | **short-circuit pass** + ActivityRow when not a member (audited see-all) | 403 (except archiving mgmt) | 403 |
| family | pass | pass iff `membership.right >= minRight` | 403 | 403 |
| guest | pass (reads only, existing guards) | pass iff member AND `minRight === reader` | 403 | 403 |
| service | existing `requireRoleOrMcpService`; asserted user's membership checked | same | 403 | 403 |

Membership lookup = one indexed `findUnique` — **no Redis ACL cache**, so route-level revocation has zero staleness window. Cross-space move/copy checks rights on **both** source and target. Every denial → `recordAccessDenied` ActivityRow.

#### 2.2 SQL layer — search + metadata

- `deptSearchCorpora(userId)` replaces `householdSearchUserIds`: reads memberships from Prisma (no WebDAV probes), returning `[ncUsername, '__household__', ...'__dept_<departmentUuid>__']`. Sentinels keyed on **Department UUID**, never NC groupfolder id (groupfolder ids get reassigned on NC reinstall → corpus crossover).
- **Staleness killed structurally:** search cache keys embed `max(aclVersion)` across the caller's departments; every membership mutation bumps `aclVersion` **inside the same `$transaction`** — stale cached results become unreachable by key, not by remembered invalidation calls.
- **Metadata gate:** comments/tags/citations/editor-session routes resolve `ncFileId → File.departmentId` and run `requireSpaceAccess('reader')`. Ships in the **same release** as dept spaces (fail-open = cross-department metadata leak).

#### 2.3 NC layer — bytes

- `dept-<slug>` → mask **15**; `dept-<slug>-ro` → mask **1**; box-wide `droplet-admins` → mask **31** on **every** groupfolder incl. Household. Share bit withheld from members **by construction** — the raw OCS share proxy cannot mint dept shares with a member token even if an orchestrator guard regresses (the exact WARP-449 failure class, backstopped).
- Non-members are simply not in the group: the groupfolder never mounts; WebDAV-direct, MCP-asserted, and WOPI byte fetches all inherit this.
- The reconciler is the **only writer** of NC group/groupfolder state. NC state is never read back as truth (only `gfListFolders` for id discovery and `oc:size`/quota-used for display).

#### 2.4 Shares on department content

Manager-only. Orchestrator verifies `manager` right → mints the OCS share with the **NC admin credential** → writes `DepartmentShare` (true creator) + HMAC ActivityRow, in that order. Update/revoke authorizes against `createdById` (or owner/admin/any manager of that dept). Personal-space sharing untouched. Share-to-department (shareType:1 → `dept-<slug>-ro`) is explicit **phase 2** (T22).

#### 2.5 Admin-sees-all — two tiers

- **Tier 1 (ships with GA):** `droplet-admins` membership → every dept library in admins' space list, own-token access, zero special code paths. Entry into a non-member dept emits an ActivityRow — see-all is **loud**. Role promote/demote hooks the same path that already revokes sessions (WARP-116 machinery). **This tier is unconditional and not narrowable by a custom role** — ADR-032 §3's "Admins do not bypass layer 2" governs the application plane only, and reads as a contradiction of this bullet until you name the plane. Reconciled in ADR-032 §7 / O-5 (2026-07-27), which resolves in favour of this ADR; WARP-1558 is the sweep that makes membership follow role tier in both directions.
- **Tier 2 (personal homes) = Decision D-1, founder sign-off required, severable ticket (T19b):** read-only, NC-admin-credential (never raw `NEXTCLOUD_DATA_ROOT` reads), owner-gated, per-access audited. A persistent "every access is logged" banner. One HMAC ActivityRow per listing **and per download**.

#### 2.6 Bypass-path audit

| Path | Closed by |
|---|---|
| WebDAV via own token | NC group non-membership — folder never mounts |
| Files route with missed guard | NC mask still denies (layer-2 backstop) |
| Raw OCS share proxy exfil | Share bit withheld (mask 15); manager path orchestrator-minted only |
| RAG/search after revocation | Prisma corpus + `aclVersion`-keyed cache — transactionally immediate |
| ncFileId metadata after removal | File-registry `departmentId` gate, same-release |
| MCP `_service:mcp` asserting a user | Asserted user's membership checked; asserted user's NC token used |
| WOPI/OnlyOffice byte fetch | User's NC session → groupfolder mask; WARP-882 ground truth verified first (T2) |
| NC admin-UI out-of-band edits | Declared unsupported; reconciler overwrites within ≤5 min |
| Row-deleted-but-group-lingers | Revocation ordering: NC removal FIRST, then row (fail-closed) |
| Rights-change transition window | Upgrade add-then-remove; downgrade remove-then-add (fail-closed) |
| NC reinstall reassigns groupfolder ids | UUID sentinels; reconciler re-discovers ids |
| Client-forged `isBusiness` flag | Never consulted for authz — membership/role only |

### 3. Provisioning lifecycle

New NC client functions in **one module** of `nextcloud.client.ts` (admin basic-auth, ActivityRow-audited, idempotent): `ncAddUserToGroup` / `ncRemoveUserFromGroup` / `ncListGroupMembers` + groupfolders REST `gfListFolders` / `gfCreateFolder` / `gfDeleteFolder` / `gfAddGroup` / `gfRemoveGroup` / `gfSetGroupPermissions` / `gfSetQuota`. CI integration-tests these against the **pinned NC container image** (the groupfolders app API is version-fragile). No new egress hosts.

- **Create dept** — `POST /api/departments` (owner/admin): validate slug/name vs reserved names → insert `pending` → async provisioner walks groups → groupfolder → masks → quota → `active`. Failure → `failed` + error surfaced in UI; reconciler retries. Pending/failed depts are not browsable (fail-closed).
- **Add member** — tx {row `pending`, bump `aclVersion`} → NC group add → `synced`. UI shows "syncing" until converged.
- **Change rights** — upgrade: add-then-remove; downgrade: remove-then-add (momentary state is fail-closed both ways). contributor↔manager is policy-layer only (same NC group).
- **Remove member** — tx {`removing`, bump `aclVersion`} → NC group removal (both groups) → delete row. Policy access dies at commit; byte access at the NC call; NC failure leaves the row `removing` (still denied) for reconciler retry.
- **Delete/archive** — `archiving` → detach member groups (keep `droplet-admins` for retrieval) → grace window → `gfDeleteFolder` → `archived`. Reconciler **never** deletes a groupfolder outside an explicit `archiving`.
- **Reconciler** — bounded cron (no while-true), boot + post-mutation + **every 5 min**: converges Prisma-desired vs NC-actual, maintains the `droplet-admins`-everywhere invariant, re-discovers groupfolder ids, alerts on persistent `failed`.
- **Invites** — invite modal writes `UserInviteDepartment` rows; all three user-provisioning call sites (`/auth/setup`, invite-accept, admin create-user) join department groups after `ncCreateUser`.
- **Factory-reset / reflash** — full reset = clean slate + Household re-seed. Restic restore of Prisma + fresh NC = reconciler recreates groups/folders from rows. **Verified on the .87 box before GA** (T16 — the factory-reset-silent-wipe and reflash-strips-config precedents both say this gets missed otherwise).

### 4. Per-user usage settings

First local persistence for per-user limits (`UserUsagePolicy`):

- **Storage quota** — local desired state → pushed via existing `ncUpdateUser(...,'quota',…)`; `quotaSyncState` tracks pushdown; used-bytes is display-only read-back, never policy truth.
- **Upload cap** — `maxUploadSizeMb` enforced in the multer path: `min(config.MAX_UPLOAD_SIZE_MB, policy.maxUploadSizeMb ?? ∞)` per authenticated user.
- **LLM daily cap** — optional (D-7): checked in `routes/llm.ts` beside `narrowAllowedToolsForRole`, Redis UTC-day counter, honest 429 copy.
- **Department quota** — `Department.quotaBytes` → `gfSetQuota` (real NC enforcement).
- **Admin read surface** — `GET /api/admin/files/usage`: per-user `{quota, used, free}` + per-dept `{size, quota}`. All BigInt fields string-encoded at the API boundary.

### 5. UI surfaces (all Business-gated per ADR-007; Home mode pixel-identical)

- **Files** — `FileSpaceId` widens to string; `useSpaces` consumes `{id, name, right, kind: personal|household|department, state}`; `SpaceSwitcher` keeps the segmented tablist ≤3 spaces, degrades to the handoff-6 Menu primitive beyond; readers see write actions disabled with honest tooltips; provisioning/failed depts render state chips, not silent absence; personal-root listing hides all active dept mount names.
- **ShareDialog** — dept files: share tab visible to managers/admins only (server re-checks); "Shared by me" gains the `DepartmentShare` slice.
- **People (`/users`)** — new **Departments** tab: dept list with state chips + quota, create/rename/archive modals, per-dept member table with a single `Reader|Contributor|Manager` select (neutral `dp-status-chip` treatment until the `--role-*` ramp drift D-A..F reconciles). Managers see only their own dept's panel. Edit dialog gains a **Usage** section (quota + upload cap). Invite modal gains an optional department multi-select with per-pick right.
- **Admin (`/admin/files`)** — usage roster, per-dept size+quota editor, "open library" jump; the personal-home browser exists **only if D-1 signs**, with a persistent "every access is logged" banner.
- **Design packet first:** a files sub-view addendum (per the design punch list) precedes all frontend tickets; it also fixes the vocabulary decision D-3 ("Departments" vs "Teams" — "department" appears nowhere in the brand bundle today).

### 6. Migration from shipped state (all additive/reversible)

1. Additive schema migration (§1) — Role/Scope untouched.
2. **Household absorption, zero NC mutation:** idempotent boot seed adopts the existing Household groupfolder verbatim as a `kind=HOUSEHOLD` department; membership backfill by role (guest→reader, family→contributor, owner/admin→manager). Only NC write on upgrade: attach `droplet-admins` to the household folder.
3. Household convergence to the standard rw/ro two-group regime = explicit **post-GA** ticket (D-5); until then per-member rights edits on Household are disabled with an honest tooltip.
4. Spaces API v2 goes DB-driven; `shared` kept as an alias id for one release (mobile/MCP callers).
5. Server-side `?space` threading on all write routes; dashboard deletes `toHomeRelativePath`.
6. Search cutover: indexer maps `__groupfolders/<id>/` → Department-UUID sentinel via a Prisma-fed lookup; household keeps emitting `__household__` (**no reindex**); orchestrator tolerates both sentinel forms during rollout.
7. Scope-axis disposition: WARP-481 (extend Scope enforcement to *files* routes) proposed closed as superseded-for-files. The **live** `requireScope("exec_only")` guards on the three people-mutation routes (people.ts:345/464/552, WARP-455) are untouched by this ADR — no code migration, no guard removal (decision for Stefan).
8. Post-GA cleanup: drop `Group`/`GroupMembership`; retire `shared` alias.

### 7. Security review checklist

Prereqs: WARP-449 + WARP-1051 merged before any dept route ships · fail-closed matrix tested for every caller × space-state combo · all FKs local UUIDs (grep-gate) · cross-space dual-check tested · share-bit-withheld verified against the live pinned NC image · `aclVersion` bump provably in-tx (single helper; test asserts no mutation path skips it) · revocation e2e (search dead at commit, bytes at NC call, metadata via registry gate) · reconciler never deletes outside `archiving` · NC-reinstall simulation shows no corpus crossover · `isBusiness` never reaches authz · restic/factory-reset/reflash verified on .87 · WARP-882 ground truth verified before any co-editing copy · BigInt string-encoded everywhere.

---

## Security

- **RBAC (ADR-004 per-route guards).** All department routes carry role guards. Write/mutating routes (`POST /api/departments`, membership create/update/delete, share create/revoke) require role from the caller's own hierarchy (owner/admin override; manager sees own depts only). GET endpoints stay auth-middleware-only with no role gate (ADR-004 §3), enforcing per-user isolation in SQL via `requireSpaceAccess`. All routes added to `src/__tests__/rbac.test.ts` allowlist matrix.

- **IDOR boundary (departmentId/userId).** Non-privileged roles (family/guest) can only read/mutate membership rows and spaces where they are themselves members; owner/admin see all. The `userId` column is always `req.user.id` (local UUID), never derived from username.

- **Manager implicit access (teams):** A manager of a parent department implicitly holds manager right on child teams — wired as an indexed lookup in the middleware, not a materialized field. The lookup is the **only** source of truth; no denormalized flags.

- **NC share-bit enforcement.** Members of a dept group never get OCS share bit (mask 15 lacks bit 4). Shares are minted **only** by orchestrator with NC admin credential → `DepartmentShare` row. This is the backstop against WARP-449 (missed guard on raw `/api/shares` proxy).

- **Search cache versioning.** Cache keys embed `max(aclVersion)` across the caller's departments. Membership mutations bump `aclVersion` **inside the same `$transaction`** as the row change. This kills the staleness window structurally — no per-key invalidation calls.

- **Metadata IDOR (comments/tags/citations/editor-session).** Routes resolve `ncFileId → File.departmentId`, verify space access via `requireSpaceAccess('reader')`, and fail-closed. Cross-department metadata leakage is fail-open if skipped; it ships in the **same release** as dept spaces, or not at all.

- **Admin see-all audit trail.** Every non-member dept access by owner/admin generates an ActivityRow (D-1: per listing **and per download** for personal homes). The "every access is logged" banner is UI-rendered on all admin-only views.

- **Privilege check on edit/revoke.** Share/member revoke checks `createdById` (for shares) or `departmentId membership` (for members) before allowing mutation; owner/admin can revoke anyone's; managers can revoke members of their own depts only.

- **Fail-closed revocation.** NC group removal happens **before** row deletion; if the NC call fails, the row stays in `removing` state (access permanently denied) until reconciler succeeds. Conversely, membership state is bumped to `removing` **before** the NC call, so a crashed route leaves policy access denied.

- **NC reinstall → groupfolder id reassignment.** Search corpus uses Department UUID sentinels (not groupfolder ids), and the reconciler discovers the new groupfolder id on boot. Stale id references in search cache are unreachable by the re-computed sentinel.

- **Client-side `isBusiness` flag.** Never consulted for authz decisions. Space kind (personal/household/department) is stored in Prisma and evaluated server-side only.

---

## Consequences

**Positive**

- All four enforcement layers (orchestrator policy + NC group masks + Prisma identity FK + search cache versioning) provide independent defense-in-depth. A single missed guard is not a leak.
- Membership revocation has **zero staleness window** (no Redis ACL cache) — policy access dies the moment the row is committed.
- Departments are **rows**, not enum values, so the number and names are dynamic and can be managed via the UI without schema releases.
- Manager delegation (parent-dept manager → implicit child-team manager) reduces team-creation friction and scales better than explicit role assignment per team.
- Household adoption is **zero-NC-mutation** — the existing Nextcloud state is preserved and only annotated with Prisma metadata. Rollback is safe.

**Negative / costs**

- Provisioning state machines are complex (7 states per department, 4 per membership) — reconciler must be bulletproof and every edge case needs explicit e2e tests.
- Two-layer enforcement (orchestrator policy + NC byte masks) must be kept in sync; drift is self-healing via the reconciler, but reconciliation latency (≤5 min) is a governance surface.
- NC group/groupfolder lifecycle (create/archive/delete) is now a Prisma concern, so the DB is a richer source of truth about NC state — schema migrations must be tested against a pinned NC image.
- Search reindexing is not required, but the indexer must emit both old (`__household__`) and new (`__dept_<uuid>__`) sentinel forms during rollout, and stale cache entries using old IDs must be tolerated.
- Factory-reset/reflash must be verified on the .87 box — the Prisma+NC state machine is only validated if actual kit behavior is tested (T16).

---

## Non-goals

- Team-agnostic ACL (i.e., teams inheriting more than manager right from parent) — simplicity; every team member is still explicit.
- Arbitrary-depth hierarchy (e.g., Department → Team → Subteam) — limits the mental model to one level; multi-level is a future decision.
- Bulk member operations (e.g., "copy all members from Dept A to Dept B") — tooling; can be built post-GA via admin panel.
- "Anyone" / anonymous department shares; external-sharing governance — privacy posture stays first-party only.
- Scope-axis enforcement on *files* routes (WARP-481) — the live `exec_only` Scope guards on the people-mutation routes stay; department rows are the only grouping mechanism for **files** in v1.
- Business-role vocabulary migration (household `owner/admin/family/guest/service` enum stays) — separate work, deferred (see ONBOARDING_TEAM_ROLES.md).

---

## Alternatives considered

- **Flat "libraries" instead of department/team hierarchy.** Rejected — introduces friction (every user list must be repeated per library) and limits future team-nesting use cases. One-level nesting is low-complexity and buys the model room to grow.

- **Department IDs as enum values in the Scope pgEnum.** Rejected — requires schema release for every new department; rows are dynamic and require no coordination with deployment.

- **Orchestrator proxies all Nextcloud bytes (removes NC byte-layer backstop).** Rejected — OOM risk on the 7 GB box (live WARP-1212 precedent), NC `oc_filecache` write serialization kills throughput, and forfeits the byte-layer defense-in-depth of ADR-013. Its best ideas (search cache versioning via `aclVersion`, UUID sentinels, metadata gates) were grafted as survivals.

- **Redis ACL cache with per-key invalidation.** Rejected — adds staleness window (the 5-min SearchUserIds precedent shows how invalidation gets missed); Prisma membership lookups are fast enough and carry zero staleness.

- **NC-group-first enforcement (orchestrator delegates to NC masks).** Rejected — makes NC admin UI a live management surface (ADR-013 violation), permits invalid state lattices (three free booleans per member), and creates hard-to-verify state. Selected angle's "write-only projection" framing survived as a graft.

- **Admin personal-home access in v1.** Overruled by D-1 (founder approved) to D-1 (founder approved) — contradicts the chat-privacy precedent and the specced admin matrix, but company owns the data (Google Workspace model). Gated to `owner` role, read-only, per-access audited, severable (T19b).

---

## References

(Line numbers and references were re-verified against `origin/main` HEAD `076101c7`, 2026-07-12, and the source brief cited in the body: `TEAMS-DEPARTMENTS-FILES-ARCHITECTURE-BRIEF.md` sections §2–8, §10–11. The earlier pin `28ad8afb` carried several off-by-region citations and a false "Scope axis is dead" premise; both are corrected here.)

- **Brief source material:** `TEAMS-DEPARTMENTS-FILES-ARCHITECTURE-BRIEF.md` at brief filing date (2026-07-11); sections 2 (data model with Prisma + parentId/TEAM), 3 (enforcement + bypass-path table), 4 (provisioning lifecycle), 5 (usage settings), 7 (migration), 8 (security checklist), 10 (open decisions D-1..D-8 + founder resolutions), 11 (ticket breakdown).

- **Related ADRs:** ADR-002 (home/small-team persona), ADR-004 (RBAC per-route guards, `requireRole`/`requireScope` wiring), ADR-007 (dual-workspace personal/household), ADR-013 (built-in directory is identity source; Nextcloud is write-only projection), ADR-027 (Files SharePoint-parity, WS-1..WS-5 baseline).

- **Blocking prerequisites:** WARP-449 (unguarded routes audit + fixes), WARP-1051 (invite-admin gets owner session).

- **Related ground-truth code (main @ `076101c7`):**
  - `apps/orchestrator/src/middleware/auth.ts:655` — `requireRole` definition (per-route guard precedent, WARP-171)
  - **Scope axis is LIVE (§Context correction):**
    - `apps/orchestrator/src/middleware/scope.ts:86` — `requireScope(resource, loadUserScopes)` definition (WARP-455)
    - `apps/orchestrator/src/routes/people.ts:345,464,552` — `requireScope("exec_only", loadUserScopes)` guarding `PATCH /api/people/:id/role`, `PATCH /api/people/:id/scope`, and `DELETE /api/people/:id`
    - `apps/orchestrator/src/app.ts:365` — `app.use("/api", createPeopleRouter(prisma, loadUserEffectiveScopes))` mounts those three routes (live production surface)
    - `apps/orchestrator/src/services/scope-loader.service.ts:78` — `loadUserEffectiveScopes` reads `ScopeBinding` rows
    - `apps/orchestrator/src/routes/people.ts:504,507` — `PATCH /api/people/:id/scope` writes `ScopeBinding` (`deleteMany` + `createMany` in-tx)
  - `apps/orchestrator/src/routes/files.ts:109` — `getUser(req)` returns `req.user.username`; §2.1 enforces use of `req.user.id` for all FK/authz
  - `apps/orchestrator/src/routes/files.ts:659-669` — FileCitation IDOR scope filter pattern (privileged → `{ filePath }`, else `{ filePath, userId: req.user.id }` — id, not username)
  - `apps/orchestrator/src/routes/files.ts:125-165` — space routing precedent (WS-5 households: `resolveSpace`/`rootForSpace`)
  - `apps/orchestrator/src/services/nextcloud.client.ts:1270` — `ncCreateShareV2` (admin, shareType/shareWith wiring)
  - `apps/orchestrator/prisma/schema.prisma:1948-1981` — `File` scope-registry (zero Prisma-client usage; repurposed for `departmentId`, per §1)
  - `apps/orchestrator/src/routes/files.ts:300-336` — `householdSearchUserIds` (WebDAV probe + 300 s Redis cache staleness anti-pattern, replaced by `deptSearchCorpora`, per §2.2)
  - `docker/nextcloud-init.sh:29-88` — Household groupfolder seeding (adopted zero-mutation, per §6)
  - `docs/ADR-013-builtin-directory-vs-nextcloud.md` — "write-only projection" model
  - `docs/ADR-021-container-resource-limits.md` — RAM budget (32 GB reference box per ADR-027 Amendment)

- **Jira epic:** WARP-1251 (teams/departments/files); blocking prerequisites WARP-449, WARP-1051; relates to WARP-878 (Files epic), WARP-1245 (absorbed into `manager` right), WARP-481 (extend Scope enforcement to *files* routes; proposed closed as superseded-for-files — the live `exec_only` people-route Scope guards stay), WARP-455 (Scope axis + `File` registry; the `File` model is repurposed, the live `requireScope` guards are untouched).

---

## Decisions (D-1..D-8) — Resolved

| # | Decision | Resolution |
|---|---|---|
| D-1 | Admin access to **personal** homes (tier 2) | ✅ **APPROVED 2026-07-11: SHIP, owner (super-admin) only.** Company owns the data (Google Workspace model). Read-only, NC admin credential, per-access audited (per listing **and per download**). WARP-1272 un-gated, scheduled after T16. |
| D-2 | Surface route: grow `/users` vs `/people` rename first | Grow `/users`; rename stays its own ticket. |
| D-3 | Vocabulary: "Departments" vs "Teams" | ✅ **APPROVED 2026-07-11: BOTH — teams nest inside departments** (one level). See Amendment above. `DepartmentKind::TEAM` + self-referential `parentId`. |
| D-4 | Role-chip tokens | Neutral `dp-status-chip` now; don't block on the `--role-*` ramp drift. |
| D-5 | Household rights convergence timing | Post-GA (avoids NC-mutation risk on the home persona's happy path). |
| D-6 | Dept co-editing GA posture | Pending WARP-882 verification (T2); if the doc server isn't real, honest disabled state. |
| D-7 | LLM daily cap in v1 | Defer; storage quota + upload cap satisfy the usage-settings ask with less new enforcement surface. |
| D-8 | WARP-1245 disposition | Absorb into this epic (`manager` right implements it); link, don't re-file. |
