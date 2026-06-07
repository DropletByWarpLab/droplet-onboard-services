# Indigo redesign — session handoff

Self-contained context to **continue** the Droplet web-dashboard indigo redesign in a
fresh conversation. Read this top to bottom, then resume at the next page in the queue.

## Goal

Implement the Claude Design "indigo, dark-first, chat-centered" redesign of the Droplet
web dashboard into the **real** Next.js app (`apps/web-dashboard`), wiring to the
**existing** endpoints, as a **single PR**, **page by page**.

## Design source (Claude Design handoff)

- URL: `https://api.anthropic.com/v1/design/h/UOqpXNNFoqfm_46NHH5hvA?open_file=Ask+AI.html`
- It is a **gzip archive**, not HTML. To read it:
  1. `WebFetch` the URL (any prompt) — it saves the binary to a `…/tool-results/webfetch-*.bin`.
  2. `cp` that `.bin` to `/tmp/design.gz`, then `cd /tmp && tar xzf design.gz`.
  3. Contents under `welcome-page/`: `README.md`, `chats/` (chat1.md, chat2.md — the full
     design conversation; **read these**), and `project/` (the HTML/CSS/JSX prototype:
     `colors_and_type.css`, `shell.css`, `board.css`, `chat.css`, `Sidebar.jsx`,
     page bundles `pages-workspace.jsx`/`pages-ops.jsx`/`pages-admin.jsx`,
     `page-knowledge.jsx`, `chat-page.jsx`, `context-charts.jsx`, etc.).
