# Files sub-view addendum + design-brief pointer (WARP-1546)

**Status:** discharges the `[GATE]` ticket **WARP-1546** on epic **WARP-1545**.
**Gate authority:** `docs/ADR-029-teams-departments-files.md` §5, line 261 — verbatim:

> **Design packet first:** a files sub-view addendum (per the design punch list) precedes all
> frontend tickets; it also fixes the vocabulary decision D-3.

Until this doc and its packet are reviewed, **WARP-1548 / 1550 / 1551 / 1552 / 1553 / 1627 are
blocked.** Building any of them first contradicts an accepted ADR.

---

## 1. Where the design briefs live (the pointer half of WARP-1546)

Files code cites `§0.3 / §1 / §2 / §3 / §5` of a design brief in about a dozen places —
`SpaceSwitcher.tsx:24, :58, :87-93, :177`, `app/files/page.tsx:65, :99, :263`,
`app/admin/files/page.tsx:5, :14`, `apps/orchestrator/src/routes/departments.ts:180, :223, :289`,
`components/FileManager/UploadZone.tsx:112` — and none of those documents were in this repo. Every
constraint the shipped code claims to honor was unauditable from a PR.

WARP-1546 offers two options: vendor the briefs, or pin them by path + SHA. **We pin, and vendor the
decisions.** The briefs are large and carry prototypes; duplicating them into this repo would create
two copies that drift. What must be auditable in a PR is the *constraint set*, and that is §3–§8
below.

| Brief | Canonical path | Pinned at |
|---|---|---|
| Files surface (this epic's design) | `DropletByWarpLab/shared_brain` → `content/brand/handoffs/files/DESIGN-BRIEF.md` | `ce39ac818471` |
| Files packet README (integration map) | `…/handoffs/files/README.md` | `ce39ac818471` |
| Files prototype (clickable, all states) | `…/handoffs/files/prototype/index.html` | `ce39ac818471` |
| Teams/Departments rights model (the §0.3/§1/§2/§3/§5 the code cites) | `…/handoffs/departments/DESIGN-BRIEF.md` + `ARCHITECTURE-BRIEF.md` | as referenced by `components/Departments/DepartmentsPanel.tsx:6-9` |

**When a `§`-reference in this repo's comments changes meaning, update this table's SHA in the same
PR.** A stale pin is the failure mode this ticket exists to fix.

---

## 2. The four decisions WARP-1546 delegates to the addendum

WARP-1548 and WARP-1546 both explicitly refuse to decide these in the ticket. They are decided here.

### 2.1 The rail's a11y role: `navigation`, not `tablist`, not `tree`

The shipped control is `role="tablist" aria-label="File space"` (`SpaceSwitcher.tsx:145`). The rail
is **`<nav aria-label="Places">` containing a list of links**.

This is a deliberate divergence from the Network-tabs precedent (`docs/indigo-redesign-handoff.md:128-130`),
which preserved a tablist contract byte-for-byte. The rationale:

- A **tablist** promises panels in one region, arrow-key cycling, one visible at a time, and focus
  staying inside the widget. The rail does none of that: each place is a distinct URL with its own
  history entry and its own deep link (WARP-1547 made `(space, path)` addressable). That is a
  navigation contract.
- **`tree`** is worse. It promises expand/collapse and arrow traversal over arbitrary depth. This
  hierarchy is **exactly one level** by ADR-029:306 and nothing collapses; the role would advertise
  interactions that do not exist.
- The Network precedent preserved a tablist because that control *stayed* a tabbed region. This one
  stops being one, so preserving the role would be the incidental outcome and changing it is the
  considered one.

**Consequences to implement:** one `aria-current="page"`; Tab moves between places rather than
arrow-cycling within them; a visible focus ring on every row (`docs/projects-surface-design-brief.md`
§5.2); each rail group heading is associated, not a bare styled `div`.

The breadcrumb root keeps `aria-label={rootLabel}` — asserted at source level by
`__tests__/a11y.icon-button-labels.test.tsx:38-42` and dynamic since WARP-1944, defaulting to
"My files". The design's named root crumb *is* that value; do not regress it.

### 2.2 `SpaceSwitcher`: retire it, absorb its behavior

Not "keep for narrow viewports". The rail supersedes it at every width — desktop via the sidebar's
Files section, below 900px via the mobile drawer's Files section (WARP-1554 already renders those
children under a parent caption). There is no viewport where the switcher has a job the rail is not
doing, and shipping both showing the same thing is the outcome WARP-1548 warns against.

