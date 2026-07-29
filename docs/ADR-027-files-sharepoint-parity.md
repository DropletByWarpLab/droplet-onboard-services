# ADR-027 — Files: SharePoint-parity for the document experience

- **Status:** proposed
- **Date:** 2026-06-22
- **Ticket:** TBD (epic; one WARP-NNN per workstream)
- **Deciders:** Stefan, Romain (WS-4 engine/license sign-off required before code)
- **Supersedes / relates:** ADR-002 (home/small-team persona), ADR-004 (RBAC per-route guards), ADR-007 (dual-workspace personal/household), ADR-011 (hardware-agnostic), ADR-013 (built-in directory is identity source of truth; Nextcloud demoted to downstream WebDAV), ADR-021 (container resource limits), ADR-023 (per-device FQDN/TLS)
- **Companion:** [ADR-027b — implementation blueprint](ADR-027b-implementation-blueprint.md) (renamed from a duplicate "ADR-027" filename, WARP-1563)

## Amendment — 2026-06-22 (Stefan: 32 GB box + private/shared spaces + co-working for all)

Three directional changes after the original draft, on Stefan's call:

1. **Target box has 32 GB RAM, not the ~7 GB single-box figure ADR-021 budgets against.** This **removes the WS-4 RAM gate**: a ~1.5–2 GB document server fits with full headroom alongside the default profile + Ollama. The `docs` Compose profile is **retained as a knob** so genuinely small boxes can stay editor-free, but on the 32 GB reference box it is **enabled by default**. The "WS-4 RAM provisioning" and "DOCS_MEM_LIMIT below the engine floor" sign-off items are **resolved** — at 32 GB even OnlyOffice's higher (~2–4 GB) floor is comfortable. The licensing sign-off (below) is the only WS-4 gate that remains.

2. **WS-4 engine decided: OnlyOffice Document Server.** Best `.docx/.xlsx/.pptx` fidelity (the truest "feels like Microsoft Office"), and — decisively for "we want *all* users co-working" — **no hard co-authoring connection cap**, unlike Collabora CODE's free-edition ~10-document / 20-connection limit which would bottleneck a busy household/team. The integration stays **engine-agnostic via WOPI**, so the choice changes `DOCS_*` config, not code. **Remaining gate (purchasing, not engineering):** OnlyOffice CE is **AGPLv3** — build and test on CE now, but acquire an **OnlyOffice OEM/commercial license before GA** since the appliance is *conveyed* to customers. This is kept off the code critical path.

3. **New workstream WS-5 — "My Files" (private) + "Shared / Household" (collaborative) spaces.** Ground-truth audit confirmed Droplet **already gives every user a private folder**: each user is provisioned their own Nextcloud account with a private WebDAV home at invite-accept (`ncCreateUser` per user; per-user app-password keyed by local `User.id`). What is missing is a **shared collaborative space** — there is no group folder or common area today (collaboration is per-file shares only). WS-5 surfaces a **two-space Files experience** (the OneDrive + SharePoint model): *My Files* = the user's existing private home; *Shared* = a household-wide library backed by the Nextcloud **`groupfolders`** app (admin-owned group folder bound to the household group, with per-subfolder ACLs — the true SharePoint *document-library* analogue), plus a space switcher in the Files UI and orchestrator routing that targets the right WebDAV root per space. Co-authoring (WS-4), comments/tags (WS-3), search (WS-2) and sharing (WS-1) all apply in **both** spaces. See WS-5 below.

## Context

The Droplet Files surface (Nextcloud WebDAV behind the orchestrator) already gives a household browse / upload / download / preview / version-history / public-link experience. It does **not** yet feel like the daily SharePoint document-library experience users expect: sharing a file with a *named* household member, full-text search of file *contents*, in-document comments and lightweight tagging, and — the big one — opening an Office file in the browser and co-authoring it live instead of download → desktop-Office → re-upload.

