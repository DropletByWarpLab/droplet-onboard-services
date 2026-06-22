# ADR-027 implementation blueprint

Developer-ready companion to ADR-027. Per workstream: backend files+signatures, Prisma + migration, frontend, infra, failing-tests-first, effort. All paths absolute under `C:/Users/stefa/OneDrive/Documents/GitHub/droplet-wt-files-sharepoint/`. Worktree note: this is branch `docs/adr-027-files-sharepoint-parity` @ `fcd706e6`, **not** a clean `origin/main` checkout — rebase before opening PRs.

**Two corrections from adversarial verification are load-bearing — apply them verbatim:**
1. **WS-3 IDOR identifier:** write *and* read the comment owner column with `req.user.id` (the local User UUID), never `getUser(req)` (which returns `req.user.username`). This is how `FileCitation` works on both sides (`llm.ts:748-759` write, `files.ts:217` read). Using `getUser(req)` for the owner column is a correctness bug.
2. **WS-1 self-exclusion:** `getUser(req)` returns the local username, not `nextcloudUsername`. Resolve the caller's own `nextcloudUsername` from the local `User` row (keyed on `req.user.id`) and compare case-insensitively.

---

## WS-1 — Internal user/group sharing UI · Effort: M

### Backend
- **New route** in `apps/orchestrator/src/routes/files.ts` (inside `createFilesRouter`, after the `GET /files/shared-with-me` block):
  `GET /api/files/share-recipients`, guard `requireRole("owner","admin","family")`. Read the **local Prisma `User` table** (ADR-013), not OCS.
  ```ts
  // Resolve the caller's OWN nextcloudUsername (NOT getUser(req), which is username).
  const meRow = await prisma.user.findUnique({
    where: { id: (req as { user?: { id?: string } }).user?.id ?? "__none__" },
    select: { nextcloudUsername: true },
  });
  const meNc = (meRow?.nextcloudUsername ?? "").toLowerCase();
  const systemUser = (process.env.NEXTCLOUD_ADMIN_USER || "admin").toLowerCase();
  const rows = await prisma.user.findMany({
    where: { nextcloudUsername: { not: null }, isLocal: true },
    select: { displayName: true, nextcloudUsername: true, email: true },
    orderBy: { displayName: "asc" },
  });
  const recipients = rows
    .filter(u => u.nextcloudUsername!.toLowerCase() !== systemUser
              && u.nextcloudUsername!.toLowerCase() !== meNc)   // case-insensitive self-exclude
    .map(u => ({ shareWith: u.nextcloudUsername!, displayName: u.displayName, email: u.email ?? null }));
  res.json({ recipients });
  ```
  Returns `{ recipients: Array<{ shareWith, displayName, email|null }> }`. `shareWith` is the **`nextcloudUsername`** (OCS user id), not `id`/`username`.
- **Add the route to `apps/orchestrator/src/__tests__/rbac.test.ts`** allowlist matrix.
- **Do NOT modify** `POST/PUT/DELETE /files/share`, `ncCreateShareV2`, `ncUpdateShare`, `ncDeleteShare`, or `GET /auth/users` — share create/update/delete/list is done.
- **No Prisma model, no migration** (reads existing `User`; all share state is OCS-owned).

