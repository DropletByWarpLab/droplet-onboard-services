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

**Done (10 commits on the branch):** foundation + Health; Tools; RAG Eval + Devices; Help;
Activity (`admin/claude-activity`); Remote Access; Home stub-data removal (Calendar wired
to `useCalendarEvents`, fake fallbacks dropped, Tasks/Activity/Scenes/Automations gated as
FR-001..004); chat (thinking indicator + hide single-model pill); Context; Knowledge.

**Remaining queue (do in this order):**
1. **Users** (`app/users/page.tsx`, ~791 LOC) — list + invite + TOTP/2FA dialogs. Keep the
   WARP-290 `/users/i` a11y contract.
2. **Calendar** (`app/calendar/*`) — re-skin month/agenda + rail, AND add the design's
   net-new features from chat2: color-coded synced calendars + legend, the iOS event-detail
   modal (Edit/Remove, scales to ≥30%/40vw of viewport), and Day/Week/Month **report**
   generation. Keep `useCalendarEvents/Sources` + CRUD.
3. **Events** (`app/events/*`, ~503 LOC) — tabs/cards/clip modals; keep semantic search,
   filters, pagination, retain/review.
4. **Tier-3 (each its own commit; Network is its own milestone):**
   - **Cameras** (+ sub-routes) — re-skin chrome, leave Frigate video/canvas.
   - **Settings** (`components/settings/*`, ~2.9k LOC).
   - **Files** (`components/FileManager/*`, ~3.5k LOC).
   - **Network** (`components/network/*`, ~10.8k LOC, 52 files, 7-tab WAI-ARIA tablist) —
     biggest; preserve tablist roles/keyboard + operation-confirm flows exactly.
- **Deferred polish:** chat full-layout indigo-surface restyle (thinking+pill done; page is
  already indigo-accented). Optional.

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