Absorb, do not discard: kind glyphs, the neutral rights-chip treatment, `provisioning`/`failed`
chips, department→team grouping, the orphan-team fallback (`SpaceSwitcher.tsx:191-197` — a team whose
parent is absent still renders), and the owner/admin-only visibility filter for `failed` rows.
`spaceSwitcherVisible()` becomes the rail's Home-mode gate (§3). **Delete the component only once
each of those behaviors has a test on the rail.**

`shared` stays a valid space id for one more release (ADR-029:245); `PINNED_IDS`
(`SpaceSwitcher.tsx:112`) still depends on it. Retiring the switcher does not retire the id.

### 2.3 `/files/devices`: out of the rail, and out of Files

Sync Devices manages sync-client pairing. It has no path, no listing and no library — it cannot
answer "where am I" because it is not a place, and putting it in a rail of locations would make the
rail mean two things.

It moves to **Settings**, as a row navigating to the existing route. `/files/devices` keeps working;
it stops being presented as a file location and leaves the Files section of the sidebar. Until the
Settings row lands it stays reachable exactly as today — **this is a move, not a deletion, and it
must not become an orphan in between.**

### 2.4 Vocabulary (D-3, closed for the brand bundle)

ADR-029 resolved the model question on 2026-07-11 (D-3: *both* — teams nest inside departments, one
level). What ADR-029:261 left open was that "department" appeared nowhere in the brand bundle. It now
appears in the `departments/`, `access/`, `reports/` and `files/` packets. The user-facing lexicon:

| Use | Never |
|---|---|
| **Department** — top-level unit with its own library | "group", "org unit", "folder group" |
| **Team** — lives inside exactly one department | "sub-team", "subgroup", "nested department" |
| **Library** — the files belonging to a department or team | "space" |
| **Workspace** — the shared everyone-in-the-business library | "Household" (raw server name; `spaceRenderName` maps it, WARP-1808) |
| **My Files** — the personal library | "Home", "personal space" |

**"Space" is a code word.** It is the type name (`FileSpace`, `FileSpaceId`, `?space=`) and must not
reach the UI.

---

## 3. Home mode stays pixel-identical (ADR-029:232)

Binding, and this design does not touch it. **A single-space Home install renders exactly as it does
today.** No rail, not collapsed, not a teaser. The predicate is the one already shipped: fewer than
two visible spaces means no location control at all.

Everything else in the packet — view modes, facets, the inspector, the chat seam — is persona-neutral
and ships to both personas.

Two prohibitions carry forward unchanged:

- **No "personal homes" rail entry until WARP-1272** — not disabled, not a teaser, not a lock icon
  (`app/admin/files/page.tsx:16-19`).
- **Household gets no per-member rights editor pre-GA** (D-5, ADR-029:244). The rail *displays*
  rights; it never edits them.

---

## 4. The six sub-views — states, and the one they are all missing

Each sub-view stops being its own page with its own `ShellPage` and hand-rolled back-link (five carry
byte-identical back-link blocks today: `drives/page.tsx:14-24`, `trash:53-58`, `favorites:60-65`,
`recents:80-85`, `shared:68-73`) and becomes the shared layout with that place selected. **The route
survives; the page does not.**

All six get four states:

| State | Rule |
|---|---|
| Loading | Skeleton rows in the current view mode's shape. Never a spinner; never a height that changes when data lands. |
| Empty | The sub-view's own copy. An empty Trash is a **good** state and must not look like a failure. |
| Error | Distinct from empty, `role="alert"`, names the cause, offers retry. |
| Module off | **Its own state** — says an administrator turned it off, not that the box failed. |