### Frontend
- `apps/web-dashboard/src/lib/api.ts`: add `ShareRecipient` + `fetchShareRecipients()` (GET `/api/files/share-recipients`). No change to `createShare` (already takes `shareType`+`shareWith`). Mirror `ShareRecipient` into `types.ts`.
- `apps/web-dashboard/src/components/FileManager/ShareDialog.tsx` (the bulk):
  - Add `mode: "person" | "link"` state (default `"person"`). `handleCreate` (currently hardcodes `shareType:3` at L80): branch `person → createShare(path,{shareType:0, shareWith, permissions})`, `link → shareType:3` unchanged.
  - Member picker (combobox of `displayName`/`email`) populated by `fetchShareRecipients()`; loading/empty/error states (empty = "No other household members yet", not an error).
  - Reuse the existing permission preset buttons (L240-253) as the permission toggles.
  - Existing-shares list: branch on `share.shareType` — `0` renders a person chip (`shareWithDisplayName ?? shareWith`, no copy-link, `url:null`), `3` keeps the copy-link row.
  - **Add `User`/`Users` to the lucide import** (L4-14 currently lacks them — do not assume they're imported).
- Reuse existing `handleUpdatePermissions`/`performRevoke` (operate by `share.id`, type-agnostic).
- Design tokens: indigo `#6366F1` + bento, existing `dp-*`/`type-*` classes only (cross-viewport UI-cohesion RULE).

### Infra
None. `nextcloud:29-apache` is core (no `profiles:`); `files_sharing` OCS app already enabled. No nginx, no `.env`, no migration.

### Failing-tests-first
Backend (`apps/orchestrator/src/routes/__tests__/files.share-recipients.test.ts`): (1) `family` gets 200 + roster (not 403 — the core fix); (2) self excluded **by nextcloudUsername, case-insensitively**; (3) system admin excluded; (4) `nextcloudUsername:null` rows excluded; (5) `shareWith` is `nextcloudUsername`, not `id`/`username`; (6) no-role → 403. Extend share-route test: `POST /files/share {shareType:0,shareWith,permissions}` forwards `shareWith` to `ncCreateShareV2`.
Frontend (`ShareDialog.test.tsx`): (7) defaults to Person, loads recipients; (8) create sends `{shareType:0, shareWith, permissions:3}`; (9) person share renders without copy-link; (10) Link mode still `shareType:3`; (11) empty roster → friendly empty-state; (12) Create disabled with no recipient.

---

## WS-2 — Full-text keyword content search · Effort: S–M

### Backend
- `apps/orchestrator/src/routes/files.ts`, extend `GET /api/files/search/content` (:1097). **No `requireRole`** (ADR-004 §3 GET rule); per-user isolation via `userId`.
  - Parse `mode = (req.query.mode||"semantic")`; reject non-`{semantic,keyword,hybrid}` with 400.
  - Cache key → `filesearch:${mode}:${user}:${q}:${limit}`, keep 60s TTL.
  - `keyword` branch **before** the gRPC embed block (:1121): `import("../services/file-search.service.js")` → `searchByLexical(prisma,{userId, query:q, limit:limit*CHUNKS_PER_FILE_FACTOR, source:"nextcloud"})` → `dedupeHitsPerFile` → return. Never calls `isGrpcAvailable`/`grpcEmbedText` → survives gateway-down.
  - `hybrid` branch after embed succeeds: `searchHybrid(prisma,{userId, vector:embedVec, query:q, limit:…, source:"nextcloud"})` (no `rerank` pipe → low latency, gateway-light).
  - `semantic`/omitted = the existing inline `DISTINCT ON ("ncFileId")` SQL, unchanged (zero-risk default).
  - Helpers: `CHUNKS_PER_FILE_FACTOR = 5`; `dedupeHitsPerFile(hits, limit)` keeps best chunk per `path` (service returns score DESC, so first-seen = best), maps `snippet → text`. Output `{path,score,text}` == existing `SemanticSearchResult` shape (frontend render path unchanged).
  - Reuse the existing `catch` (maps pgvector/"does not exist" → 503).
- **No Prisma model, no migration** — `text_tsv` (`schema.prisma:754`), GIN index, lexical index all exist (migration `20260511015837`). **Do not** propose a schema change.
- Optional (non-MVP): add `keywordReady` to `/files/search/status` so the UI shows keyword available when `gatewayHealthy === false`. (Note: the status probe validates table-readiness, not the FTS path — acceptable for the pill.)

### Frontend
- `apps/web-dashboard/src/lib/api.ts`: `searchFileContent(query, limit=20, mode: FileSearchMode = "semantic")` adds `&mode=`; keep 503→`[]` graceful degrade. `SemanticSearchResult` reused.
- `apps/web-dashboard/src/components/FileManager/SearchBar.tsx`: replace boolean `semantic` (L44) with `mode: "filename"|"keyword"|"semantic"`. `filename → useFileSearch`; `keyword`/`semantic → searchFileContent(q,20,mode)` in the existing 500ms-debounced effect. 3-segment control reusing existing token classes. **Add `FileText`/`Type` to the lucide import** (L4 = `Search,X,Loader2,Sparkles` only). Keyword empty/error reuse existing copy. Suppress (or green-via-`keywordReady`) the readiness pill in keyword mode.
- `useFileSearch.ts` unchanged.

### Infra
None — `db` is already `pgvector/pgvector:pg16`; tsvector/GIN are core; route already exists.

### Failing-tests-first
Backend (`apps/orchestrator/src/__tests__/files-search-content.test.ts`, model on `__tests__/files-knowledge.test.ts` supertest harness — but **mock `ai-gateway.grpc-client.js`**, the module the route embeds through, NOT `embedding.client.js`): (1) `keyword` calls `searchByLexical` and never the gRPC embed; (2) `keyword` returns 200 with `isGrpcAvailable→false` while `semantic` returns 503; (3) `hybrid` embeds once then calls `searchHybrid {…source:"nextcloud"}`; (4) `semantic`/omitted runs inline pgvector SQL (regression lock); (5) `mode=foo` → 400; (6) per-file dedupe (3 chunks/2 paths → 2 results); (7) cache-key isolation keyword vs semantic; (8) `userId` forwarded (IDOR). Skip the proposed `file-search.service.test.ts` assertion — `websearch_to_tsquery` (:121) and the source predicate (:139) are **already covered**.
Frontend (`SearchBar.mode-toggle.test.tsx`): toggling keyword/semantic calls `searchFileContent` with the right 3rd arg; filename uses `useFileSearch`; keyword renders snippet+score; empty/error states.

---

## WS-3 — Droplet-native comments + tags · Effort: M

### Backend
- **Prisma** (`apps/orchestrator/prisma/schema.prisma`, after `FileCitation` @ :2387):
  ```prisma
  model FileComment {
    id           String   @id @default(uuid())
    ncFileId     Int      // oc:fileid; resolve via ncGetFileId
    authorUserId String   // ⚠ store req.user.id (UUID), NOT getUser(req)/username
    body         String
    createdAt    DateTime @default(now())
    updatedAt    DateTime @updatedAt
    @@index([ncFileId, createdAt(sort: Desc)])
    @@index([authorUserId])
  }
  model FileTag {
    id            String   @id @default(uuid())
    ncFileId      Int
    label         String
    addedByUserId String   // req.user.id (UUID)
    createdAt     DateTime @default(now())
    @@unique([ncFileId, label])
    @@index([ncFileId])
    @@index([addedByUserId])
  }
  ```
- **Migration** `apps/orchestrator/prisma/migrations/<ts>_ws3_file_comments_tags/migration.sql` — additive `CREATE TABLE`/`CREATE [UNIQUE] INDEX` only; no backfill, no enums (so no enum idiom needed). Generate via `npx prisma migrate dev` from `apps/orchestrator`.
- **Routes** in `files.ts` (`createFilesRouter`, all `requireRole("owner","admin","family")`):
  - Shared helper `resolveFileIdOr404(req,res,filePath)` → `ncGetFileId(getToken(req), getUser(req), normalizedPath)` (3-arg; `null` → 404), mirroring versions route (:819-823).
  - **IDOR identity (corrected):** `requesterId(req) = req.user.id`. Write `authorUserId: req.user.id` on create; scope reads/deletes with `isPrivileged ? {ncFileId} : {ncFileId, authorUserId: req.user.id}`. **Do NOT use `getUser(req)` for `authorUserId`.**
  - `GET /files/:filePath(*)/comments` (scoped), `POST …/comments` (`z.object({body:z.string().min(1).max(4000)})`, MQTT `safePublish`), `DELETE /files/comments/:id` (author-or-privileged; author check is `row.authorUserId === req.user.id`). **Register the literal `/files/comments/:id` DELETE near the other literal `/files/...` routes** (harmless ordering discipline; the `(*)` wildcard requires a trailing `/comments` so it won't actually shadow it).
  - `GET /files/:filePath(*)/tags` (**file-scoped, not user-scoped** — all readers see all tags), `POST …/tags` (upsert on `@@unique(ncFileId,label)`, `addedByUserId: req.user.id`), `DELETE …/tags/:label`.
- **No caching** (immediate-consistency; user-visible staleness otherwise).

### Frontend
- Hooks `apps/web-dashboard/src/lib/hooks/useFileComments.ts` + `useFileTags.ts`. **Note:** `useShares.ts` is a read-only SWR hook with no mutators/optimistic logic — there is no in-repo optimistic-mutation precedent to clone; hand-roll add/delete + optimistic rollback (budget for it; the "M" estimate assumed a precedent that doesn't exist).
- Components `apps/web-dashboard/src/components/FileManager/CommentsPanel.tsx` (sibling of `VersionHistoryPanel.tsx`) + `TagChips.tsx`.
- **Wiring premise corrected:** `PreviewPane.tsx` does NOT mount StarButton/ShareDialog/VersionHistoryPanel — it imports only `ReindexButton`+lucide. Those controls live in `app/files/page.tsx`, `FileRow.tsx`, `FileListSimple.tsx`. Re-identify the integration point: either mount `CommentsPanel`/`TagChips` in `PreviewPane` as net-new sections (no existing siblings to slot beside) or in `app/files/page.tsx` next to the existing `VersionHistoryPanel`/`ShareDialog` mounts. Account for this in effort.
- Realtime: `comment-added` flows through `useFileRealtime.ts`, which does a **blanket `/api/files` prefix SWR invalidation** (not a targeted per-file refetch) — adequate, but don't describe it as targeted.
- Empty/loading/error/guest states; indigo+bento tokens (UI-cohesion RULE).

### Infra
None — tables in existing `db`; routes under proxied `/api`; deploys via existing `migrate deploy`.

### Failing-tests-first
`apps/orchestrator/src/__tests__/file-metadata.test.ts` — **build a fresh FileComment/FileTag Prisma mock that actually honors `authorUserId`/`ncFileId` filtering**; do NOT clone `file-citation.test.ts`'s mock (its `fileCitation.findMany` ignores `userId`, and there is no existing citations IDOR-scoping test to mirror). (1) POST→GET round-trip; (2) empty body→400; (3) unknown path→404; (4) **IDOR: `family` sees only its own rows keyed on `req.user.id`, owner sees all** (the corrected-identifier test — assert the stored `authorUserId` equals the requester's UUID, and that the same UUID filters the read); (5) delete own→204 / other's as family→403 / as owner→204; (6) guest→403; (7) tag POST→GET alpha; (8) duplicate label upsert (single row, unchanged addedBy/createdAt); (9) tag DELETE→204; (10) empty/>64-char label→400; (11) tags file-scoped (family sees another user's tag); (12) `/files/comments/:id` routes to comment-delete. Frontend `CommentsPanel.test.tsx`/`TagChips.test.tsx`: empty-state, optimistic add, own-vs-others delete visibility, duplicate no-op.

---

## WS-4 — In-browser editing + co-authoring · Effort: L · GATED on Stefan+Romain sign-off

**Do not start coding until the engine + license decision is signed off** (Alternatives in the ADR). Contract is engine-agnostic (OnlyOffice & Collabora both speak WOPI); the human decision changes `DOCS_*` config, not code.

### Backend
- New service `apps/orchestrator/src/services/docserver.client.ts`: `ncMintEditorSession(token, ncUser, filePath, requestedMode) → DocEditorSession{editorUrl, accessToken, accessTokenTtl, ncFileId, mode}`, `docServerHealthy()`, `DocServerUnavailableError`. Reuse `resolveNcToken` (`nextcloud-session.service.ts:115`); resolve id via **`ncGetFileId(token, ncUser, filePath)` — 3 args** (the spec draft's 2-arg call would not compile).
- `apps/orchestrator/src/config.ts`: `DOCS_INTERNAL_URL` (default empty → unavailable), `DOCS_ENABLED` (explicit boolean, never derived from URL emptiness).
- Routes in `files.ts`: `GET /files/:filePath(*)/editor-session` (`requireRole("owner","admin","family")`; **server-side** edit-vs-view: `edit` only if owner OR shared with NC permission bit 2 via `ncListSharedWithMe`); `GET /files/docs/status` (10s-cached `{state, engine}`). Error mapping: `MissingNcTokenError→401`, `DocServerUnavailableError→503`. Add to `rbac.test.ts` matrix.
- **Prisma** `FileEditSession` + enums `FileEditSessionMode`/`FileEditSessionStatus` (explicit `status` column, not NULL-derived) keyed on `ncFileId`.
- **Migration** must use the verified idempotent enum idiom: `DO $$ BEGIN CREATE TYPE … EXCEPTION WHEN duplicate_object THEN null; END $$;` (per `20260428000000_brain_memory`). **`CREATE TYPE … IF NOT EXISTS` is invalid Postgres** — the spec draft's cited form and "scene_schedule has the enum template" claim are both wrong (scene_schedule has no enum).

### Frontend
- `apps/web-dashboard/src/components/FileManager/DocEditorPanel.tsx` (new; Droplet-chrome iframe + WOPI token refresh + PostMessage; states ready/disabled/unavailable/read-only/loading).
- Touch `PreviewPane.tsx` (gated "Edit" button — only when `/files/docs/status === ready` AND editable MIME; no dead buttons) and `app/files/page.tsx` (mount `DocEditorPanel` next to existing `VersionHistoryPanel`/`ShareDialog`).

### Infra (the only WS that touches infra)
- `docker/docker-compose.yml`: new `docserver` service mirroring the `nextcloud` block (default network, **no `ports:`**, `env_file ../.env`, `restart: always`, `<<: *default-logging`) PLUS `profiles: ["docs"]` and the **mandatory** resource trio `mem_limit: ${DOCS_MEM_LIMIT:-2g}` / `cpus: ${DOCS_CPUS:-2.0}` / `pids_limit: ${DOCS_PIDS_LIMIT:-1024}`. **No `deploy.resources`** — would fail Test 14/WARP-569 (`scripts/test-security.sh:497-532`), which iterates all services regardless of profile.
- `docker/nginx.conf`: new `location /docs/` modeled on `/nextcloud/` (:107-118) but **adding** `proxy_set_header Upgrade $http_upgrade;` + `Connection $connection_upgrade;` (the `/nextcloud/` block omits them; co-authoring WS won't upgrade otherwise). Reuse the `$connection_upgrade` map (:22-26) + resolver (:20).
- `.env.example`: add `docs` to the documented `COMPOSE_PROFILES` block (:329-357). Do NOT add `DOCS_MEM_LIMIT` as a key (`.env.example` has zero `_MEM_LIMIT` lines).
- `docs/ENVIRONMENT.md` (load-bearing registration) + `CLAUDE.md` env table + `docs/ADR-021`: add `DOCS_*` rows and a `docs`-profile section (docserver 2 GB, additive).

### Failing-tests-first
`files-editor-session.test.ts`: edit-session for owner→`mode:"edit"`; read-only share→`mode:"view"`; guest→403; no token→401; not-enabled→503; MCP principal via headers; writes `FileEditSession{status:"active"}`; `/files/docs/status` three cases. `rbac.test.ts`: editor-session row. Migration idempotency (apply twice, enums via duplicate_object idiom). `test-security.sh` Test 14 still green with `docserver`'s `mem_limit`; deliberate-omission FAILs. `DocEditorPanel.test.tsx`: disabled/unavailable/ready/read-only states; Edit button absent unless ready+editable MIME.

---

## Recommended build SEQUENCE

1. **WS-2 first (S–M, zero infra, zero schema).** Lowest risk — pure wiring + one toggle over already-shipped, already-tested code. Ship to validate the search UX and the `mode`-param/cache pattern.
2. **WS-1 (M, one read route + ShareDialog refactor).** No dependency on WS-2; gated only by the **member-enumeration RBAC policy sign-off** (Romain). Can run in parallel with WS-2 (different files; minor `api.ts`/`types.ts` overlap).
3. **WS-3 (M, two tables + ~6 routes + 2 components).** Depends on nothing in WS-1/WS-2; independent migration. Apply the IDOR-UUID correction and re-identify the frontend mount point before estimating. Can run in parallel once a developer is free.
4. **WS-4 last (L, the only infra workstream) — HELD until Stefan + Romain sign off** the engine (OnlyOffice vs Collabora) and license posture. It has hard external dependencies (engine image, OEM license, real-hardware RAM validation of `DOCS_MEM_LIMIT`) and the largest surface (container + nginx WS proxy + 4-file env/docs registration + broker + model/migration + live co-authoring frontend). Begin only after the gate clears; it benefits from WS-1's share-permission-bit plumbing being live (edit-vs-view decision reads NC permission bit 2).

**Cross-WS shared touch points to coordinate (avoid merge conflicts):** all four add routes to `apps/orchestrator/src/routes/files.ts` and entries to `apps/web-dashboard/src/lib/api.ts`/`types.ts`; WS-1 and WS-4 both touch `rbac.test.ts`. Land sequentially or rebase carefully.


---

## SharePoint document-library vs Droplet Files — capability parity matrix

Legend: ✅ shipped/at parity · 🟡 partial · ❌ absent · 🚫 deliberate non-goal. "After WS-n" = state once that workstream merges.

| SharePoint capability (daily essential unless noted) | Droplet today (main @ fcd706e6) | After WS-1 | After WS-2 | After WS-3 | After WS-4 |
|---|---|---|---|---|---|
| Sharing — named people, edit vs view | 🟡 backend done (`ncCreateShareV2` shareType:0); UI is public-link-only | ✅ member picker + permission toggles | ✅ | ✅ | ✅ |
| Stop sharing / change permissions | ✅ (`PUT/DELETE /files/share/:id`, by id) | ✅ (renders user shares distinctly) | ✅ | ✅ | ✅ |
| Sharing — groups | ❌ no OCS group-name source (`ncListGroups` absent) | 🚫 out of scope (UI built to add later) | 🚫 | 🚫 | 🚫 |
| Search — full-text content (keyword) | ❌ Files surface is semantic/pgvector-only; lexical engine exists but unwired | ❌ | ✅ keyword mode (works gateway-down) | ✅ | ✅ |
| Search — semantic/AI content | ✅ (`/files/search/content`, pgvector) | ✅ | ✅ + hybrid (RRF) | ✅ | ✅ |
| Search — refiners/filters | ❌ (lexical service supports since/filename filters, not surfaced) | ❌ | 🟡 facets wireable as fast-follow | 🟡 | 🟡 |
| Comments in documents | ❌ | ❌ | ❌ | ✅ per-file comments (Droplet-native, ncFileId-keyed) | ✅ |
| Comments — @mention email fan-out | ❌ | ❌ | ❌ | 🚫 non-goal (no notification subsystem) | 🚫 |
| Metadata — light tagging/columns | ❌ | ❌ | ❌ | ✅ FileTag chips (shared file metadata) | ✅ |
| Managed metadata / term store, content types | ❌ | 🚫 | 🚫 | 🚫 non-goal | 🚫 |
| Version history + restore | ✅ (versions list + restore by ncFileId) | ✅ | ✅ | ✅ | ✅ |
| Recycle bin (user-recoverable) | 🟡 Nextcloud trash exists; not surfaced as a SharePoint-style bin | 🟡 | 🟡 | 🟡 | 🟡 (out of ADR-027 scope) |
| Real-time co-authoring | ❌ download → desktop Office → re-upload | ❌ | ❌ | ❌ | ✅ live co-authoring (profile-gated `docs`) |
| AutoSave to cloud | ❌ | ❌ | ❌ | ❌ | ✅ (engine autosaves to WebDAV) |
| In-browser editing of .docx/.xlsx/.pptx | ❌ | ❌ | ❌ | ❌ | ✅ (`DocEditorPanel`, profile-gated) |
| Check-out / check-in locking | ❌ | 🚫 | 🚫 | 🚫 | 🚫 non-goal (breaks co-authoring) |
| File-level activity view | 🟡 global `ActivityRow` audit log exists, not per-file in Files UI | 🟡 | 🟡 | 🟡 (comments add a per-file trail) | 🟡 (edit-session provenance) |
| Sync to desktop / "Add shortcut" / offline | ✅ Nextcloud WebDAV sync clients | ✅ | ✅ | ✅ | ✅ |
| Mobile access | ✅ (droplet-android/ios + WebDAV) | ✅ | ✅ | ✅ | ✅ |
| Anonymous "Anyone" links, expiry/password link policy | 🟡 public link + expiry/password exist | 🚫 external-sharing governance non-goal | 🚫 | 🚫 | 🚫 |
| Power Automate / Rules notifications | ❌ | 🚫 non-goal | 🚫 | 🚫 | 🚫 |

**Reading the matrix:** WS-1/WS-2/WS-3 close the named-sharing, content-search, and comments/tags gaps with **zero new infrastructure**. WS-4 closes the defining co-authoring/AutoSave/in-browser-edit gap but is the only workstream needing a new container and is RAM- and license-gated. The enterprise column (groups, term store, content types, check-out, external-sharing governance, Power Automate) is intentionally 🚫 — those are what make SharePoint feel "enterprise," not what makes file collaboration feel good for a household/small team (ADR-002 persona).