An authoritative SharePoint Online document-library capability inventory (see References) separates the **daily essentials** (co-authoring + AutoSave, version history + restore, recycle bin, named-people sharing + revoke, full-text content search, in-document comments + per-file activity, sync/offline/mobile, light metadata tags) from the **enterprise extras** a privacy-first appliance should deliberately *not* chase (anonymous/"Anyone" links + external-sharing governance, content types, managed-metadata term store, forced check-out/check-in, Power Automate flows). This ADR targets the daily essentials that the Files surface is missing, and explicitly inherits SharePoint's "enterprise" surface as non-goals.

A read-only ground-truth audit of the codebase (worktree on branch `docs/adr-027-files-sharepoint-parity`, HEAD `fcd706e6` — **not** a bare `origin/main` checkout) established that three of the four workstreams require **no new container and no new infrastructure**: the share backend, the Postgres FTS column + lexical/hybrid search engine, and the Droplet-native metadata table pattern all already exist on main. Only the in-browser editor needs a new container, and it is heavy enough to require a RAM-budget gate.

## Decision

Ship SharePoint document-experience parity for Files in **four workstreams**, three of which add zero infrastructure and one of which is profile-gated and sign-off-blocked.

### WS-1 — Internal user/group sharing UI
The orchestrator share backend **already supports named-member sharing end-to-end**: `ncCreateShareV2` (`nextcloud.client.ts:1207`) accepts `shareType:0` + `shareWith`, and `POST /files/share` / `PUT|DELETE /files/share/:id` (`files.ts:448/1011/1063`) are wired and `requireRole("owner","admin","family")`-guarded. The only true gaps are (a) the dashboard `ShareDialog` is hardcoded to `shareType:3` public links with no member picker, and (b) a **non-admin-safe roster route**, because `GET /auth/users` → `ncListUsers` hits the admin-only OCS `/cloud/users/details` and 403s for `family`. WS-1 adds a member picker + permission toggles to `ShareDialog` and one new read route, `GET /api/files/share-recipients`, sourced from the **local Prisma `User` table** (ADR-013 identity source of truth) rather than OCS. **No new container, no schema change.** Group sharing (`shareType:1`) is out of scope — no OCS group-name enumeration source exists (`ncListGroups`/`/cloud/groups` absent); a *local* `Group`/`GroupMembership` model exists but does not carry OCS group ids, so it cannot drive `shareType:1`.

### WS-2 — Full-text keyword content search
Postgres-native FTS is **already built on main under WARP-286**: `FileContentChunk.text_tsv tsvector GENERATED ALWAYS AS … STORED` + GIN index (migration `20260511015837_add_chunk_tsvector_index`), `searchByLexical` (`websearch_to_tsquery('english',…)` + `ts_rank_cd`, `file-search.service.ts:161`) and `searchHybrid` (RRF fusion, `:475`). The engine is wired only to `/knowledge` and the LLM tool path today. WS-2 adds a `mode` param (`semantic`|`keyword`|`hybrid`) to `GET /api/files/search/content` (`files.ts:1097`), delegating keyword/hybrid to the existing service, plus a three-way toggle in the Files `SearchBar`. **Keyword mode deliberately skips the ai-gateway gRPC embed**, so plain content search keeps working when the LLM stack is down — a genuine SharePoint-parity win. The DB image is already `pgvector/pgvector:pg16`; tsvector/GIN are core Postgres. **No Elasticsearch, no new container, no new extension, no migration, no indexer change.**

### WS-3 — Droplet-native file comments + tags/metadata
Add two additive Prisma tables, `FileComment` and `FileTag`, **keyed on Nextcloud's stable `ncFileId` (`oc:fileid`)** so metadata survives rename/move — mirroring `File.ncFileId @unique` / `FileContentChunk.ncFileId`, **not** the path-keyed `FileCitation` (which goes stale on rename). Nextcloud is unaware of this metadata; the orchestrator owns it in the existing `db` Postgres datasource. New `/api/files/:path/comments`, `/api/files/comments/:id`, and `/api/files/:path/tags…` routes resolve `ncFileId` via `ncGetFileId` and borrow the **FileCitation RBAC/IDOR shape**. **Critical correction from the spec draft:** the IDOR owner column must be written and filtered using the **same identifier** that `FileCitation` uses on both sides — `req.user.id` (the local User UUID; use the read filter at `files.ts:217` as the pattern — note: `llm.ts:748-759` has a legacy `?? username` fallback for service principals that WS-3 must NOT replicate). The spec draft wrote `authorUserId = getUser(req)` (which returns `req.user.username`) but filtered/deleted by `req.user.id` — a correctness bug that would make a `family` user see zero of their own comments. **No new container, no infra.**

