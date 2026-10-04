# Work Suite — slice specs (ADR-069)

Decision record: [`docs/ADR-069-work-suite-projects-service-desk.md`](../../ADR-069-work-suite-projects-service-desk.md).
UI authority for anything under `/projects`: [`docs/projects-surface-design-brief.md`](../../projects-surface-design-brief.md) (tokens §2, screens §3, interactions §4, a11y §5, copy §6, safety chip §8).

Every slice is one PR against `stage`, independently shippable, box bootable before and after. Each section below is the contract for its slice: **scope**, **data**, **API**, **UI**, **acceptance criteria (AC)**, **out of scope**.

## 0. Rules every slice follows

- **Read first:** repo `CLAUDE.md`; `.claude/agents/dev.md`; this file's section for the slice; ADR-069; for UI slices the brief sections named in the slice.
- **Data.** `Pm`-prefixed models only. New state is an explicit enum column, never derived from a nullable (CLAUDE.md "No guessing"). Additive migrations only; existing rows keep their meaning. Migration folder `apps/orchestrator/prisma/migrations/<timestamp>_warp_<key>_<slug>/migration.sql` using the slice's reserved timestamp (table below) so ordering is stable across branches. CHECK constraints and triggers that the service relies on get a `*.pg.test.ts` (pattern: `src/__tests__/pm-work-item-relation.pg.test.ts`).
- **API.** Routes live under `apps/orchestrator/src/routes/pm/` (Projects) or `routes/support/` (Service desk), mounted behind `authMiddleware`, the module gate and the feature grant exactly as `routes/pm/native.ts` is today. zod-validate every body and query. Every mutation writes `PmActivity` (and `ActivityRow` where the existing code does for comparable admin actions). No N+1: list endpoints use one query plus batched lookups.
- **Access.** Reads and writes follow the existing PM role/feature checks in `routes/pm/native.ts` + `routes/pm/actor.ts`. Anything destructive or workspace-wide (delete project, define custom fields, SLA policies, webhooks, tokens, connectors) is owner/admin (or project lead where stated). Service-desk rows are invisible to `/api/pm/*` (404), and project rows are invisible to `/api/support/*`.
- **UI.** `apps/web-dashboard`, existing tokens only — no hex literals, no new tokens (brief §2). Every view ships its empty, loading/skeleton and error states (brief §3.10), keyboard access and visible focus (brief §5), light and dark. Copy follows brief §6 (plain language, no jargon, no exclamation marks). Mobile widths stay usable (brief §7).
- **LLM tools.** The assistant's PM / CRM surface is the verb-shaped `business_find` / `business_timeline` / `business_create` / `business_update` / `business_link` family in `packages/tools-core/src/handlers/business/` (WARP-2583). Extend those — an `entity` enum member, a field — instead of adding noun-shaped tools, and measure the serialized schema size before and after (the registry comments record the budget). Writes are confirm-gated generically by the WARP-2305 interceptor; never add per-handler confirmation code.
- **Egress.** Nothing in this program dials off-LAN except through the `work_integrations` gate (WS-16 introduces it; WS-18 reuses it).
- **Tests.** TDD. `apps/orchestrator`: `npx vitest run <paths>` + `npx tsc --noEmit -p .`; DB invariants as `*.pg.test.ts` gated by `RUN_PG_INTEGRATION=1` + `DATABASE_URL`. `apps/web-dashboard`: `npx vitest run <paths>` + `npx tsc --noEmit -p .`. `packages/tools-core`: `npx vitest run <paths>`. Run `bash scripts/test/ship-check.sh` before handing off if the slice touches compose, scripts or nginx.
- **Commits.** Conventional Commits, `Refs: WARP-NNNN` footer, explicit file lists (`git add <paths>`, never `-A`). No AI/Claude/Anthropic trailers.
- **Scope.** Only what the slice says. Anything else found goes in the hand-off notes.

### Reserved migration timestamps and branches

| Slice | Migration timestamp | Branch |
|---|---|---|
| WS-1 | `20261004010000` | `fix/warp-3371-projects-reliability` |
| WS-2 | `20261004020000` | `feat/warp-3519-pm-collaboration` |
| WS-3 | `20261004030000` | `feat/warp-1505-pm-attachments` |
| WS-4 | `20261004040000` | `feat/warp-3520-pm-fields` |
| WS-5 | `20261004050000` | `feat/warp-3521-pm-cycles-modules` |
| WS-6 | `20261004060000` | `feat/warp-3522-pm-views-filters` |
| WS-6b | `20261004061000` | `feat/warp-3537-pm-table-bulk` |
| WS-7 | `20261004070000` | `feat/warp-3523-pm-calendar-timeline` |
| WS-8 | `20261004080000` | `feat/warp-3524-pm-insights` |
| WS-9 | `20261004090000` | `feat/warp-3525-pm-automation` |
| WS-10 | `20261004100000` | `feat/warp-3526-pm-time-tracking` |
| WS-11 | `20261004110000` | `feat/warp-3527-pm-import-export` |
| WS-12 | `20261004120000` | `feat/warp-3528-service-desk-core` |
| WS-13 | `20261004130000` | `feat/warp-3529-service-desk-email` |
| WS-14 | `20261004140000` | `feat/warp-3530-service-desk-sla` |
| WS-15 | `20261004150000` | `feat/warp-3531-service-desk-insights-ai` |
| WS-16 | `20261004160000` | `feat/warp-3532-work-webhooks` |
| WS-17 | `20261004170000` | `feat/warp-3533-work-ics-api-tokens` |
| WS-18 | `20261004180000` | `feat/warp-3535-work-github-gitlab` |
| WS-19 | `20261004190000` | `feat/warp-3536-pm-live-updates` |

---

## WS-1 — Projects reliability

**Tickets:** WARP-3371, WARP-3372, WARP-3370, WARP-1625, WARP-3181.