- The README says: read the chat transcripts (intent), read `Ask AI.html`, recreate
  pixel-faithfully in the target tech (don't copy prototype internals).

## Locked decisions (do NOT re-ask — reuse these)

1. **Re-skin, keep all features.** Restyle existing rich pages into the design's indigo
   look and keep every working feature wired to existing endpoints. Do not replace pages
   with the design's simpler mocks; do not drop functionality.
2. **Port + scope the design CSS.** Mirror the already-shipped `.droplet-home` precedent:
   bring the design CSS in scoped under a class, don't rewrite in the Tailwind `dp-*`
   system. The shared scope for secondary pages is `.droplet-shell`.
3. **No stubbed/hardcoded data.** Wire to the real endpoint. If none exists, hide the
   surface behind a **default-off** frontend feature flag (`src/lib/feature-flags.ts`,
   `NEXT_PUBLIC_FEATURE_*`) and log a feature request in `docs/feature-requests.md`
   (FR-00x with proposed endpoint + data structure). Never ship mock data as real.

## Working agreement

- **Continue autonomously, page by page; do not ask** unless you hit an error you can't
  investigate and fix yourself.
- Commit **per page** (clean, reviewable). Keep the working tree clean between pages.
- Proactively **checkpoint** before the context window is exhausted rather than starting a
  large page you can't finish — a half-converted committed page is worse than a clean stop.

## Branch + where things live

- Branch: **`WARP/trusting-austin-8462b9`** (off `main`). Work continues here for the single PR.
- App: `apps/web-dashboard` (Next.js 14, framer-motion, lucide-react, recharts, swr,
  react-markdown all already installed).
- **Foundation (built, do not rebuild):** `src/components/shell/`
  - `indigo-tokens.css` — `.droplet-shell` indigo token scope (light + `.dark .droplet-shell`).
  - `droplet-shell.css` — scoped port of the design's `shell.css` primitives
    (`.page-top` sticky, `.phead`, `.card`, `.kpi`, `.lrow`, `.badge`, `.meter`, `.bars`,
    `.toolbar/.search/.pills/.chip/.sw`, `.feed`, `.empty`, `.dl`, `.ava`, `.tabstrip`,
    `.k-*`, context-graph `.donut-*/.gbar-*/.gleg`, iOS sheet `.ds-ios-*`, `.ds-confirm-card`,
    entrance animations). Light-first; dark via `.dark .droplet-shell`.
  - `ShellPage.tsx` — page wrapper: `<div className="droplet-shell">` + `AmbientLayer` +
    slim sticky top bar with a **live device/health status chip** + centered animated
    `.page-inner`. Props: `icon`, `label`, `title?`, `sub?`, `actions?`, `ambient?`.
  - `primitives.tsx` — `Phead, Sect, Card, Kpi, Badge, Meter, Bars, Row, Feed, Toggle`.
- Indigo token reference (already shipped for Home): `src/components/home/home-bento.css`
  (`.droplet-home`), `AmbientLayer.tsx`, `widgets.tsx`, `bento-engine.ts`.
- Accent rebrand (atomic, done): `src/app/globals.css` (`--color-accent*` → indigo
  `#6366f1`/dark `#818cf8`, role-owner, aurora, shadow-hero), `src/lib/brand.ts`
  (`ACCENT_HEX`), `public/manifest.json`. Guard: `brand.theme-color.test.ts` (keep in sync).
- Feature flags: `src/lib/feature-flags.ts`. Feature requests log: `docs/feature-requests.md`.

## Status

**Done (foundation + Tier-1, earlier):** foundation + Health; Tools; RAG Eval + Devices;
Help; Activity (`admin/claude-activity`); Remote Access; Home stub-data removal (Calendar
wired to `useCalendarEvents`, fake fallbacks dropped, Tasks/Activity/Scenes/Automations
gated as FR-001..004); chat (thinking indicator + hide single-model pill); Context; Knowledge.

**Done (this batch — Users → Events + Cameras):**
- **Users** (`app/users/page.tsx`) — ShellPage + `.card/.rows/.lrow/.badge/.empty`. Kept
  WARP-217 invite flow, WARP-291 confirms, and the WARP-290 row-action a11y (p-2.5 +
  aria-labels + no opacity-0). Patched `users.invite.test.tsx`'s wholesale `@/lib/api` mock
  to add `fetchSystemHealth/fetchDevices/fetchHealth` (ShellPage status chip needs them).
- **Calendar** (`app/calendar/page.tsx` + `MonthView`/`AgendaView`) — ShellPage, `.toolbar`
  month-nav, `.pills` view toggle, per-source color legend (`.cal-legend/.cal-leg` + a new
  optional `colorOf` prop on the two views), the iOS `.ds-ios-*` event-detail sheet
  (Edit→EventForm, Remove→ConfirmDialog→deleteEvent; external events read-only), and a
  Day/Week/Month `.ds-rep-day` schedule report computed client-side from loaded events.
- **Events** (`app/events/page.tsx`) — ShellPage, `.tabstrip/.tab/.tcount`, `.search` +
  Semantic `.badge`, `.card/.empty/.btn` body states. Heavy cards/modals/filter bars kept.
- **Cameras index** (`app/cameras/page.tsx`) — ShellPage, sub-route nav → `.chiprow/.chip`,
  `.sect` Pinned/All headers, `.card/.empty` states. Heavy components kept. Branding-guard green.
- **Cameras People + Plates + Notifications** — ShellPage + back-button-in-actions pattern,
  `.card/.empty` states; kept all CRUD/ConfirmDialogs + aria-pressed toggles.

**Done (this batch — Cameras sub-routes):**
- **Cameras system** (`app/cameras/system/page.tsx`) — ShellPage + Server icon, back/refresh
  actions; top stat tiles → `Kpi`, detector/GPU/storage panels → `Card` + `Meter`, per-camera
  FPS table restyled with token colors. Kept 5s SWR refresh + WARP-291 tier-2 restart confirm.
- **Cameras settings** (`app/cameras/[name]/settings/page.tsx`) — ShellPage + Camera icon;
  `dp-card`→`.card`, sticky save bar → `.card`+`.btn primary/ghost`. Kept local-draft diff/PATCH
  save, ToggleRow/SliderRow, ZoneEditor/MotionMaskEditor (inherit indigo accent).
- **Cameras recordings** (`app/cameras/[name]/recordings/page.tsx`) — ShellPage + Video icon;
  date picker/hour-nav/export/segment-list cards → `.card`/`.btn`/`.icon-btn`. Kept HlsPlayer,
  RecordingsTimeline scrubber, seek-on-segment-click, clip export to Nextcloud.
- **Left immersive (untouched, by design):** `app/cameras/[name]/page.tsx`, `app/cameras/birdseye/page.tsx`.

**Done (this batch — Settings + Files):**
- **Settings** (`app/settings/page.tsx`) — Topbar→ShellPage; section headers → `Sect`,
  setting groups → `.card/.rows/.lrow`, status pills → `Badge`, buttons → `.btn`. Kept
  WARP-824 temp-password create-user, WARP-292 always-visible delete a11y, ConfirmDialog,
  and the Passkeys/Email/Logs/DangerZone sections. Patched the two settings tests'
  wholesale `@/lib/api` mock to add `fetchSystemHealth` for the ShellPage chip.
- **Files — all 7 routes** wrapped in ShellPage, heavy components kept as-is:
  - `files/page.tsx` (main browser) — Folder icon, New folder + Upload actions; new-folder
    dialog/detail-panel/buttons → `.card/.btn`. Kept SearchBar/BreadcrumbNav/UploadZone/
    FileRow/SelectionToolbar/PreviewPane/ShareDialog/ContextMenu/MoveCopyDialog + CRUD.
  - `files/favorites`, `files/recents`, `files/trash` — back-to-Files Link in actions,
    FileListSimple/TrashView kept.
  - `files/shared` — `.tabstrip` tabs, `.card/.empty/.rows/.lrow` body.
  - `files/devices` — Pair/Refresh actions, live paired-count subtitle, ClientDeviceCard/
    PairDialog kept.
  - `files/drives` — Topbar→ShellPage, DrivesPanel kept.

**Remaining queue:**
1. **Network** (`components/network/*`, ~10.8k LOC, 52 files, 7-tab WAI-ARIA tablist) —
   biggest; preserve tablist roles/keyboard + operation-confirm flows exactly. A newer,
   higher-fidelity handoff for the **managed-switch** Network add-on is at
   `~/Downloads/design_handoff_network_switch/` (port map / PoE / VLAN spec + standalone HTML ref).
- **Deferred polish:** chat full-layout indigo-surface restyle (thinking+pill done; page is
  already indigo-accented). Optional.

**Note:** the welcome-page design archive URL (in "Design source" above) now returns 404 —
the foundation is fully built, so it's no longer needed for re-skins; design intent for the
net-new Calendar features was implemented from the handoff queue description.

## The established per-page pattern (follow it)

1. Read the page + its main components and check `src/__tests__` for any test asserting its
   structure/classes/aria (preserve `role=`/`aria-*`/`data-testid`).
2. Replace the page's `Topbar`/bespoke chrome with
   `<ShellPage icon={<Icon size={15}/>} label="X" title="X" sub="…" actions={…}>`.
3. Map page-level markup to the ported classes (`.card`, `.kpi`, `.lrow`, `.badge`, `.btn`,
   `.search`, `.chip`, `.sect`, `.tabstrip`, `.empty`, iOS sheet `.ds-ios-*` /
   `.ds-confirm-card`). For heavy feature components (FileManager, network tabs, smart-home,
   chart widgets) **keep them as-is** — they inherit the indigo accent; only re-skin the
   page chrome + light containers. (Same as Devices/Context/Knowledge.)
4. Keep all SWR hooks/handlers/modals. No stubbed data (see decision 3).
5. Verify: page compiles (curl the route on the dev server), relevant vitest passes,
   `lint:dashboard-classes` clean. Commit.

Good reference commits to copy: Tools (`2c1307db`, interactive page), Knowledge
(`2f439cd1`, tabs + test-mock patch), Context (`710586b9`, framer-motion + charts),
Remote Access (`486e8972`, list/cards/dialogs).

## Gotchas

- **ShellPage test dependency:** wrapping a page in `ShellPage` pulls in the device/health
  chip → `useDevice` (calls `fetchDevices` + `fetchHealth`) and `fetchSystemHealth`. Any
  page-level test that `vi.mock("@/lib/api", …)` **wholesale** must add those 3 fns
  (see `src/__tests__/knowledge/knowledge-page.test.tsx`). Users/Calendar/Events have **no**
  page-level test in `src/__tests__/app`, so likely no patch needed there.
- **Dashboard-class guard:** `scripts/check-dashboard-classes.sh` bans 9 specific tokens
  (`type-caption`, `type-title` bare, `dp-button-*`, `border-warning`, …) and native
  `window.confirm/alert/prompt`. Use `type-*-N` only; use `ConfirmDialog` or the ported
  `.ds-confirm-card`, never native dialogs.
- **Pre-existing failures (baseline, not yours):** argon2-under-vitest, some a11y
  source-regex, tour/matter, and `chat-page.pending-prompt.test.tsx` (stale `@/lib/auth`
  mock missing `useAuth`). Verify a failure reproduces with your change stashed before
  treating it as new.
- **Bash cwd drifts** between calls in this environment — always `cd` with the **absolute**
  worktree path at the start of git/npm commands.
- **vitest:** run from `apps/web-dashboard` (absolute `cd`) or the `@/` alias won't resolve.
- **Worktree needs its own deps:** if `node_modules/.bin/next` is missing, run `npm install`
  at the worktree root first (~12s).

## Tools / skills to reuse

- `WebFetch` (fetch design) → `Bash` (`tar xzf` to extract the gzip bundle).
- `Agent` with `subagent_type: "Explore"` for codebase mapping; `"Plan"` to validate a
  large change before building. `AskUserQuestion` only for genuinely new blocking choices
  (the two above are already decided).
- `Bash` for the dev server (`npm run dev`, port 3001, run in background), `curl` to compile
  routes, `npx vitest run`, `npm run lint:dashboard-classes`, and git (commit per page).
- `Edit`/`Write`/`Read` for code. `mcp__ccd_session__mark_chapter` to mark phase shifts.
- Memory: a `project` memory `indigo-redesign` exists; keep it current.
- **Preview MCP** (`mcp__Claude_Preview__*`): can screenshot the dev server, but the
  authenticated pages need the orchestrator backend (DB/Redis) running, so live visual QA of
  protected routes isn't available without standing up the full stack — verification so far
  is clean compile + contract tests. Public `/login` does render.
- Optional design-quality skills if deeper polish is wanted: `impeccable` /
  `frontend-design` (UI craft), `design-motion-principles` (animation review).

## Verification commands

```bash
cd /Users/rjouffret/Projects/Droplet/droplet-onboard-services/.claude/worktrees/trusting-austin-8462b9
( ls apps/web-dashboard/node_modules/.bin/next >/dev/null 2>&1 || npm install )   # once per worktree
cd apps/web-dashboard && PORT=3001 npm run dev    # background; then: curl -s -o /dev/null -w "%{http_code}" localhost:3001/<route>
cd apps/web-dashboard && npx vitest run <test paths>
npm run --prefix apps/web-dashboard lint:dashboard-classes
```

## Pointers

- Plan: `~/.claude/plans/noble-sniffing-pond.md` (approved).
- Feature requests: `docs/feature-requests.md` (FR-001..004).
- Naming: name work explicitly + by WARP ticket, never "Phase N / ADR shorthand".