### WS-4 — In-browser editing + co-authoring (profile-gated, sign-off-blocked)
Add a **self-hosted document server behind a new `docs` Compose profile**, integrated via the Nextcloud connector app + WOPI, brokered by the orchestrator (new `editor-session` route minting a short-lived WOPI token from the per-user NC app-password), embedded in a Droplet-chrome `DocEditorPanel`. This is the **only** workstream that touches infrastructure (new container, new nginx `/docs/` proxy with WebSocket upgrade headers, new `docs` profile + `DOCS_*` env). **Engine = OnlyOffice** and **RAM gate removed at 32 GB** per the 2026-06-22 Amendment; the **only remaining gate is the OnlyOffice OEM/commercial license before GA** (AGPLv3 distribution) — build/test on CE now via the engine-agnostic WOPI contract.

### WS-5 — "My Files" (private) + "Shared / Household" (collaborative) spaces
A two-space Files experience (the OneDrive + SharePoint model):
- **My Files (private)** — the user's existing private Nextcloud home, **already provisioned per user** (`ncCreateUser` at invite-accept; per-user app-password keyed by local `User.id`). No new storage; just surface it as a distinct, labeled space.
- **Shared / Household (collaborative)** — a household-wide library backed by the Nextcloud **`groupfolders`** app: an admin-owned group folder bound to the household group, with per-subfolder ACLs (the true SharePoint *document-library* analogue). No new container — `groupfolders` runs inside the existing `nextcloud` container.
- **Provisioning** — enable `groupfolders` (`occ app:enable groupfolders`) in `nextcloud-init.sh`, create the "Household" group folder bound to the household group, and add members on invite-accept alongside `ncCreateUser`.
- **Routing** — the orchestrator selects the WebDAV root per space (caller's personal NC token for *My Files*; the group-folder path for *Shared*). Browse/upload/share/version/comment/tag/search/edit all operate within the chosen space, so WS-1–WS-4 apply in both.
- **UI** — a space switcher (My Files / Shared) atop the Files surface, aligned with ADR-007's personal-vs-household workspace concept.
- Effort: M–L. No new container; provisioning + space-switcher + per-space root selection across the existing Files routes.

### Key constraint: single-box RAM budget (ADR-021)
> **Superseded by the 2026-06-22 Amendment for the 32 GB reference box.** The figures below reflect the original ~7 GB single-box budget and remain valid for genuinely small boxes (where `docs` stays off). On the 32 GB box, WS-4's doc server runs default-on with full headroom; the `docs` profile is retained only as a small-box knob.

Exact, verified numbers (ADR-021):
- **Box target RAM:** ~7 GB shared (single-box). Host/kernel reserve target ~1 GB.
- **Default-profile total:** **~5.0 GB always-on** (gateway 128 MB, web-dashboard 384 MB, orchestrator 768 MB [res 512 MB], device-identity-svc 128 MB, mcp-server 256 MB, nextcloud 768 MB, db 1,024 MB [res 512 MB], cache 256 MB [res 128 MB], broker 64 MB, ai-gateway 512 MB, file-indexer 512 MB, routing 256 MB). ADR-021 notes this "Leaves ~2 GB for host/kernel/profile-gated heavies."
- **`single-box` additions:** ollama **4 GB** (biggest single consumer) + openwrt **512 MB**.
- **`pm` profile total:** ≈ **3.07 GB** ceilings (postgres-pm 512 + redis-pm 256 + pm-api 768 + pm-worker 512 + pm-migrator 512 + pm-web 384 + pm-health 128). *(Corrected: an earlier draft said "~4.8 GB"; the summed `mem_limit` ceilings are ~3.07 GB. `mem_limit` is a ceiling, not a reservation — only db/cache/orchestrator reserve a floor.)*

WS-1/WS-2/WS-3 add **0 containers and 0 MB** to every profile. WS-4's doc server cannot be default-on: default ~5.0 GB + host ~1 GB ≈ 6 GB leaves ~1 GB of practical headroom on a 7 GB box, so a ~1.5–2 GB doc server is gated behind the additive-only `docs` profile, exactly as ollama and pm are excluded from the default budget. On a `single-box` already running ollama + openwrt (+ pm unless `DROPLET_PM_ENABLED=0`), enabling `docs` requires disabling `pm` or adding RAM — the gate is what keeps ≤7 GB boxes on today's download-edit-reupload flow. **Open RAM risk:** the engine ground-truth disagrees on the doc server's own floor — `DOCS_MEM_LIMIT` default is a real-hardware validation item (see Open risks), and if OnlyOffice is chosen its stated minimum may exceed a 2 GB ceiling.

## Security

- **RBAC (ADR-004 per-route guards).** All four workstreams keep the per-route-guard contract. Write/mutating routes (`POST /files/share`, comment/tag create+delete, `editor-session`) carry `requireRole("owner","admin","family")`; `guest` is excluded. GET endpoints stay auth-middleware-only with no role gate (ADR-004 §3), enforcing per-user isolation in SQL. The WS-1 roster route and the WS-4 editor route must be added to the `src/__tests__/rbac.test.ts` allowlist matrix so the policy can't silently drift.
- **IDOR boundary (WS-3).** Comments are per-user-scoped like `FileCitation`: non-privileged roles read/delete only their own rows; owner/admin see all. The owner column **must be `req.user.id` (UUID) on both write and read** — never `getUser(req)`/username — or the scope filter silently never matches (the blocking bug found in verification). Tags are shared file metadata (all readers see all tags; only writes are guarded) — confirm with product that household-wide tag visibility is desired.
- **Member enumeration policy (WS-1, open decision).** Sourcing the roster from the local `User` table lets any `family` member enumerate the full household and share to anyone. This introduces **no new authority** — `POST /files/share` already accepts any `shareWith` for `family` today — it only makes a latent capability usable. If ADR-002's home-user-supervision posture requires restricting member sharing (owner/admin-only, or share-to-supervisor), tighten the `requireRole` list and/or filter the roster. Flag for Romain.
- **Self-exclusion correctness (WS-1).** The recipient list must exclude the caller. `getUser(req)` returns the **local username**, not `nextcloudUsername` (the OCS `shareWith` key), and the two are explicitly decoupled by design (schema comment on `User.nextcloudUsername`). Resolve the caller's own `nextcloudUsername` via a local `User` lookup keyed on `req.user.id`, and compare case-insensitively (matching the system-admin filter).
- **Privacy posture.** No anonymous/"Anyone" links, no external-sharing governance, no Power Automate egress — all SharePoint external-sharing machinery stays a non-goal, consistent with the privacy-first, no-public-egress posture.
- **WS-4 token security.** The `/docs/` nginx proxy forwards WebSocket upgrades but does **not** authenticate; the **short-lived WOPI token is the security boundary**. Confirm the chosen engine rejects expired/forged tokens server-side. Edit-vs-view is decided **server-side** (owner of the file, or shared with NC permission bit 2), never trusting a client-sent mode.
- **WS-4 licensing exposure (sign-off-blocking).** Shipping a doc server on a sold box is *distribution*. OnlyOffice CE is AGPLv3 (un-removable branding + Corresponding-Source offer on conveyance); Collabora CODE is MPLv2 (file-level copyleft, cleaner for a bundled appliance) but carries a hard 10-doc/20-connection cap. Both free editions have a shipping-blocking catch resolvable only by a paid OEM license. This is a legal call for humans, not a code decision.

## Consequences

**Positive**
- Three of four workstreams ship on **existing infrastructure** — pure backend-wiring + UI, no RAM cost, no new attack surface, low architectural risk (S/S–M/M effort).
- Keyword search works **gateway-down**, raising Files-search availability above the current semantic-only path.
- Comments/tags are `ncFileId`-keyed and survive rename/move, avoiding the `FileCitation` staleness class.
- WS-4's profile gate keeps ≤7 GB boxes unchanged while letting RAM-rich boxes opt into co-authoring.

**Negative / costs**
- WS-4 adds real infra complexity (container + nginx WS proxy + 4-file env/docs registration + broker route + Prisma model/migration + a live-co-authoring frontend) and is gated on an unresolved engine/license decision with RAM and OEM-cost risk.
- Sharing/comment/tag state is split across two stores (OCS owns shares; orchestrator owns comments/tags), so the dashboard reflects OCS reality per-open for shares and Droplet state for metadata — a deliberate ADR-013 consequence.
- Hard-deleting a Nextcloud file can free its `oc:fileid` for reuse, orphaning comments/tags onto a different file — the same exposure `File`/`FileContentChunk` already carry; an MQTT file-deleted reconcile is a follow-up, not a v1 blocker.

## Non-goals

- Team sites / intranet pages, Lists, Power Automate flow notifications.
- Governance/compliance: retention labels, eDiscovery, audit-export.
- Managed-metadata term store, content types, default column values, refinable-managed-property search-schema tuning.
- Check-in/check-out locking (actively breaks co-authoring; modern collaboration uses co-authoring + version history).
- Anonymous/"Anyone" links, password+expiry link policies, external-sharing governance.
- `@mention` email fan-out on comments (needs a notification subsystem Droplet lacks).
- Group sharing (`shareType:1`) in WS-1 (no OCS group-name source).
- Multilingual FTS tokenization (the `text_tsv` column is hardcoded `'english'`).

## Alternatives considered

- **WS-2: Elasticsearch / OpenSearch / Meilisearch sidecar.** Rejected — would add a container and RAM the budget can't spare, and Postgres FTS (already shipped) covers home-tier content search. No search container exists in compose.
- **WS-1: widen `GET /auth/users` for `family`.** Rejected — its admin-only OCS semantics are intentional and it's consumed by other surfaces. A purpose-built local-roster route is cleaner and ADR-013-aligned.
- **WS-3: reuse `FileCitation` (path-keyed) or `ActivityRow` (global audit log) for metadata.** Rejected — `FileCitation` doesn't survive rename/move; `ActivityRow` is a hash-chained global log, not per-file metadata. `ncFileId` keying (the `File`/`FileContentChunk` precedent) is correct.
- **WS-4 engine — OnlyOffice Docs CE vs Collabora Online/CODE (UNRESOLVED, human sign-off).** OnlyOffice = stronger OOXML "feels-like-MS-Office" fidelity, OOXML-native, WOPI since v6.4; AGPLv3 (distribution + branding exposure); engine-floor RAM is disputed in our ground truth (one source ~1.5–2 GB, another a 4 GB minimum). Collabora = LibreOffice/ODF core, good-not-pixel-perfect OOXML, ~1 GB for <10 users, MPLv2 (clean for bundling) but a hard 10-doc/20-connection CODE cap. The implementation contract is engine-agnostic (both speak WOPI) so the human decision changes `DOCS_*` config, not code. **No WS-4 code lands until Stefan + Romain pick the engine and license posture.**
- **WS-4: ship CODE / OnlyOffice CE as-is to customers.** Rejected for GA — both free editions carry a shipping-blocker (Collabora doc cap; OnlyOffice AGPL distribution + branding). Budget a paid OEM license before GA.

## References

- `apps/orchestrator/src/services/nextcloud.client.ts` — `ncCreateShareV2` (:1207), `ncUpdateShare` (:1250), `ncDeleteShare` (:1281), `ncListSharedWithMe` (:1298), `ncListUsers` (:531, OCS `/cloud/users/details` admin-only at :534), `ncGetFileId` (:1374, 3-arg `(token, user, path)`)
- `apps/orchestrator/src/routes/files.ts` — `createFilesRouter(prisma)` (:174), `getUser` (returns `req.user.username`, :95), citations route + IDOR scope using `req.user.id` (:193-221), `POST /files/share` (:448), `PUT|DELETE /files/share/:id` (:1011/:1063), `GET /files/search/content` (:1097), `GET /files/search/status` (:1211), `/files/upload` guard (:358)
- `apps/orchestrator/src/routes/llm.ts:748-759` — FileCitation writes `userId = req.user.id ?? req.user.username ?? null`; the `?? username` branch is a legacy fallback for service principals — WS-3 must write `req.user.id` only (never the username fallback)
- `apps/orchestrator/src/routes/auth.ts:2151-2172` — `GET /auth/users` (no role guard; OCS 403→"Admin access required")
- `apps/orchestrator/src/services/file-search.service.ts` — `searchByLexical` (:161), `searchHybrid` (:475), `reciprocalRankFusion` (:235)
- `apps/orchestrator/src/routes/files-knowledge.ts:355` — existing `searchHybrid` wiring precedent
- `apps/orchestrator/src/app.ts` — `authMiddleware` (:228), `app.use("/api", createFilesRouter(prisma))` (:252)
- `apps/orchestrator/prisma/schema.prisma` — `User` (:1279; `username` :1284 / `nextcloudUsername` :1314, explicitly decoupled), `FileContentChunk.ncFileId` (:731) + `text_tsv` (:754), `File.ncFileId @unique` (:1750), `FileCitation` (:2378-2387)
- `apps/orchestrator/prisma/migrations/20260511015837_add_chunk_tsvector_index/migration.sql` — `text_tsv` + GIN
- `apps/orchestrator/prisma/migrations/20260428000000_brain_memory/migration.sql:23-33` — idempotent enum idiom (`DO $$ BEGIN CREATE TYPE … EXCEPTION WHEN duplicate_object THEN null; END $$;`)
- `apps/orchestrator/src/middleware/auth.ts:532` — `requireRole`; `src/__tests__/rbac.test.ts` — RBAC matrix mirror
- `apps/web-dashboard/src/components/FileManager/` — `ShareDialog.tsx` (link-only, `shareType:3` hardcoded :80; lucide import :4-14 lacks `User`/`Users`), `SearchBar.tsx` (boolean `semantic`; lucide import :4 = `Search,X,Loader2,Sparkles` only), `PreviewPane.tsx` (imports only `ReindexButton`+lucide — does **not** mount StarButton/ShareDialog/VersionHistoryPanel), `VersionHistoryPanel.tsx`, `FileRow.tsx`, `FileListSimple.tsx`
- `apps/web-dashboard/src/app/files/page.tsx` — surface root; mounts ShareDialog/VersionHistoryPanel
- `apps/web-dashboard/src/lib/api.ts` — `fetchUsers` (:479), `createShare` (:3839), `searchFileContent` (:3923), `SemanticSearchResult` (:3917)
- `docker/docker-compose.yml` — `nextcloud:29-apache` (no `profiles:`, core) (:422-468), `db: pgvector/pgvector:pg16` (:475), `file-indexer` (:601)
- `docker/nginx.conf` — `$connection_upgrade` map (:22-26), resolver (:20), `/nextcloud/` proxy lacking WS headers (:107-118), `/api/ws/` WS headers (:57-58)
- `scripts/test-security.sh:497-532` — Test 14/WARP-569 `mem_limit` guard (iterates all `services:` regardless of profile)
- `docs/ADR-021-container-resource-limits.md` — RAM budget (default ~5.0 GB :79, ollama 4 GB :104, openwrt 512 MB :105, pm rows :97-103)
- `docs/ADR-004-rbac-per-route-guards.md`, `docs/ADR-013-builtin-directory-vs-nextcloud.md`, `docs/ADR-002`, `docs/ADR-011-hardware-agnostic-codebase.md`, `docs/ENVIRONMENT.md`, `CLAUDE.md`, `.env.example`

## Status audit — 2026-07-27

**Deliberately left `proposed`** (its own lowercase spelling preserved), and
flagged as an open question rather than resolved unilaterally.

ADR-029 lists this ADR in its combined **"Supersedes / relates"** header
field, which does not say which of the two it means — and the distinction
matters. ADR-029 clearly *replaces* this ADR's department/library model, but
the SharePoint-parity goals themselves are still live and only partly
delivered (the ADR-029 epic is 23/30, and the eight disconnected Files routes
that the unified-Files work targets are exactly parity gaps).

So the honest options are `Superseded by ADR-029`, or `Accepted` with the
still-open parity scope carved out — and picking between them is a call for
the deciders, not an audit. Splitting the ambiguous "Supersedes / relates"
field in ADR-029's header into two explicit fields would prevent the next
reader hitting this same question.