**Scope / AC**
1. **No silent cap (3371).** `GET` work-item list endpoints accept `limit` (default 100, max 500) and an opaque `cursor`, return `nextCursor` (null at the end) and `total`. Ordering is stable (`sortOrder`, then `id`). The board and list load every page progressively; while more remain, the view says how many of how many are shown. Summary counts are computed server-side, never from a capped page. Test: 250 items → all 250 render; `total` is exact.
2. **Names (3372a).** Every role that can read Projects resolves assignee / creator / lead ids to display names and avatars. If the people directory endpoint the dashboard uses is admin-only, add (or reuse) a minimal PM-scoped people endpoint returning `{id, displayName, avatarUrl}` for users relevant to PM. "User 1a2b" never renders for a known user; an unknown id renders "Former member".
3. **Date-only dates (3372b).** `dueDate` / `startDate` are calendar dates. The API accepts and returns `YYYY-MM-DD`; storage stays `DateTime` at `00:00:00Z` (no schema change unless unavoidable). The dashboard never passes a date-only value through `new Date()` in local time. Test pinned to `TZ=America/Los_Angeles` and `TZ=Pacific/Auckland`: the date entered is the date shown, and overdue math uses the viewer's local calendar day.
4. **Project delete (3370).** "Delete project" becomes **Archive** (sets `isArchived`, `archivedAt`; archived projects hide from the index behind an "Archived" filter; **Restore** puts it back). Hard delete is allowed only on an archived project, only for owner/admin, and requires typing the project identifier. Archive, restore and hard delete each write an `ActivityRow` audit entry naming the actor and the project. Members get 403 on hard delete.
5. **Module gates (1625).** Every `/api/pm/*` and `/api/mobile/pm*` route — including summary, people, relations, departments and any route added by this slice — is behind the `projects` module gate. A test enumerates the mounted PM router stack and fails if any route lacks the gate.
6. **Contrast (3181).** `.pm-btn.primary` (and any PM control with white-on-brand text) meets WCAG AA 4.5:1 in light and dark, using existing tokens.

**Out of scope:** the Money / ERP 200-document cap named in WARP-3371's title (separate surface; note it in the PR).

---

## WS-2 — Collaboration: comments, mentions, reactions, watchers, activity

**Ticket:** WARP-3519.

**Data.** `PmComment` + `editedAt DateTime?`, `deletedAt DateTime?`, `deletedById String?` (soft delete — body cleared, tombstone shown). `PmCommentReaction {id, commentId, userId, emoji String, createdAt; @@unique([commentId,userId,emoji])}` with a server-side allowlist of emoji. `PmWorkItemWatcher {id, workItemId, userId, reason PmWatchReason (CREATOR|ASSIGNEE|COMMENTER|MENTIONED|MANUAL), createdAt; @@unique([workItemId,userId])}`. `PmCommentMention {id, commentId, userId}`. New `PmActivityVerb` values as needed (`comment_edited`, `comment_deleted`, `watcher_added`, `watcher_removed`).

**API.** `PATCH /api/pm/comments/:id` (author only, sets `editedAt`), `DELETE /api/pm/comments/:id` (author or owner/admin), `POST|DELETE /api/pm/comments/:id/reactions`, `GET|POST|DELETE /api/pm/work-items/:id/watchers` (self-watch for any reader; managing others for owner/admin/lead), `GET /api/pm/work-items/:id/timeline` (comments + activity merged, paginated, newest last). Mentions are parsed server-side from the sanitized comment HTML (`data-mention-id` spans produced by the editor) — never trusted from a client-supplied list — and validated against users who can read the item.

**Notifications.** Mention → notify mentioned user. Comment / state change / assignment → notify watchers except the actor. Reuse the existing PM notification pipeline (`PmActivity.notifyStatus` + the dispatcher WARP-2587 added); no second delivery path. Auto-watch: creator, assignees, commenters, mentioned users.

**UI.** Detail drawer: Activity tab renders the timeline (human sentences per verb: "Ana moved this to In progress · 2h"), comment edit/delete affordances on own comments, "(edited)" marker, tombstones, reaction bar, @-mention picker in the comment editor (keyboard navigable), watch toggle + watcher avatars in the header.

**AC.** Edit/delete permissions enforced server-side (403 tests). Mention of a user who cannot read the item is dropped and not notified. Watchers receive exactly one notification per event; the actor never notifies themselves. Timeline renders every existing `PmActivityVerb`.

---

## WS-3 — Attachments (WARP-1505)

**Data.** Existing `PmAttachment`; add `commentId String?` (attachment on a comment), `status PmAttachmentStatus (UPLOADING|READY|FAILED|DELETED)`, `sha256 String`. New verbs `attachment_added`, `attachment_removed`.

**Storage.** One orchestrator-managed volume (ADR-026: `pm-attachments`) mounted into the orchestrator; files stored by opaque `storageKey` (uuid), never by user filename. Compose + backup path updated; `ship-check` green.