The last two are the gap. **No sub-view renders an error state today**, so a fetch failure reads as
"nothing here" (WARP-1555 fixed the main browser only), and WARP-1627 is open because
`module_disabled` is conflated with a box failure — telling people something is broken when an
administrator simply switched it off.

Recents, Favorites, Trash and Shared are **library-scoped, not personal-only**. Each row carries its
owning library via the attribution that landed in WARP-1549 — consume it, do not re-derive it. Trash
adds `Deleted` / `Deleted by`; restore and purge are **scoped to the owning library** and a purge is
a `<ConfirmDialog>`, never a native confirm. Shared splits into `Shared with me` / `Shared by me` and
opens rows **in place** rather than linking out to raw Nextcloud.

Verbatim copy for every one of these states is in the packet's §9 and ships as written.

---

## 5. Constraints any Files frontend PR must satisfy

Restated here so a reviewer can check them without leaving the repo.

- **One level of nesting only.** Department → Team, full stop (ADR-029:306).
- **Visual nesting only — never a `mount_point` containing `/`.** The WARP-1254 spike proved writes
  to a synthetic intermediate segment silently land in the acting user's **personal** storage
  (`apps/orchestrator/src/routes/departments.ts:20`). The flat `<Dept> — <Team>` mount name is a
  data-boundary safety requirement, not a style choice.
- **Personal-root listing must keep hiding active dept mount names**, or every library appears twice
  (`files.ts:1476-1491`, `activeDeptMountNames` at `:334-372`).
- **Nextcloud is never read as truth and never a management surface** (ADR-029:47, :181, :203 →
  ADR-013). Rail contents come from Prisma via the orchestrator — `GET /api/files/spaces`.
- **`provisioning` / `failed` render as chips, never silent absence**; `failed` is owner/admin-only.
- **Reader posture stays honest** — writes visible-but-disabled with the locked tooltip. The
  verbatim strings at `app/files/page.tsx:65-69` (`READER_TOOLBAR_TOOLTIP`,
  `ADMIN_FOREIGN_LIBRARY_COPY`) are copy-locked.
- **No new design tokens** unless they land in `DropletByWarpLab/design-and-style` first — the drift
  gate is bidirectional (`__tests__/design-tokens.lock.test.ts`).
- **`--color-label-secondary` is `rgba(60,60,67,0.8)`, never `0.6`.** WARP-611 raised it because
  `0.6` measured 3.44:1 and failed AA. ⚠ `shared_brain content/brand/handoffs/dashboard/mockups/colors_and_type.css`
  still carries the stale `0.6` — it is June-era and was not refreshed with handoff 6. Source tokens
  from `globals.css` or `design-system/tokens/colors.css`, never from that mockup file.
- **No `window.confirm` / `alert` / `prompt`** — banned by `scripts/check-dashboard-classes.sh`. Use
  `<ConfirmDialog>` (WARP-291) and `toast()`.
- **Accessibility bar is `docs/projects-surface-design-brief.md` §5** — that document, not a general
  reading of WCAG 2.1 AA.
- **Every internal Files link goes through `buildFilesUrl(spaceId, spaceRelativePath(path, space.root))`.**
  Listing rows are home-relative and carry the mount; `?path=` is space-relative and gets re-prefixed
  server-side. Hand-rolling the querystring double-prefixes into a **silently empty folder with no
  error**. Assert the negative in a test — a test that only checks "a link exists" passes while the
  feature is dead.

---

## 6. What this addendum does not decide

- The backend contract behind **related chats / citations**. Nothing records which conversation had
  which file in context. The UI is specified; the index is not. Build against a typed empty state and
  file the contract as its own ticket.
- Whether the file index can answer **"count by facet under prefix"** cheaply. Recursive facet counts
  must not be a PROPFIND walk. If the index cannot, ship the chips without counts.
- Team sites, intranet pages, Lists (ADR-027 non-goal); arbitrary-depth hierarchy; anonymous "Anyone"
  links; the personal-home browser (WARP-1272 owns it).