**API.** `POST /api/pm/work-items/:id/attachments` (multipart, streaming to disk, `PM_ATTACHMENT_MAX_BYTES` default 25 MiB, content sniffed — extension and claimed MIME must agree with magic bytes; executables and HTML/SVG refused or served as `application/octet-stream` attachment-only), `GET /api/pm/attachments/:id` (auth + same read check as the work item; `Content-Disposition: attachment` except raster images which may be `inline` with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`), `DELETE /api/pm/attachments/:id` (uploader or owner/admin; file removed after the row). Orphan cleanup for `UPLOADING` rows older than 1h via `cron-runtime`.

**UI.** Attachments section in the detail drawer (list with icon, name, size, uploader, time; image thumbnails), drag-and-drop + file picker + paste-image into the description and comment editors, upload progress, error states with the size limit stated.

**AC.** Path traversal impossible (test with `../` names). Wrong-role download → 403/404. Size limit enforced while streaming (no full buffering). Deleting a work item removes its files.

---

## WS-4 — Editing everywhere: inline editors, relations, item archive, project settings, custom fields, types, estimates

**Ticket:** WARP-3520.

**Why.** Today the drawer can add a label and a comment and nothing else. No work-item property except labels, and nothing about a project, can be changed from the UI. That gap blocks every other slice.

**Data.** `PmWorkItem` + `type PmWorkItemType (task|bug|feature|improvement|question|incident) @default(task)` and `estimate Float?` (points). Custom properties use the existing `PmCustomProperty` / `PmWorkItemPropertyValue`. `options` JSON is validated per `PmPropertyType` (select options: `{id,label,color}[]`). New verbs: `type_changed`, `estimate_changed`, `start_date_changed`, `property_changed`.

**API.**
- Work-item create/update accept `type`, `estimate` and `startDate` (date-only, WS-1 rule).
- `POST /api/pm/work-items/:id/archive` and `/restore`. `DELETE` hard-deletes, owner/admin only.
- Properties: `GET|POST /api/pm/projects/:id/properties` and `PATCH|DELETE /api/pm/properties/:id`, owner/admin/lead.
- `PUT /api/pm/work-items/:id/properties/:propertyId` validates the value against its type: number range, date `YYYY-MM-DD`, member must be an active user, select must be an existing option id. `DELETE` clears it.
- List endpoints return property values.
- State management gains **set default** and **delete with reassign-to** if absent.

**UI.**
- **Drawer.**
  - Inline editors for title (click to edit, Enter saves, Esc cancels), description, state, priority, assignees (multi-select with search), labels, start date, due date, parent (search picker; cycles refused by the API), department, type, estimate, and every custom field with the right editor.
  - Description stays a plain multi-line editor converted to sanitized paragraphs. WS-2 adds the shared rich-text editor, and a follow-up swaps it in.
  - A **Relations** panel to add and remove blocks / blocked by / relates / duplicates, using the existing relations API, with a work-item search picker.
  - An **Archive / Restore / Delete** menu.
- **Optimistic updates** with rollback and an inline error (brief §4.2, §4.4).
- **Project settings** (from the project header): details (name, description, icon, color, lead, department, customer), **States** (create, rename, recolor, reorder, set default, delete with reassign), **Labels** (create, rename, recolor, delete), **Fields** (create, rename, reorder, edit options, delete with "values will be removed").
- Cards and rows show a type icon, an estimate chip, and the start date beside the due date.

**AC.**
- Every built-in property is editable by writers and read-only for readers. RBAC is tested per role.
- Invalid values are rejected with field-level errors.
- Deleting a select option clears it from items, with an activity row per item.
- Archiving hides an item from board and list but keeps it in "Archived".
- Every editor is keyboard-operable with visible focus.

---

## WS-5 — Cycles (sprints) and modules (milestones)

**Ticket:** WARP-3521.

**Data.** Existing `PmCycle`, `PmModule`, `PmModuleWorkItem`. Add a partial unique index: at most one `active` cycle per project. Verbs exist (`cycle_added`, …).

**API.** Cycles: CRUD under `/api/pm/projects/:id/cycles`; `POST /api/pm/cycles/:id/start` (draft→active, rejects a second active), `POST /api/pm/cycles/:id/complete` with `{ moveIncompleteTo: "<cycleId>" | "backlog" }` (moves every non-completed item, one activity row each, one transaction); `GET /api/pm/cycles/:id/burndown` (daily remaining count and remaining estimate from `PmActivity` + item state history, scope changes visible). Modules: CRUD, `POST|DELETE /api/pm/modules/:id/work-items`, progress (`completed / total`, by count and by estimate).

**UI.** Brief §3.7 and §3.8 replace the "aren't ready yet" placeholders: cycles list (active / upcoming / completed with progress bars and dates), cycle detail (board/list scoped to the cycle + burndown chart), backlog planning (drag items from backlog into a cycle; keyboard alternative), modules list with progress, lead, status and target date, module detail. Work-item drawer: cycle and module pickers.

**AC.** Completing a cycle never leaves an incomplete item attached to it. Burndown is correct for items added mid-cycle (scope line rises). Single-active-cycle enforced by the DB (pg test).

---

## WS-6 — Filter DSL, query API, saved views, deep links

**Ticket:** WARP-3522.

**Filter DSL.** `packages/shared-types` (or the PM service if shared-types is the wrong home — follow the repo's precedent) exports a zod schema: `Filter = {and: Filter[]} | {or: Filter[]} | {field, op, value}`; fields: state, stateGroup, priority, assignee (incl. `me`, `none`), label, type, cycle, module, department, dueDate, startDate, createdAt, updatedAt, createdBy, text (name + description), parent, isArchived; ops per field (`is`, `isNot`, `in`, `notIn`, `before`, `after`, `between`, `isEmpty`, `contains`). Relative dates (`today`, `-7d`, `+14d`) resolve server-side in the requesting user's timezone. One compiler `compileFilter(filter, ctx) → Prisma.PmWorkItemWhereInput`, depth- and size-limited, exhaustively unit-tested.

**Data.** `PmSavedView {id, workspaceId, projectId String? (null = cross-project), ownerId, scope PmViewScope (PERSONAL|SHARED), name, layout PmViewLayout (BOARD|LIST|TABLE|CALENDAR|TIMELINE), filter Json, groupBy String?, sortBy Json?, columns Json?, sortOrder Int, createdAt, updatedAt}`.

**API.** `POST /api/pm/work-items/query` `{filter, sort, groupBy, cursor, limit}`; saved views CRUD (`SHARED` create/edit/delete: owner/admin/lead; `PERSONAL`: owner only).

**Deep links.** `/projects` reads and writes its state to the URL: `?p=<identifier>&view=<board|list|table|cycles|modules|…>&item=<KEY-123>&v=<savedViewId>` plus the serialized filter. Opening a URL restores the project, view, filter and open drawer. Back/forward work. Notifications, ICS feeds and webhooks link to `?p=…&item=…`. No route restructure — the single `/projects` route stays (ADR-044: the route is live and deep-linked).

**UI.** Brief §3.9 filter/command bar with chips (every DSL field reachable, relative dates offered as presets); save / update / rename / delete views; views listed in the project header and a cross-project "Views" index; the URL deep links above.

**AC.** Every DSL op has a compiler test and a pg test proving the SQL returns the right rows. Shared views are read-only to non-editors. A deep link round-trips (open URL → same project, view, filter, drawer). The board and list read through the query API so filters are server-side (the client-side filtering in usePm goes away).

---

## WS-6b — Table layout, grouping, bulk edit, command palette

**Ticket:** WARP-3537.

**API.** `POST /api/pm/work-items/bulk` `{ids[], patch: {stateId?, priority?, assigneeIds?, addLabelIds?, removeLabelIds?, cycleId?, moduleId?, type?, isArchived?}}`: one transaction, at most 500 ids, a per-item permission check, and one activity row per changed field per item. A batch with any forbidden item fails atomically with the list of forbidden ids. Keys this slice does not own (cycleId, moduleId, type) are accepted only if the column exists on `stage` when it is built; otherwise they are omitted and listed as follow-ups.

**UI.**
- **Table layout:** sortable columns, a column picker (built-in fields, plus custom properties when present), inline edit for state, priority, assignee and due date, a sticky header, and keyboard row navigation (↑/↓, Enter opens the drawer).
- **Grouping** for list and table: by state, assignee, priority, label, type, cycle, module or department, with collapsible groups and counts, persisted per view in local storage until WS-6 saved views carry it.
- **Bulk:** a checkbox column, shift-range select, and a floating action bar (state, priority, assignee, labels, archive) with an undo toast.
- **Command palette** (`Ctrl/⌘ K`): jump to project / item by key or title, create item, switch view, run bulk actions on the selection.
- **Shortcuts** per brief §5.6 (`c` create, `/` search, `j`/`k` move, `x` select, `e` edit, `a` assign, `s` state, `p` priority, `?` shortcut sheet). Shortcuts are disabled while typing in inputs.

**AC.** Bulk partial-permission batches fail atomically (route and pg tests). Every shortcut has a test and is listed on the `?` sheet. The table renders 1,000 rows smoothly (virtualised).

---

## WS-7 — Calendar, timeline (Gantt), My Work

**Ticket:** WARP-3523.

**UI + API.**
- **Calendar layout** (month / week): items placed on `dueDate`; items with `startDate` span; drag to reschedule (PATCH, optimistic with rollback); "Unscheduled" side panel to drag from; overdue styling per brief §2.
- **Timeline layout**: rows = items (grouped like list), bars from `startDate` to `dueDate` (single-day diamond when only one date), zoom day / week / month / quarter, drag to move, drag edges to resize, `BLOCKS` relations drawn as dependency connectors, module target dates as milestone markers, today line, keyboard nudging (`←/→` ±1 day, `Shift` ±1 week). Server: `GET /api/pm/projects/:id/timeline?from&to` returns items + relations in range.
- **My Work** (`/projects?view=my-work`): cross-project for the signed-in user. It is a view of the existing route, not a new nav row, because `nav-config.four-groups.test.ts` caps top-level rows at 15 and an owner already has 15 — Assigned, Created, Mentioned, Watching (if WS-2 has landed; hidden otherwise), Overdue, Due this week — each a server-side query, grouped by project, using the same row component as list.

**AC.** Dates round-trip as calendar dates (WS-1 rule). Dragging across a DST boundary keeps the calendar date. Timeline renders 1,000 items without layout thrash (virtualised rows).

---

## WS-8 — Insights

**Ticket:** WARP-3524.

**API.** `GET /api/pm/insights?projectId&from&to&groupBy` returns: throughput (completed per week), created vs completed per week, cycle time (started→completed) and lead time (created→completed) distributions (p50 / p85 / p95), cumulative flow (daily count per state group, reconstructed from `PmActivity` state changes), workload (open items and open estimate per assignee), aging WIP. Aggregation in SQL; cached per (project, range) for 5 min. Add `unassigned` to `GET /api/pm/summary` (ADR-044 follow-up).

**UI.** A project "Insights" tab, and workspace-level insights at `/projects?view=insights` (no new nav row, because of the 15-row cap): chart cards using the dashboard's existing chart primitives and tokens, each with a one-line plain-language reading ("Most work finishes within 4 days"), range picker, empty states for new projects.

**AC.** Numbers verified by pg tests against a fixture with known transitions. No chart introduces new color tokens.

---

## WS-9 — Templates, recurring work, automation rules (stacked on WS-16)

**Ticket:** WARP-3525.

**Data.** `PmTemplate {id, workspaceId, projectId?, kind (WORK_ITEM|PROJECT), name, payload Json (validated), createdById}`; `PmRecurrence {id, templateId, projectId, rule (FREQ=DAILY|WEEKLY|MONTHLY|YEARLY; INTERVAL; BYDAY; BYMONTHDAY), timezone, nextRunAt, lastRunAt, status (ACTIVE|PAUSED)}`; `PmAutomationRule {id, projectId?, name, trigger PmAutomationTrigger, conditions Json (WS-6 filter DSL), actions Json (typed list), enabled, runCount, lastRunAt, lastError}`; `PmAutomationRun {id, ruleId, workItemId, status, error, startedAt}`. `PmActivity.actorKind` (`USER|AUTOMATION|SYSTEM|ASSISTANT`, default `USER`) + `automationRuleId`.

**Triggers:** item created, state changed, assignee changed, priority changed, comment added, due date approaching (N days), due date passed, scheduled (cron). **Actions:** set state / priority / assignee / labels / type / cycle / module, add comment (internal), notify user(s), create sub-task from template, send webhook (when WS-16 is present).

**Engine.** A `PmActivity` outbox consumer (ADR-069 §7; framework from WS-16) — not emit calls scattered through the service. Conditions use the WS-6 filter DSL (copy WS-6's DSL module verbatim if WS-6 has not merged; identical files merge cleanly); chain depth ≤ 3; a rule never fires on its own action; per-rule rate limit; every action audited. Built-in project templates: Software delivery, Marketing campaign, Client onboarding, Office operations, IT requests.

**AC.** Loop guard tested (A triggers B triggers A stops). Recurrence across DST and month-end (31st → 30th/28th) tested. Disabled rules never run.

---

## WS-10 — Time tracking

**Ticket:** WARP-3526.

**Data.** `PmWorklog {id, workItemId, userId, startedAt, minutes Int, note, createdAt, updatedAt}`, `PmTimer {userId @id, workItemId, startedAt}` (one running timer per user).

**API.** Worklog CRUD (own entries; owner/admin all), `POST /api/pm/timer/start|stop` (stop writes a worklog), `GET /api/pm/timesheet?userId&weekStart`, `GET /api/pm/time/report?projectId&from&to&groupBy=user|item|day` + CSV.

**UI.** Detail drawer "Time" section (total, entries, log time, start/stop timer), persistent running-timer chip in the Projects header, weekly timesheet grid per person, time report with CSV export.

**AC.** Starting a second timer stops the first (one worklog written). Minutes ≥ 1 and ≤ 24h per entry. Time totals in reports equal the sum of worklogs (pg test).

---

## WS-11 — Import and export

**Ticket:** WARP-3527.

**Export.** `GET /api/pm/projects/:id/export.csv` (streamed; current filter optional), `GET /api/pm/projects/:id/export.json` (full project: states, labels, fields, items, comments, relations — not attachments' bytes).

**Import.** `PmImportJob {id, projectId, source (CSV|JIRA_CSV|ASANA_CSV|TRELLO_JSON|LINEAR_CSV|GITHUB_CSV), status (PENDING|PREVIEWED|RUNNING|SUCCEEDED|FAILED|CANCELLED), mapping Json, stats Json, error, createdById, createdAt, finishedAt}`; `PmWorkItem.externalSystem String?` + `externalId String?` with `@@unique([projectId, externalSystem, externalId])` so re-import updates instead of duplicating. Upload → parse (bounded rows, 10 MB) → preview with auto-mapped columns (status → state, priority, assignee by email/name, labels, dates, parent, description) → user adjusts mapping → run in background with progress → summary (created / updated / skipped with reasons).

**UI.** Project ⋯ menu → Import / Export: a wizard with a mapping table and a preview of the first 20 rows. The Atlassian connector is an outbound MCP client (ADR-043), so a direct "Import from Jira" is a stretch goal. Build it only if the MCP read path yields issues with their fields cheaply; CSV import is the contract. If built, offer "Import from Jira" straight from it (project picker, then the same mapping and preview) alongside CSV.

**AC.** Fixtures from each source format parse correctly. Re-running the same import is idempotent. Unknown assignees are reported, never silently dropped.

---

## WS-12 — Service desk core

**Ticket:** WARP-3528.

**Module.** New `ModuleId` value `support` with every mirrored site updated (Prisma enum + migration, `module-registry.ts`, the dashboard `lib/access.ts` mirror, `nav-config.ts` entry **Support** in the `Business` group, business-type presets — on for `professional_office`, `retail`, `hospitality`, `clinic`; off for `home`), feature grant `support` in the access-role vocabulary, tool domain `support`. No `requires` edge (ADR-069 §1).

**Data.** `PmProject.kind PmProjectKind (PROJECT|SERVICE_DESK) @default(PROJECT)`. `PmState.slaClock PmSlaClock (RUNNING|PAUSED|STOPPED) @default(RUNNING)`. `PmComment.visibility PmCommentVisibility (INTERNAL|PUBLIC) @default(INTERNAL)`, `PmComment.authorKind PmAuthorKind (USER|CONTACT|SYSTEM|AUTOMATION) @default(USER)`, `PmComment.contactId String?`. `PmTicket {workItemId @id, requesterKind PmRequesterKind (CONTACT|USER), requesterContactId String?, requesterUserId String?, companyId String?, channel PmTicketChannel (EMAIL|INTERNAL|WEB_FORM|CHAT|API|PHONE), firstRespondedAt DateTime?, solvedAt DateTime?, reopenCount Int @default(0), lastPublicActivityAt DateTime?, slaStatus PmSlaStatus (NONE|ON_TRACK|AT_RISK|BREACHED|MET|PAUSED) @default(NONE), satisfaction PmSatisfaction? , createdAt, updatedAt}` with CHECK: exactly one requester FK matches `requesterKind`. Service-desk creation seeds states New (unstarted, RUNNING), Open (started, RUNNING), Pending (started, PAUSED), On hold (started, PAUSED), Solved (completed, STOPPED), Closed (completed, STOPPED) and labels Question / Incident / Problem / Task. `firstRespondedAt` is set by the first PUBLIC comment from a USER.

**API.** `/api/support/*`: desks (list/create/update — owner/admin), tickets (list with system queues `unassigned`, `mine`, `open`, `pending`, `solved_recent`, `all`; get; create — staff on behalf of a contact or themselves; update status / priority / assignee / department / labels / type), conversation (`POST /api/support/tickets/:id/replies` public, `POST …/notes` internal, `GET …/conversation`), requester (`GET /api/support/requesters/:contactId/tickets`), escalate (`POST /api/support/tickets/:id/escalate {projectId, title}` → new PM work item + `RELATES` relation, requires both grants). `/api/pm/*` excludes service-desk projects and items (404) — a test proves it for every PM read route.

**UI.** `/support`: left rail of queues with live counts; ticket list (requester, subject, status pill, priority, assignee, last update, SLA badge slot); ticket workspace — conversation timeline with clear visual distinction between public replies and internal notes (notes on a tinted surface, labelled "Internal note — not sent"), composer with **Reply** / **Internal note** toggle (Reply sends nothing in this slice beyond recording the public comment unless WS-13 is present; label states "Reply will be recorded" when no channel is bound), properties sidebar (status, priority, type, assignee, department, labels), requester card (contact name, email, company → links to `/customers` record, "Other tickets from this requester"), linked work items, escalate action. New-ticket modal. Empty states teach the model ("Customers email you; tickets appear here").

**AC.** RBAC matrix tested for both surfaces. The CHECK constraint and `kind` isolation have pg tests. A member without the `support` grant gets 403 on every `/api/support/*` route. Escalation creates exactly one linked work item and records activity on both.

---

## WS-13 — Email channel (stacked on WS-12)

**Ticket:** WARP-3529.

**Data.** `PmSupportChannel {id, projectId, kind (EMAIL), emailAccountId @unique, enabled, autoAckEnabled, autoAckTemplate, reopenWindowDays Int @default(14), createdAt, updatedAt}`; `PmTicketEmailLink {id, workItemId, emailThreadId @unique, emailMessageId?, direction (INBOUND|OUTBOUND), messageIdHeader, createdAt}`.

**Prerequisites (verified).**
- **Email module.** `/api/email` is gated by the `email` module (default off; available only with `SERVICE_TOKEN_EMAIL`). A desk can bind a mailbox only when Email is effective, and the channel settings say so plainly.
- **Headers.** The ingest zod schema and the indexer's `ParsedMessage` carry no `References`, `Auto-Submitted`, `Precedence` or `X-Autoreply`. Loop protection therefore needs three extensions, all in this slice: the Python parser (`services/email-indexer`), the ingest schema, and `EmailMessage` columns (or one validated `headers` Json).
- **Contact owner.** Contacts are owner-scoped: `Contact.userId` is NOT NULL, and `createContact(prisma, userId, …)` lives in `services/contacts/contacts.service.ts`. The channel carries an explicit `contactOwnerUserId` (owner/admin chooses; default is the desk lead), used for every contact that intake creates. The ticket snapshots the requester's name and email.

**Intake.** `services/email-indexer` (Python) already runs IMAP IDLE per `EmailAccount` and posts each new message to `POST /api/email/:accountId/messages-ingest` (`routes/email.ts`). Today only CRM filing (`services/filing/email-arm.ts`) consumes it. Hook ticket intake in at the same point the filing arm is invoked, after the `EmailMessage` row commits. No second IMAP poller and no change to the Python service unless strictly needed. New thread → ticket (requester `Contact` found by `ContactEmail` or created with an explicit origin), subject → title, sanitized body → description (HTML through `sanitize-html.ts`), attachments referenced. Reply on a linked thread (by `In-Reply-To`/`References`, then by `[KEY-123]` subject token) → PUBLIC comment from the CONTACT; Pending/Solved within the reopen window → Open (`reopenCount++`); Closed → new ticket linked `RELATES`. **Loop protection:** ignore `Auto-Submitted` ≠ `no`, `Precedence: bulk|junk|list`, `X-Autoreply`, mailer-daemon/bounces, messages from the bound account's own address, and > 20 messages / hour from one sender (rate-limited to one notification to admins).

**Outbound.** A PUBLIC reply sends through the bound account's existing send path. The mailbox outbox is `EmailDraft`, which `services/email-indexer` sends with threading headers; the org SMTP relay in `services/email-channel.service.ts` is for invites and shares only and is not used here.

- **Enqueue.** `POST /api/email/drafts/:id/send` is owner/admin-only. The desk therefore enqueues the `EmailDraft` itself (status `queued`) in service code, after its own support-grant check and the `outbound_email` gate.
- **Message-ID.** The indexer does not store the outbound `Message-ID`. Generate it in the orchestrator, store it on the draft, and have the indexer use it (a small Python change), so header-based reply matching works for outbound-first threads. The `[KEY-123]` subject token remains the fallback, with `In-Reply-To` / `References` and `[KEY-123]` in the subject; failures surface on the comment (`deliveryStatus` explicit enum: `PENDING|SENT|FAILED`) with a retry action. Auto-acknowledgement on new tickets when enabled (template variables `{{requester.firstName}}`, `{{ticket.key}}`, `{{ticket.title}}`, `{{desk.name}}`). Sending respects the existing `outbound_email` egress channel.

**UI.** `/support` → Settings → Channels: bind an email account, toggle auto-acknowledge, edit the template with a preview. Ticket conversation shows email delivery state.

**AC.** Fixture-driven tests: new mail → ticket; reply → comment; auto-reply ignored; own outbound not re-ingested; threading headers correct.

---

## WS-14 — SLAs, business calendars, escalation, macros, assignment (stacked on WS-12)

**Ticket:** WARP-3530.

**Data.** `PmBusinessCalendar {id, workspaceId, name, timezone, windows Json ([{day 0-6, start "09:00", end "17:00"}]), holidays Json (["YYYY-MM-DD"])}`; `PmSlaPolicy {id, projectId @unique, calendarId?, enabled, targets Json ({priority: {firstResponseMins, nextResponseMins, resolutionMins}}), atRiskPercent Int @default(75), escalation Json}`; `PmTicket` + `firstResponseDueAt`, `nextResponseDueAt`, `resolutionDueAt`, `slaPausedMs BigInt @default(0)`, `slaPausedAt DateTime?`; `PmMacro {id, projectId?, name, bodyHtml, actions Json (set status/priority/assignee/labels), visibility (PERSONAL|SHARED), ownerId}`; `PmAssignmentRule {id, projectId @unique, mode (MANUAL|ROUND_ROBIN|LEAST_OPEN), departmentId?, memberIds Json, lastAssignedUserId?}`.

**Engine.** `business-time.ts` pure library: `addBusinessMinutes(start, mins, calendar)`, `businessMinutesBetween(a, b, calendar)` — tested across DST (US + EU + southern hemisphere), holidays, overnight windows, 24/7 calendars. Due times computed on create / priority change / state change (pause & resume via `PmState.slaClock`). `cron-runtime` interval (60 s) moves `slaStatus` ON_TRACK→AT_RISK→BREACHED, emits notifications (assignee + desk admins) once per transition, applies escalation actions (raise priority, reassign, notify).

**UI.** SLA badge on rows and in the ticket header (time remaining in business time, colour by status from existing system tokens); desk settings for calendars, SLA targets per priority, assignment mode; macros picker in the composer (insert text with variables, apply field changes, preview before apply).

**AC.** Every SLA transition test is deterministic (injected clock). Round-robin skips inactive users and is stable under concurrency (row lock / transaction).

---

## WS-15 — Support insights, CSAT, assistant tools (stacked on WS-14)

**Ticket:** WARP-3531.

**Insights.** `GET /api/support/insights` — volume by day and channel, first-response time and resolution time (business time, p50/p90), SLA attainment %, backlog by age bucket, per-agent solved / FRT, CSAT average and response rate. `/support/insights` page.

**CSAT.** When a ticket moves to Solved, if the desk enables CSAT and an email channel is bound, the solved notice asks the requester to reply with a rating word or number (1–5 / "good" / "bad"); the email intake (WS-13) parses the first token of a reply on a solved ticket within 7 days into `PmTicket.satisfaction` + optional comment. No public link.

**Assistant.** Tickets join the `business_*` graph (`packages/tools-core/src/handlers/business/_graph.ts`, `find.ts`, `timeline.ts`, `create.ts`, `update.ts`, `write-shared.ts`): `ticket` is a `business_find` / `business_timeline` entity (filterable by queue, status, requester); `business_create` creates a ticket and adds a note on a ticket parent whose kind is internal or **reply** (the reply is the only path by which the assistant contacts a customer, and the generic WARP-2305 interceptor confirms it); `business_update` changes status / priority / assignee. Measure serialized schema size before and after and keep the increase small. Ticket workspace gets **Summarize** and **Draft reply** actions that call the existing orchestrator chat path with the configured model and insert a draft into the composer; nothing sends without the agent pressing Send.

**AC.** Tool schemas unit-tested; confirm-gated writes cannot execute without a confirmation token (WARP-2008 rule).

---

## WS-16 — Webhooks and chat-app notifications

**Ticket:** WARP-3532.

**Egress.** New `OffLanChannelKey` value `work_integrations` (owner switch, default off) with its settings copy, plus the `docs/security/allowed-egress.yaml` entry the `egress-gate` check requires; `off-lan-gate.service.ts` consulted before every off-LAN delivery.

**SSRF guard.** Extend the existing `apps/orchestrator/src/lib/outbound-url-guard.ts` (do not write a second guard): resolve the hostname once, refuse loopback, link-local, multicast, unspecified, the docker/compose networks, the box's own interface addresses and metadata addresses; connect to the pinned IP with the original Host/SNI; LAN (RFC 1918) destinations allowed without the egress switch, everything else requires it. No redirects followed.

**Data.** `PmWebhook {id, workspaceId, projectId?, name, url, format PmWebhookFormat (JSON|SLACK|TEAMS|DISCORD|GOOGLE_CHAT), secretEnc, events String[], enabled, status (ACTIVE|DISABLED_FAILING|PAUSED), consecutiveFailures Int, createdById, createdAt, updatedAt}`; `PmWebhookDelivery {id, webhookId, event, payload Json, status (PENDING|DELIVERED|FAILED|GIVEN_UP), attempts, nextAttemptAt, lastStatusCode, lastError, createdAt, deliveredAt}`.

**Outbox consumer framework (shared).** `apps/orchestrator/src/services/pm/pm-outbox.ts`: `readOutboxBatch(consumer, limit)` returns `PmActivity` rows after the consumer's cursor in `(createdAt, id)` order. `advanceOutboxCursor(consumer, row)` stores the cursor in `SystemFlag` under key `pm-outbox:<consumer>`. `registerOutboxConsumer({name, intervalMs, handle})` schedules a `cron-runtime` interval with an advisory lock and exposes `nudgeOutbox()`, which `writeActivity` calls after the transaction commits. A brand-new consumer starts at "now" and never replays history. Handlers must be idempotent. WS-9 (automation) and WS-19 (live updates) register their own consumers on this framework.

**Delivery.** Events: `work_item.created|updated|state_changed|assigned|commented|archived`, `ticket.created|replied|solved` (when support exists), `sla.at_risk|breached`. JSON payload v1 documented in `docs/` (id, event, occurredAt, workspace, project, workItem summary, actor, changes). Header `X-Droplet-Signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + body)>`, `X-Droplet-Event`, `X-Droplet-Delivery`. Retries 1m, 5m, 30m, 2h, 6h, 12h, 24h; auto-disable after 20 consecutive failures with an admin notification. Delivery processing on `cron-runtime`.

**UI.** Settings → Integrations → Work notifications: add webhook (presets for Slack / Teams / Discord / Google Chat incoming-webhook URLs, event picker, project scope), send test, delivery log with status and response code, re-deliver, rotate secret (shown once).

**AC.** Signature verified by a test using the documented algorithm. SSRF guard rejects every forbidden range (table-driven tests, IPv4 + IPv6 + IPv4-mapped). Egress switch off → off-LAN deliveries stay PENDING with a clear "blocked by egress setting" error, LAN deliveries proceed.

---

## WS-17 — ICS feed, personal API tokens, OpenAPI

**Ticket:** WARP-3533.

**ICS.** Extend the existing calendar-feed mechanism (`CalendarFeedToken`). The pieces: the feed `GET /api/calendar/publish/:user.ics?token=` in `routes/calendar.ts` (mounted before auth), `verifyFeedToken` in `services/calendar-feed-token.service.ts`, and the serializer `serializeIcs` in `services/ics.ts`.

Four things to handle:
- The route bypasses every gate, so the PM source must re-check the `projects` module and the guest tier floor itself.
- `CalendarEvent.userId` is a username, while PM assignees are `User.id`.
- `serializeIcs` needs an optional `STATUS`.
- The feed has no rate limit; add one.

PM feeds: "My work" (assigned to me, due dates) and per-project. All-day `VEVENT` per item with a due date, `URL` to the item, `STATUS:COMPLETED` when done; feed tokens revocable from the same UI as calendar feeds.

**Tokens.** `PmApiToken {id, userId, name, prefix, hash, scopes String[] (pm:read|pm:write|support:read|support:write), lastUsedAt, expiresAt?, revokedAt?, createdAt}`. The token is shown once and stored as a sha256 with a display prefix — ADR-067's `ModelAccessToken` shape, though that token is only introspected by ai-gateway and never reaches `authMiddleware`.

- **Auth branch.** Add a new prefix branch to `authMiddleware` (`middleware/auth.ts` ~282-330, beside `SERVICE_TOKEN_*`, `dxt_` and JWT). It resolves to the issuing human's `AuthUser`, so every role, module and feature gate runs unchanged.
- **Scope guard.** Modelled on `extensionPrincipalGuard` (app.ts ~355). It confines the token to `/api/pm/*` and `/api/support/*`.
- **Revocation and limits.** Revoke hooks on role mutation (as `ModelAccessToken` has), plus a rate limit.

Accepted as `Authorization: Bearer` on those two prefixes only, acting as the issuing user with scope checks layered on top of the user's own permissions; rate-limited; owner/admin can disable API tokens workspace-wide. Settings → Developer: create, list, revoke.

**OpenAPI.** `GET /api/pm/openapi.json` (OpenAPI 3.1) generated from the zod schemas where the repo already has a generator, otherwise a checked-in document with a test asserting every mounted PM/support route appears in it. Developer page links to it.

**AC.** A revoked or expired token gets 401. A `pm:read` token gets 403 on writes. Tokens never appear in logs (test).

---

## WS-18 — GitHub / GitLab development panel

**Ticket:** WARP-3535.

**Connector.** GitHub and GitLab already exist as read-only REST vendor profiles (`services/erp-connector/src/rest/vendors/github.ts` / `gitlab.ts`, ADR-046). They emit canonical `task` rows that no table stores today. Extend those profiles: PRs/MRs are already there; add commits and branches only if the profile shape allows, otherwise link at PR level only. Land matches into `PmExternalLink`. They are also registered as read-only providers (`packages/shared-types/src/provider-registry.ts`, `routes/integrations.ts`, `IntegrationConnection`, `/integrations` UI). Extend those providers. Do not declare new ones. Credentials are customer-supplied (ADR-042): GitHub (fine-grained PAT, `contents:read`, `pull_requests:read`) or GitLab (PAT `read_api`, self-hosted base URL allowed). Owner/admin connects and picks repositories, and maps each to PM projects. Egress through `work_integrations` (WS-16's key; if WS-16 is not merged yet, this slice adds the key and WS-16 rebases).

**Sync.** `cron-runtime` every 5 min with conditional requests (ETag / `If-Modified-Since`): open + recently-updated PRs / MRs, recent commits on default branch, branches. Match `IDENTIFIER-123` (case-insensitive, word-bounded) in branch names, titles, bodies, commit messages. `PmExternalLink {id, workItemId, provider (GITHUB|GITLAB), kind (PULL_REQUEST|COMMIT|BRANCH), externalId, url, title, state (OPEN|MERGED|CLOSED|DRAFT), author, updatedAt; @@unique([provider, kind, externalId, workItemId])}`. Optional per-project rules: PR opened → state X; PR merged → state Y (writes activity with `actorKind = SYSTEM`).

**UI.** Work-item drawer "Development" section (PRs / commits / branches with status pills, links open externally), copy-branch-name button (`identifier-123-short-title`), integration settings page with last sync time and errors.

**AC.** Matching tested against a corpus (no false positives on `ABC-1234` when the project is `ABC` and item 123 — word boundaries). Rate-limit headers respected (back off). Disconnect removes credentials and stops sync.

---

## WS-19 — Live updates (stacked on WS-16)

**Ticket:** WARP-3536.

**Server.** A `pm-live` outbox consumer (WS-16 framework, interval 1 s plus nudge) maps each `PmActivity` row to the users who can read the item. For a project item: every role with Projects access, minus guests who are not assigned. For a service-desk item: users with the `support` grant. It publishes a compact event `{type:"pm.changed", projectId, workItemId, verb}` on a new per-user topic, `droplet/pm/<username>`. Add that topic to the forwarded list in `services/ws-bridge.service.ts` (~108-128). Copy the `publishTeamChatEvent` pattern in `services/team-chat-events.service.ts`: ids and kind only, fire-and-forget, QoS 0, via `publish` in `services/mqtt.service.ts`. No content is published, only ids: the client refetches through the normal authorized API. Presence: the drawer sends a heartbeat (`POST /api/pm/work-items/:id/presence`, 20 s TTL, in memory); `GET` returns other viewers.

**Client.** One `usePmLive()` hook subscribes to the dashboard's existing WebSocket client and revalidates the affected SWR keys (project list, work-item list, the open drawer, support queues). Updates are debounced to 250 ms. The hook pauses while a drag is in progress, so a remote change cannot yank a card mid-drag. The drawer header shows "Also viewing: <avatars>".

**AC.** Two sessions on the same board: a change in one appears in the other within 3 s. A user who cannot read an item receives no event for it (test). With MQTT down, the dashboard falls back to its current behaviour and shows no errors.
