# Droplet "Projects" — Native Design Handoff

To the designer: your single job is to design the Droplet **Projects** surface so it looks and behaves natively inside the existing dashboard — same shell, same tokens, same copy and safety contract as the other twelve surfaces. Projects replaces a broken embedded-Plane iframe with a household-owned project tracker (`/projects`) backed by an on-box native PM API. You have no access to the repo, so this brief is fully self-contained: every concrete spec — tokens, entities, screens, interactions, accessibility, copy, and the deliverables checklist — is below, with literal values, never a class name you would have to open the codebase to resolve.

---

## 0. How to read this brief (token layers, names, and what's already shipped)

Three things will save you from guessing:

**1. There are two token layers, and this surface uses both — but for different parts.** The dashboard has an outer **Tailwind/global layer** (the sidebar, the app chrome, page background) and an inner **shell layer** (every secondary page's body content, scoped under a `.droplet-shell` wrapper). They use *different variable names for the same indigo identity*. This brief always tells you **which layer** a value belongs to. When in doubt: the **sidebar nav entry** is Tailwind-layer; **everything inside the Projects page body** (cards, columns, KPIs, rows, chips, empty states) is shell-layer. The two layers are tuned to look identical — same indigo, same type, same dark mode — so a correctly-bound surface is visually seamless across the boundary.

**2. Class names in this brief are descriptive, not literal selectors you must reuse.** Where a concrete primitive exists, its real class is given verbatim (e.g. the shell card is literally `.card`, the shell KPI is literally `.kpi`). Where this brief describes a composition, treat it as *intent* — the engineer maps it to the real primitive. You never need repo access: every primitive you'd reference is reproduced below with its real class, real dimensions, and real token bindings.

**3. The sidebar slot is already shipped — do not redesign it.** The live sidebar already renders a **Projects** entry in the **Workspace** group, immediately after Calendar, using the lucide **`FolderKanban`** glyph. There is no slot debate to adjudicate and no glyph to choose. Design the entry to match the other Workspace items exactly (treatment spec in §1). The only thing changing behind that entry is the page it opens — from an embedded-Plane iframe to this native surface.

---

## Table of contents

1. [Overview](#1-overview) — what Projects is, why it replaces Plane, who it's for, goals, non-goals, and where it sits in the IA
2. [Design language & tokens](#2-design-language--tokens) — the real token contract (both layers), color/state/priority semantics, type, spacing, motion, icons, and the safety-chip rule
3. [Screens & components](#3-screens--components) — every view to design, field by field, with responsive behavior and per-view states
4. [Interactions](#4-interactions) — drag-to-transition, inline edit, rich text, optimistic updates, and the LLM/assistant tie-in
5. [Accessibility (WCAG 2.1 AA)](#5-accessibility--wcag-21-aa) — contrast, focus, targets, reduced motion, keyboard model
6. [Copy & tone (ADR-002)](#6-copy--tone-adr-002) — voice, verbatim copy examples
7. [Cross-viewport cohesion](#7-cross-viewport-cohesion-one-system) — one system across web/iOS/Android/Windows
8. [The safety chip on writes](#8-the-safety-chip-on-writes) — the non-negotiable write contract
9. [Deliverables checklist](#9-deliverables-checklist) — exactly what to produce

---

## 1. Overview

This package hands off **Projects** — a new first-class Droplet dashboard surface (`/projects`) that natively replaces the broken embedded-Plane iframe with a household-owned project tracker. It serves the promise **"one brain across every system"**: the projects, tasks and to-dos you track now live on the appliance you own, addressable from the same shell — and from chat — as files, cameras and network. It reuses the safety contract (§8), the RBAC model (§2.10), and the ADR-002 copy-tone rules (§6), and is built entirely on the existing dashboard primitives and tokens — no new tokens are introduced.

### Why this replaces Plane

The current `/projects` route embeds Plane CE in an iframe. Plane CE has no SSO, so the owner is bounced to a **second login** behind a box that promised **one identity** — and the iframe can never match the Droplet design system: it brings its own indigo-adjacent brand, its own typography, its own chrome, breaking the cohesion every other surface holds. The embed also can't honour the safety chips, the sidebar IA, or dark mode. This surface is the native replacement: same login, same shell, same tokens, backed by the on-box native PM API (ADR-026, `/api/pm/*`) so nothing leaves the LAN.

### Who it's for

The persona is the **non-technical owner/admin of a small business who owns the appliance** (ADR-002), addressed in second person. Projects are **household-shared, not per-user**: there is one seeded workspace (`home`), no per-user visibility filtering, and assignees/leads resolve to people in the existing directory. The owner wants to see what's in flight, move a card, and add a task in plain language — not to learn a project-management tool.

### Goals

- Give the owner a calm, native place to track work — projects, a kanban board, a list view, and task detail — that looks identical in light and dark to the other 11 surfaces.
- Cover the full set of entities the native PM API surfaces today: projects (with key prefix, lead, icon/colour, archive), the 5 seeded states, labels, work items (key `INBOX-42`, priority, assignees, labels, sub-issues, start/due dates), kanban drag, search/filter, transitions, and comments.
- Let the LLM create and update work items through the same confirmed-write path the owner uses, so chat-driven changes appear here natively with the **Write · confirm to apply** chip on every side-effecting action.
- Make every write honour the safety contract and log to Activity; every read stays on LAN.

### Non-goals

- **No Plane parity and no embedded Plane** — this is a replacement, not a wrapper; the iframe and any second login are removed.
- **No surfacing of schema-only entities.** Cycles/sprints, modules, custom properties and attachments exist as data models but have **no API** yet — do not design working UI for them, and do not expose a `cycleId` control on the work item (it is not patchable). The same applies to the **per-item activity history**, which is recorded server-side but has no read endpoint yet: no per-item history timeline until a route exists. (See §3.7, §3.8, and the §3.4 activity/attachments treatment for the designed-but-disabled placeholders.)
- **No multi-workspace UI.** Multi-home is schema-possible but not exposed; design for the single `home` workspace.
- **No per-user / private projects** — the model is household-shared by design.
- **No new tokens, no new design system, no Plane-style chrome.**

### Where it sits in the left-nav IA

Projects is a **top-level entry in the Workspace group** of the existing sidebar — the group that holds Home, Ask AI, Files, Email, Calendar, Knowledge, Context — sitting alongside the other things the owner *owns and works in*. **This entry already ships:** it lives immediately after Calendar with the lucide **`FolderKanban`** glyph. You are not choosing its slot or its icon — you are matching the established treatment so it reads as native to the other Workspace items.

**The shipped sidebar nav-entry treatment (Tailwind layer — match exactly):**
- The row is a flex link, `gap-3 px-3 h-9 rounded-lg`, type ramp `type-subheadline` (15px).
- **Inactive:** text color `--color-label-secondary`; hover adds `--color-surface-secondary` background and shifts text to `--color-label-primary`.
- **Active (on `/projects`):** background `--color-accent-subtle`, text `--color-accent`, weight medium (500).
- The glyph is rendered at **`size={17}`**, `strokeWidth` **1.5 inactive / 2.0 active** — the same scale as every other nav row. (Note: the `22px` figure you may have seen elsewhere is the brand wordmark `DropletMark` in the sidebar header, *not* the nav glyphs. Nav glyphs are 17px.)
- The entry carries **no count badge** — the live nav-item model has no count field, so do not design an unread/assigned-count pill on the sidebar entry.

The surface itself is built on the shell page wrapper (the `ShellPage` component used by Cameras, Files, Network) and its page-header primitive — both reproduced in §3.

### High-level surface map

Four views, all under `/projects`:

1. **Projects index** (`/projects`) — the landing view: a grid of project cards (icon/colour, name, key prefix, lead, open-item count, archived state), a primary **New project** action, and an archived filter. Empty state when no projects exist yet.
2. **Board** (`/projects/[identifier]`) — the default project view: a kanban of the project's state columns (the 5 seeded groups — Backlog / Todo / In Progress / Done / Cancelled — plus any custom states), cards draggable between columns via the float `sortOrder`, with a state/assignee/label/priority filter rail.
3. **List** (`/projects/[identifier]?view=list`) — the same work items as a dense, keyboard- and screen-reader-friendly table (key, name, state, priority, assignees, labels, due date); the mobile layout defaults here.
4. **Work-item detail** (`/projects/[identifier]/[key]`, e.g. `INBOX-42`) — a dedicated route (not a throwaway dialog) for one work item: title, description, state/priority/assignee/label/dates, sub-issues with counts, and the comment thread. State changes route through `transition`; every edit renders its safety chip. Reachable also as a right slide-over from board/list for fast triage (see §3.4).

A lightweight **New project** / **New work item** create flow is built on the canonical `Dialog` primitive (see §3.5 for its real props), not a hand-rolled modal.

---

## 2. Design language & tokens

This surface is **token-driven, not token-defining.** Every color, type ramp, space, radius, shadow, easing, and icon below already exists in the Droplet dashboard's two token layers. Projects must look native to the existing twelve surfaces (home/chat/files/email/cameras/network/devices/tools/activity/people/models/settings), so **bind to these variables — do not invent new ones.** No new hex values, no new `--font-*`, no new type step, no new shadow recipe, no second easing curve. The values below are the *real* ones, transcribed from the live stylesheets. Where a PM concept seems to need a token that isn't here, reuse the closest existing one (the mappings below cover every case); a genuinely missing token is a question for the design owner, not a value to coin.

### 2.0 The two layers, named

| Concept | **Shell layer** (the Projects page body, scoped under `.droplet-shell`) | **Tailwind layer** (the sidebar entry + app chrome) |
|---|---|---|
| Brand / accent | `--brand` `#6366f1` (dark `#818cf8`) | `--color-accent` `#6366f1` (dark `#818cf8`) |
| Accent hover | `--brand-hover` `#4f46e5` (dark `#6366f1`) | `--color-accent-hover` `#4f46e5` (dark `#a5b4fc`) |
| Accent soft fill | `--brand-subtle` `rgba(99,102,241,0.12)` (dark `rgba(129,140,248,0.15)`) | `--color-accent-subtle` `rgba(99,102,241,0.10)` (dark `rgba(129,140,248,0.15)`) |
| Page background | `--bg` `#f5f6fb` (dark `#0f1117`) | `--color-surface-secondary` `#f2f2f7` (dark `#1c1c1e`) |
| Card / panel surface | `--card-bg` `#ffffff` (dark `#14161d`); `--surface` `#ffffff` (dark `#1a1d27`) | `--color-surface-primary` `#ffffff` (dark `#000000`) |
| Secondary surface (input/track fill) | `--surface-2` `#eef0f7` (dark `#1f2937`) | `--color-surface-secondary` |
| Card border | `--card-bd` `rgba(20,22,45,0.08)` (dark `rgba(255,255,255,0.055)`) | `--color-separator` `rgba(60,60,67,0.12)` (dark `rgba(84,84,88,0.65)`) |
| Border / divider | `--border` `#e4e6f1` (dark `#2a2d3a`) | `--color-separator` |
| Primary text | `--text` `#1b1e2b` (dark `#e4e4e7`) | `--color-label-primary` `#000000` (dark `#ffffff`) |
| Muted text | `--text-muted` `#6b7180` (dark `#8a8a94`) | `--color-label-secondary` `rgba(60,60,67,0.8)` (dark `rgba(235,235,245,0.8)`) |

**The Projects page body is shell-layer.** Bind cards, columns, KPIs, rows, chips, badges, and empty states to the `--brand` / `--surface` / `--text` family. The **sidebar entry** (already shipped) is Tailwind-layer (`--color-accent` family). Both re-map every variable under dark mode, so a correctly-bound surface is automatically dark-complete (light **and** dark are both required — never light-only).

### 2.1 System / status colors (shared, both layers)

These hexes are identical across layers (`globals.css` defines them; the shell consumes the same values):

- red `--color-system-red` `#ff3b30` → dark `#ff453a` — destructive, error, urgent priority.
- orange `--color-system-orange` `#ff9500` → dark `#ff9f0a` — warning, high priority, overdue.
- green `--color-system-green` `#34c759` → dark `#30d158` — completed/healthy/ok.
- blue `--color-system-blue` `#007aff` → dark `#0a84ff` — info, links, pending-not-error states.

**Status badge primitives (shell-layer, real `.badge` variants — these are the only canonical status soft-fills):**

| Badge | Background tint (literal) | Label color (light → dark) |
|---|---|---|
| `.badge.ok` | `rgba(34,197,94,0.14)` | `#15803d` → `#4ade80` |
| `.badge.warn` | `rgba(217,163,92,0.16)` | `#b45309` → `#e6b873` |
| `.badge.danger` | `rgba(239,68,68,0.15)` | `#b91c1c` → `#fca5a5` |
| `.badge.info` | `--brand-subtle` | `--brand` → `--brand-soft` |
| `.badge.muted` | `--inset` `rgba(17,19,32,0.04)` (dark `rgba(255,255,255,0.04)`) | `--text-muted` |

Use these `.badge` variants for state/status pills. The ink hexes above are the **real** badge-label colors baked into the primitive; you do not hand-mix chip ink, and you do not introduce `#15803d`/`#b45309`/`#b91c1c`/`#1d4ed8` as standalone "chip ink" tokens — they exist only as the label color *inside* these badge variants, paired with their specific tint. (Important AA note: this is for **status badges**, where the tint+ink pair was tuned for contrast. The **safety chip** in §8 is a different component with a different, stricter ink rule — see §2.9.)

### 2.2 Aurora (AI moments only)

Aurora (`--aurora-1` `#c7d2fe` / `--aurora-2` `#e0e7ff` / `--aurora-3` `#fecdd3` / `--aurora-ink` `#3730a3`; dark variants are deep violets) is reserved for premium AI moments and the chat capsule — **Projects does not use aurora on the board itself.** Reach for it only for AI-authored content (an LLM-authored comment, an AI attribution avatar) or a generative PM card rendered inside chat — never on the kanban board.

### 2.3 State-group → color semantics (the PM mapping)

A state's color comes from its **`group`**, not its name, so custom states stay coherent. Each seeded state ships a literal `color` hex (use it for the state dot / column accent). The group also drives which status badge a work item's state pill uses:

| `group` | Seeded state | Dot color (literal, from API data) | State pill (shell `.badge` variant) |
|---|---|---|---|
| `backlog` | Backlog | `#94a3b8` | `.badge.muted` (muted tint, `--text-muted` label) |
| `unstarted` | Todo *(isDefault)* | `#6366f1` | `.badge.info` (`--brand-subtle` / `--brand`) |
| `started` | In Progress | `#f59e0b` | `.badge.warn` (`rgba(217,163,92,0.16)` / `#b45309`) |
| `completed` | Done | `#22c55e` | `.badge.ok` (`rgba(34,197,94,0.14)` / `#15803d`) |
| `cancelled` | Cancelled | `#ef4444` | `.badge.danger` (`rgba(239,68,68,0.15)` / `#b91c1c`) |

**Read this carefully — two distinct things per row:**
- The **dot** renders whatever literal `color` the API returns for that state (the hexes shown are the seeded defaults; they are **data, not tokens** — never hard-code them, render the API value).
- The **pill** is a real shell `.badge` variant chosen from the closed five-value `group` enum (`backlog | unstarted | started | completed | cancelled`). The pill's tint+ink are the badge primitive's, not the dot's hex.

So a cell is: live-data dot hex + group-derived `.badge` variant. They are different sources by design.

### 2.4 Priority → color + icon semantics

`priority` is the enum `urgent | high | medium | low | none`. Use lucide glyphs at stroke 1.5 (2.0 when the row/card is the active selection), size 14–16, color from the system token below. No invented priority palette — these reuse the system ramp:

| `priority` | Color (token) | lucide icon | Note |
|---|---|---|---|
| `urgent` | `--color-system-red` `#ff3b30` | `AlertOctagon` (or filled signal) | red is reserved — urgent is the only non-destructive red on this surface |
| `high` | `--color-system-orange` `#ff9500` | `SignalHigh` / `ChevronsUp` | |
| `medium` | `--brand` `#6366f1` | `SignalMedium` / `Equal` | |
| `low` | `--text-muted` | `SignalLow` / `ChevronDown` | muted, not colored |
| `none` | `--text-faint` `#a6aab5` (dark `#3f3f46`) | `Minus` | lowest visual weight |

### 2.5 The work-item key — mono, always

The computed `key` (`${identifier}-${sequenceId}`, e.g. `INBOX-42`) is an identifier and **must render in `--font-mono`** at caption size (11–12px), `--text-muted`. The shell `--font-mono` is **`ui-monospace, "SF Mono", Menlo, Consolas, monospace`** — there is no JetBrains Mono in this system; do not name or assume it. Same rule for any other machine string the surface shows: ISO dates/timestamps, IDs, paths, and `kbd` hints. Human strings — work-item name, project name, state name, label name, person name — use `--font-ui` (the Inter-anchored UI stack). Lead with the human label, key as a quiet mono secondary (ADR-002).

### 2.6 Typography

- `--font-ui` — the UI stack (`var(--font-inter), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`). All UI text.
- `--font-mono` — `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. Keys, dates, identifiers, `kbd`.
- **Display serif** — Instrument Serif, available via the `.type-display` / `.type-display-italic` utilities (Tailwind layer, `font-family: var(--font-display), "Instrument Serif", Georgia, serif`). This is reserved for *premium hero display* moments and is **not** part of the shell KPI primitive. **Projects KPIs do not use the serif** — the shell KPI value (`.kpi .v`) is the UI font at **28px / 700**, tabular-nums (see §2.7). Only reach for the serif if you are intentionally building a hero display number, and flag that divergence to the design owner; the default for every Projects stat is the 28px UI KPI.

**Type ramp (real `type-*` steps, Tailwind layer — do not add a step):**

| Step | Size / line / weight |
|---|---|
| `type-title-1` | 28 / 34 / 700 |
| `type-title-2` | 22 / 28 / 700 |
| `type-title-3` | 20 / 25 / 600 |
| `type-headline` | 17 / 22 / 600 |
| `type-body` | 17 / 22 / 400 |
| `type-callout` | 16 / 21 / 400 |
| `type-subheadline` | 15 / 20 / 400 |
| `type-footnote` | 13 / 18 / 400 |
| `type-caption-1` | 12 / 16 / 400 |
| `type-caption-2` | 11 / 13 / 400 |

**Shell page header** (the `Phead` primitive) renders its H1 at **30px / 700, letter-spacing −0.5px**, with the subtitle at 15px `--text-muted` (max-width 60ch). This is the real header — bind to it; there is no separate `.page-h1` class. Typical Projects usage: board column header / project title `type-title-3` (20/600); work-item card name `type-subheadline` (15/400–500); card meta + key at 11–12px mono. Section labels use the shell `.sect` header (13px / 600 / `--text`). Sentence case everywhere.

### 2.7 The real shell primitives you will compose with

These are reproduced verbatim so you never need the repo. All are scoped under `.droplet-shell` (the Projects page body).

- **`.card`** — `background: --card-bg; border: 1px solid --card-bd; border-radius: 16px; padding: 18px`. **Flat at rest — no resting shadow.** Add `.card.hover` for an interactive card: on hover it lifts (`transform: translateY(-2px)`, border shifts toward `--brand`, box-shadow `--lift`). The work-item card and project card are `.card.hover`. **Do not give cards a resting shadow** — every shell surface is flat-bordered at rest; the lift appears only on hover/drag.
- **`--lift`** — the canonical card/drag-lift shadow: `0 18px 40px -16px rgba(30,30,60,0.22), 0 0 0 1px rgba(99,102,241,0.25)` (dark variant deeper). Use `--lift` for the dragged-card lift and the drawer elevation. This is the *only* card shadow token; there is no `--shadow-sm` / `--shadow` / `--shadow-lg`.
- **`.kpi`** — `background: --card-bg; border: 1px solid --card-bd; border-radius: 14px; padding: 16px 18px`. Children: `.k` (eyebrow — 11px, `0.08em`, uppercase, `--text-muted`), `.v` (the big number — **28px / 700, tabular-nums, `--text`**), `.d` (dotted note — 12px `--text-muted`, with an optional colored `.dot`). The Projects summary strip is a row/grid of `.kpi` tiles. The big number is **28px UI font**, not a serif and not 44px.
- **`.lrow`** — the list row: flex, `gap: 13px; padding: 12px 2px; min-height: 40px`. Inner: `.ri` (34px rounded icon), `.rt` with `.nm` (13.5px/500 title) + `.sub` (12px muted, `.sub.mono` for mono), `.rmeta` (12.5px muted, `.rmeta.mono`), `.rval` (15px/600 tabular). Rows live inside `.rows` (which draws `1px --card-bd` dividers between children). The List view is built from `.rows` + `.lrow`.
- **`.chip` / `.chiprow`** — chip: `height: 32px; padding: 0 13px; border-radius: --radius-pill; background: --card-inner; border: 1px solid --card-bd; 13px --text-muted`. Active state is **`.chip.on`** (`--brand-subtle` bg, accent border, `--brand` text). `.chiprow` is the flex wrap container. The saved-view sub-nav and filter chips are `.chip` / `.chip.on`.
- **`.pills`** — the segmented control: an inline-flex track (`--surface` bg, `--border`, `radius 10px`, 3px pad) of `button`s; the active button is `.active` (`--brand-subtle` bg, `--brand` text). The Board/List/Cycles/Modules view switcher and the "Group by" control are `.pills`.
- **`.tabstrip` / `.tab` / `.tcount`** — an underline tab rail (42px tall tabs, `.tab.active` = `--brand` text + 2px `--brand` underline; `.tcount` is the mono count pill). Use this **or** `.pills` for the in-page view switcher — pick one and use it consistently; both are real. (There is no `.sw-seg` class — do not reference it.)
- **`.search`** — the search field: `height: 38px; min-width: 220px; max-width: 360px; border-radius: 10px; --surface bg; 1px --border`; focus-within shifts the border toward `--brand`. The command/search bar is `.search` (there is no `.field-search`).
- **`.empty`** — the empty/error block: centered column, `.ei` (52px rounded `--brand-subtle` icon badge), `.eh` (16px/600 `--text` heading), then a muted body line. Every empty/loading/error state uses `.empty` inside a `.card`.
- **`.btn` / `.btn.primary` / `.btn.ghost` / `.btn.danger` / `.btn.sm`** — 36px-tall buttons (`.btn.sm` = 30px). `.btn.primary` is `--brand` fill, white text, `--brand-hover` on hover. **White text on `--brand` (`#6366f1`) is the AA-verified primary pair.**
- **`.icon-btn`** — 36×36 icon button (`--surface` bg, `--border`, `--text-muted` → `--text` on hover). Refresh, kebab, column `+`.
- **`.sw`** — the toggle switch (38×22, `--brand` when `.on`). The project Archived toggle.
- **`.badge`** — the status pill (§2.1 variants).
- **`.ava`** — 34px round avatar (`--brand-subtle` bg, `--brand` initials). Assignee/lead avatars.
- **`.sect`** — section label row (13px/600 `--text` heading + muted `.sx` count). Column headers and group headers.

**Radii (real, shell layer):** `--radius-input` **8px** (buttons, inputs, small chips on cards) · `--radius-card` **12px** (the `.kpi` uses 12–14px) · `--radius-pill` **999px** (status/label/priority pills, filter chips, avatars, the toggle). The **`.card` radius is a literal `16px`** baked into the primitive (there is no `--radius-lg`/`--radius-xl`/`--radius-sm` variable — those names don't exist). When you spec a work-item card or board column, say "the `.card` 16px radius," not a phantom token.

**Shadows (real):** the only card-level shadow is **`--lift`** (hover + drag). The Tailwind layer additionally has `--shadow-tile` and `--shadow-hero`, but those belong to the premium Home tiles and the chat capsule respectively — **Projects uses neither.** There is no `--shadow-sm` / `--shadow` / `--shadow-lg`. Cards are flat at rest.

### 2.8 Motion / easing

There is one shell easing curve and one set of inline durations — both are *values*, not custom-property tokens you can reference by a `--duration-*` name (no such variables exist).

- **Shell easing** — `--ease`: `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quint: snappy start, soft settle). This is the curve the shell primitives animate on (card hover, meters, chips, the entrance `ds-rise`). **Bind all Projects-body motion to `--ease`.**
- **Durations** — the shell primitives use inline `120–240ms` (e.g. card hover transitions `200–240ms`, button press `120ms`). Treat **200ms** as the "fast" interaction (drag lift/drop, pending-card flip) and **240–250ms** as the "default" (drawer slide, column reflow). These are literal millisecond values applied inline; do not invent `--duration-default` / `--duration-fast` tokens.
- **(Aside on the Tailwind layer:** the sidebar entry and other chrome animate on the Tailwind `ease-smooth` utility, which is `cubic-bezier(0.25,0.1,0.25,1)` at `duration-200`. That's a *different* curve from the shell `--ease`. You don't need it inside the Projects body — bind the body to `--ease`. It's noted only so you recognize the sidebar's motion isn't a mistake.)*
- **No springs, bounces, parallax, or spinner theatrics.** Honor `prefers-reduced-motion: reduce` — it disables all motion (skeletons hold, transitions cut to instant). See §5.4. The `sortOrder` Float lets cards re-insert without renumbering — animate the move, don't restack the whole column.

### 2.9 Iconography

`lucide-react`, `currentColor`, stroke **1.5 default / 2.0 active**, sizes 13–22 (13–14 row/card meta, 16–18 inline/header, 20–22 page/section). The Projects **sidebar entry already uses `FolderKanban` at `size={17}`** (1.5 / 2.0 active) and the active state is `--color-accent-subtle` fill + `--color-accent` text, weight 500 — match the other Workspace nav rows exactly (§1).

### 2.10 Safety-chip rule (non-negotiable)

Projects is a **write surface**: creating/editing/deleting projects, states, labels, work items, transitions, and comments all hit role-gated `owner|admin|family` routes (some also via the MCP service principal). **Every assistant-proposed/confirmable write renders the safety chip, and the backend must not execute the side effect until the user confirms.** The chip is the **shipped 2-tier `SafetyChip` component** — its tiers and exact strings are fixed (do not reword, do not add a tier):

- **`Read · stays on LAN`** — the read tier; loads, board views, searches (run immediately, logged `read`).
- **`Write · confirm to apply`** — the write tier; proposed create/edit/transition/comment carry accept + reject and a pending state; backend executes on accept, logged `write · ok` / `write · cancelled`.

**There is no third "Build" tier on this surface** — the live component is two tiers (`Read` / `Write · confirm`) and Projects has no build-class action, so do not design a `Build · reversible` chip here.

**The chip's AA construction (this is load-bearing — match it):** the chip renders its **label in `--color-label-primary`** (high contrast) and uses color *only* on the icon and a faint background tint (`bg-system-green/15` for Read, `bg-system-orange/15` for Write). It does **not** color the chip text — the shipped component comment is explicit that tinted text fails AA at caption size. So: green-tinted pill + `Eye` icon + black/white label for Read; orange-tinted pill + `Pencil` icon + black/white label for Write. Do not put colored ink on the chip label.

Destructive ops (project/state/label/work-item delete) route through the confirm dialog with a destructive (red, `#ef4444`) treatment and the safety chip in the dialog's accessory slot; the backend stays inert until Confirm. Pending/proposed states use **info/blue, never red** — red is reserved for destructive and urgent only. Never imply a write happened before it's confirmed. The full tier-by-tier contract, including direct-edit vs assistant-proposed behavior and RBAC inheritance, is in §8.

### 2.11 RBAC

All **reads are Read tier** — they run automatically, no confirm. All **writes require owner/admin/family**; **member/viewer/guest see every view read-only** — the header create/edit actions, drag handles, the create-modal trigger, and inline state pickers are hidden (not disabled-with-error) for them. Every applied write logs an Activity row `write · ok`. Effective ability = role default ∧ resource scope. The assistant's writes are admitted via the MCP service principal but still render the Write chip and confirm (§8).

---

## 3. Screens & components

This section enumerates every view to design. Every view is wrapped in the shell page wrapper (`ShellPage`: takes `icon` + `label="Projects"` for the slim top bar, and optional `title` / `sub` / `actions` for the big page header `Phead`). The page body renders inside `.droplet-shell` with the `.page-inner` content column (max-width ~1160px). Build from the real primitives in §2.7 — no new tokens, no pasted prototype.

**Promise served:** *Memory that's actually yours* — the household's work, indexed and owned on the appliance — and *Chat is the way in* (the same LLM that runs the `pm_*` write tools dispatches through these very routes, so any card the model proposes renders here as a confirmable Write).

**Persona/voice:** sentence case, no emoji, no exclamation marks, em-dashes for asides, middle-dots (`·`) as separators. Lead with the human label, keep ids/keys in `--font-mono` (the work-item `key` `INBOX-42`, project `identifier`, dates as ISO when shown raw). Never blame the user in empty/error copy. (Full copy rules in §6.)

**Data binding (engineer-facing; you don't need the repo, but it pins what's real):** every view reads from `/api/pm/*` via per-domain data hooks (projects, work-items, states, labels, single work-item, comments), each with a polling refresh (lists ~20s, a focused detail ~15s). Responses are envelope-keyed: `{ projects }`, `{ work_items }`, `{ work_item }`, `{ states }`, `{ comments }`, deletes `{ deleted }`. **Wire ↔ model naming:** the wire uses snake_case (`description_html`, `state_id`, `start_date`, `due_date`, `label_ids`, `comment_html`, `parent_id`, `per_page`); the client model exposes camelCase (`descriptionHtml`, `stateId`, `startDate`, `dueDate`, `labels`, `commentHtml`, `parentId`). When this brief shows a snake_case field it's the request/response wire; the camelCase form is the same field on the read model. User ids (`leadId`, `assignees[]`, `authorId`, `createdById`) are plain user-id strings — resolve to names/avatars via the existing people directory; never scope reads by user (the workspace is household-shared).

**RBAC (§2.11):** all reads run automatically, no confirm. All writes require **owner/admin/family**; **member/viewer/guest see every view read-only** — header create/edit, drag handles, the create-modal trigger, and inline state pickers are hidden (not disabled-with-error). Every applied write logs an Activity row `write · ok`.

---

### 3.1 Projects home / index (`/projects`)

**Purpose** — the launchpad/switcher across all projects in the seeded `home` workspace, plus an at-a-glance summary strip. A list, not a single-project board.

**Layout** — `ShellPage` with `title="Projects"`, live `sub` (`${projects.length} project${…} · ${openCount} items open`), header `actions` = primary `.btn.primary` + `Plus` (size 15) "New project" (owner/admin/family only) and an icon-only `.icon-btn` + `RefreshCw` (spinning while refreshing).

1. **Summary strip** — a grid of 3–4 `.kpi` tiles (`.k` eyebrow / `.v` 28px tabular number / `.d` dotted note): *Active projects* · *Items open* (sum where `state.group ∈ {backlog,unstarted,started}`) · *Done this week* (`completedAt` within 7d) · *Overdue* (`dueDate < now` and not terminal — rendered with the orange `.d .dot` set to `--color-system-orange`, never red, since "overdue" is a soft state). Numbers are derived client-side from the work-items the cards already summarize. **Two distinct unloaded states, don't conflate them:** while the underlying work-items list is still loading, the `.v` shows a thin skeleton bar (not `0`); once loaded and genuinely zero, the `.v` shows `0`. A `0` must mean "loaded and empty," never "still loading."
2. **Project grid** — a responsive grid (`.grid.c3` → 2-up at `sm` → single column on mobile, 16px gap). Each cell is a **project card** built on `.card.hover` (made a keyboard-activatable button: `role="button" tabIndex={0}`, the shell `:focus-visible` ring), routing to `/projects/${identifier}` on activate.

   **Project card contract** — `{ icon, color, name, identifier (key prefix), lead, openCount, doneCount, archived }`:
   - Top row: a 28–30px rounded (`--radius-input` 8px) swatch tinted with the project `color` (fallback `--brand-subtle`) holding the `icon` glyph (lucide name or monogram of `name`); then the `name` as `type-subheadline` / `--text` / medium, truncated; and a mono `.chip` showing the `identifier` (e.g. `INBOX`).
   - Meta row: 12px `--text-muted` — resolved `lead` name (or "No lead") · `${openCount} open` · `${doneCount} done`.
   - Footer: a thin per-state spark of counts (backlog→completed) using the shell `.bars` mini-chart vocabulary, plus an `.badge.muted` "Archived" pill when `archived === true`.
3. **Switcher affordance** — the slim top bar's device health chip (`.pt-chip`) stays as-is. There is a single `home` workspace; do not render a workspace picker.

**Content/fields** — strictly from the project model: `name`, `identifier`, `description` (shown as the card's `title`/tooltip), `icon`, `color`, `leadId`→resolved, `archived`. Derived counts from the project's work-items. `archived` projects hidden by default; a "Show archived" `.chip` toggle in a `.chiprow` flips the archived filter.

**Responsive** — desktop 3-up; `sm` 2-up; mobile single column, summary strip wraps to a 2×2 KPI grid then stacks. Cards full-width on mobile, keyboard-navigable in DOM order.

---

### 3.2 Board view (`/projects/[identifier]` — default tab "Board")

**Purpose** — the Kanban for one project; columns are the project's workflow states, drag-to-transition.

**Layout** — `ShellPage` `title={project.name}`, `sub` = live `${openCount} open · ${doneCount} done`, header `actions` = primary "New item" (`Plus`), refresh `.icon-btn`, and a view switcher (Board · List · Cycles · Modules) built as a `.pills` segmented control (or the `.tabstrip` tab rail — pick one and keep it consistent across the four views). Directly under the header: the **filter/command bar** (§3.9) and a `.chiprow` sub-nav of saved views.

- **Board surface** — a horizontal `flex` rail (gap 16px, `overflow-x: auto`) of **columns**, one per state ordered by `sortOrder`. Each column:
  - **Column header** — a `.sect`-style row: a state-`color` dot (render the live `color` from the state; the seeded fallbacks are `backlog #94a3b8`, `unstarted #6366f1`, `started #f59e0b`, `completed #22c55e`, `cancelled #ef4444`), the state `name` as the `.sect` heading, a `.sx` count, and a quiet `+` `.icon-btn` (owner/admin/family) that opens the create modal pre-set to this `stateId`.
  - **Cards** — a vertical stack of **work-item cards** on `.card.hover` (14px pad, the `.card` 16px radius), draggable.

   **Work-item card contract** — from the work-item model:
   - Top line: mono `.chip` `key` (`INBOX-42`) · a **priority** glyph/chip (color + lucide signal per §2.4; `none` hidden) — priority is a small left-edge accent, never shouted.
   - Title: `type-subheadline` / `--text`, 2-line clamp (`.clamp2`).
   - Label row: `labels[]` as small (11px) `.chip`s tinted by each label `color` (overflow collapses to `+N`).
   - Foot row: assignee `.ava` avatar stack (resolved from `assignees[]`; "Unassigned" ghost circle when empty) · a due-date chip (mono date; use `.badge.warn` orange when past and the item is not terminal, `.badge.info` blue when upcoming — never red) · footnote counts `subItemCount` (branch glyph) and `commentCount` (message glyph) when > 0.
  - **Drag-to-transition** — dropping into a column fires `POST /api/pm/work-items/:id/transition { state_id }` (the route that runs the `completedAt`-stamping logic), and reordering within a column patches the **Float** `sortOrder` (insert-between, no renumber). Because a transition is a side-effecting write, an **assistant-proposed** move shows a pending card with the **`Write · confirm to apply`** chip until confirmed; a **direct human drag** is the user's own confirm and writes optimistically (card lands instantly, snaps back on reject — the snap-back is a ~200ms `--ease` transition). Reads (the board itself) carry no chip. Full drag mechanics in §4.1.

**Responsive** — desktop: all columns visible, horizontal scroll past ~4. Tablet: columns ~280px, scroll. Mobile: replace drag with **one** affordance — a per-card state picker popover (tap the card's state pill → choose the target state → transition). Do **not** also describe an accordion as a second mechanism; the mobile board is a vertical stack of cards grouped under collapsible `.sect` state headers, and the state picker is the only move affordance. Reduced motion disables the drag-lift and the pending-card transition.

---

### 3.3 List view (`/projects/[identifier]?view=list`)

**Purpose** — dense, sortable, groupable table of the same work items for triage. This view is also the screen-reader-equivalent of the board and the default mobile layout.

**Layout** — same `ShellPage` / view switcher / filter bar; body is `.rows` of `.lrow` rows under collapsible `.sect` group headers. A `.pills` "Group by" control (State · Assignee · Priority · None) and a sort affordance (column-header click → `sortOrder` | `dueDate` | `priority` | `updatedAt`, asc/desc) live in the filter bar.

**Row contract** (`.lrow`) — `{ key (mono, in .sub.mono), state dot+name, title (.nm), priority chip, assignee avatars, labels, dueDate (.rmeta.mono), updatedAt }`. Clicking a row opens the **detail slide-over** (§3.4) — not a navigation — matching the cameras "row → drawer" affordance for fast triage; the mono `key` is a deep-link to the full page.

- **Group headers** — `.sect` with the group name + `.sx` count; "Group by State" follows state `sortOrder`; "Group by Assignee" resolves ids to names with an "Unassigned" trailing group; "Group by Priority" orders `urgent→none`.
- Inline edits permitted for owner/admin/family: clicking the state dot opens a small state menu (transition), the priority chip cycles via a popover — each an immediate Write (no confirm card for these low-risk single-field PATCHes, but the change still writes an Activity row).

**Responsive** — desktop: full row, all columns. Mobile/screen-reader: this denser table **is** the mobile layout — collapses to two lines (key+title / state·assignee·due), labels truncate to `+N`. Fully keyboard-navigable (roving tabindex over rows, Enter opens the drawer).

---

### 3.4 Work-item detail — slide-over drawer AND full page

**Purpose** — the complete record for one work item, reachable two ways: a **right slide-over** from board/list (fast, keeps context) and a **full page** (`/projects/[identifier]/[key]`, deep-linkable, for focused work). Both render the same detail body; the drawer wraps it in the canonical **`Dialog`** with `placement="right"` and `maxWidth="lg"` (portal, focus-trap, Escape, scroll-lock, returns focus to the trigger, respects reduced motion, edge-to-edge `border-l border-separator`); the full page renders it in a narrow centered column (~880px).

**Data** — the single-work-item hook → `GET /api/pm/work-items/:id` (refresh ~15s) + the comments hook → `GET /api/pm/work-items/:id/comments`.

**Layout (top → bottom):**
1. **Header** — mono `key` (`INBOX-42`) + a state pill (color dot + name, click → transition menu; the `completedAt` logic runs server-side) + a kebab `.icon-btn` (Edit, Copy link, Delete via the destructive confirm dialog). `name` as `type-title-2` (22/700), editable-in-place for writers.
2. **Description** — rich-text rendered from `descriptionHtml` (sanitized); an editable Tiptap region for writers (saves to `description_html` via PATCH; see §4.3). Empty → calm `.empty`-style line "No description yet."
3. **Properties rail** — a `.card` of labeled rows (label at `type-footnote` `--text-muted` + value): **State** (picker → transition), **Priority** (`urgent|high|medium|low|none` picker), **Assignees** (multi-select of resolved users; full-set replacement on save), **Labels** (multi-select label chips tinted by `color`; full-set replacement), **Start date** / **Due date** (date pickers → `start_date`/`due_date`, mono display, ISO on wire), **Created by** (resolved `createdById`, read-only), **Completed** (`completedAt` if terminal, read-only).
4. **Sub-issues** — list of children (`subItemCount`; fetched by parent filter), each a mini work-item row. States to design, all of them:
   - **Populated** — the child rows + an "Add sub-issue" affordance (writers only) that creates a child with `parent_id` set.
   - **Empty** — "No sub-issues yet." with the Add affordance still shown for writers.
   - **Loading** — 2–3 skeleton rows while the child fetch is in flight.
   - **Error** — a quiet inline `.empty`-style line "Couldn't load sub-issues." + a `Try again` `.btn.ghost`.
   - **Nesting rule** — sub-issues are **one level deep**: a sub-issue's detail does not show its own "Add sub-issue" affordance (no grandchildren). The child must be in the **same project** — the picker only lists this project's items; a cross-project pick is blocked with inline copy "Sub-issues stay in the same project." (this is the UI for the server's `invalid_parent` guard — a disabled/filtered picker, not a thrown error).
   - Parent breadcrumb shown when `parentId` is set.
5. **Comments thread** — `comments[]` (`commentHtml`, resolved `authorId`, `createdAt` mono-relative); a comment with `authorId === null` renders as a system/AI bubble with the aurora-ink avatar (LLM-authored). A composer at the bottom (`POST …/comments { comment_html }`, writer-gated) — sending is `⌘↵`. Comments are append-only (no edit/delete route; see §4.3). Empty: "No comments yet." with the composer still shown.
6. **Activity history** — **render the section scaffold but show a calm honest placeholder**: "Activity history is recorded but you can't view it here yet." The per-item activity (`created | updated | state_changed | commented`) is written server-side but **has no read route** — do not fabricate entries. (Note: this is the *per-item* history, distinct from the global `/activity` admin surface — see the cross-surface note below.) Verbs/fields are documented for when the route lands.
7. **Attachments & Custom fields** — **omit entirely from the live UI.** Do not render a disabled "Coming soon" tile and do not build pickers that call nonexistent routes. The only allowance is layout: leave whitespace in the rail so these can slot in later without a redesign. (This is the one decision — *omit*, not *show-disabled*; pick omit.)

**Cross-surface note (the global Activity surface):** every applied Projects write logs to the household **Activity** log (the admin `/activity` surface). In that surface a Projects write appears as a standard Activity row — actor (the person, or "AI" for an assistant-confirmed write) · a plain-language line (e.g. "moved INBOX-42 to In Progress," "added a comment to INBOX-42," "created project Onboarding") · the mono `key` where relevant · timestamp · the `write · ok` tier marker. You are not redesigning the Activity surface here — you are only ensuring Projects writes produce a legible, ADR-002-voiced row in it. No per-item timeline is built on the Projects surface itself until the per-item route lands (item 6).

**Safety** — Delete is always the destructive confirm dialog (red, `confirmedIdentifier={key}`). State/field edits are Write tier; because they dispatch through the same routes the LLM uses, an AI-proposed edit arriving via chat surfaces here as a pending Write card with `Write · confirm to apply` (§8).

**Responsive** — drawer: ~480–560px on desktop, full-width sheet on mobile (slides up). Full page: single narrow column, properties rail collapses from a right aside to stacked cards under the description on mobile.

---

### 3.5 Create / edit work-item modal

**Purpose** — create a new work item or edit core fields without leaving the board/list.

**Layout** — built on the canonical **`Dialog`** primitive with `placement="center"` and `maxWidth="md"` (it takes a required `labelledBy` id for its heading, an `onClose`, and a `triggerRef` to restore focus — these are the real props). Header `type-title-3` "New item" / "Edit INBOX-42" + close `X`. A form of input fields, each a label (`type-footnote` `--text-muted`) + a `.dp-input`-style control (`--surface-2`/`--color-surface-secondary` fill, `--border`/`--separator`, focus ring shifts toward accent):
- **Title** (`name`, required, inline `type-caption-2` `--color-system-red` validation when empty),
- **Description** (`description_html` rich-text — Tiptap, §4.3),
- **State** (`state_id` select; defaults to the project's `isDefault` state — "Todo" — when blank),
- **Priority** (`priority`, default `none`),
- **Assignees** (`assignees[]`),
- **Labels** (`label_ids[]`),
- **Parent** (`parent_id`, optional, same-project picker),
- **Start / Due date** (`start_date`/`due_date`).

Footer: secondary Cancel (`.btn`) + primary submit (`.btn.primary`, "Create item" / "Save"). Submit → `POST /api/pm/projects/:id/work-items` (`201 { work_item }`) or `PATCH /api/pm/work-items/:id`; the submit handler may return a Promise, so the button shows "Working…" and the dialog stays open on reject. `cycleId` is **not** offered (not patchable). Toast on success; the new item lands in the create-from-column's state.

**Responsive** — center card ~520px desktop, full-width sheet mobile. **States:** validating (inline error), submitting (disabled button "Working…"), error (a `.badge.danger` strip with friendly error copy, form stays open).

---

### 3.6 Create / edit project modal

**Purpose** — stand up or edit a project.

**Layout** — `Dialog` `placement="center"` `maxWidth="md"`. Fields from the project write body: **Name** (`name`, required), **Identifier** (`identifier`, optional `/^[A-Za-z0-9]+$/` 1–10, mono input, helper "Leave blank to auto-generate from the name" — on submit a `409 identifier_taken` surfaces as inline `--color-system-red` "That key is already taken — pick another."), **Description** (`description`), **Icon** (lucide-name or monogram picker), **Color** (swatch picker from the brand ramp + state palette), **Lead** (`leadId`, resolved-user select), and on edit an **Archived** toggle (`.sw`; archiving is reversible, so it carries a quiet "reversible" note, not a destructive treatment).

Submit → `POST /api/pm/projects` (auto-seeds the 5 default states) or `PATCH /api/pm/projects/:id`. Delete (edit mode) → the destructive confirm dialog, `confirmedIdentifier={identifier}`, warning that all items are removed.

**Responsive** — center → full-width mobile sheet; color/icon pickers wrap.

---

### 3.7 Cycles (sprints) view (`/projects/[identifier]?view=cycles`)

**Purpose** — sprint planning per project.

**Reality gate** — Cycles are **schema-only: no service, no `/api/pm/*` route**, and `cycleId` is not settable via the current patch schema. This view renders as a **fully-designed empty/disabled state**, never a broken fetch. Show the tab, a `.sect` "Cycles", and a `.card` `.empty` block: `.ei` calendar icon, `.eh` "Cycles aren't ready yet", body (≤44ch, owner-facing — no implementation detail) "Sprint planning will live here. We'll turn it on in a future update." — no CTA that calls a missing route. (Note for the engineer: the intended contract is `name`, `startDate`/`endDate`, `status: draft|active|completed`, item assignment — documented for when routes ship, not surfaced to the owner.)

**Responsive** — single-column placeholder at all widths; identical light/dark.

---

### 3.8 Modules view (`/projects/[identifier]?view=modules`)

**Purpose** — epic/grouping of work items.

**Reality gate** — Modules are **schema-only, no API**. Same treatment as Cycles: a designed empty/disabled tab, a `.card` `.empty` with `.eh` "Modules aren't ready yet" and owner-facing body "Grouping work into bigger efforts will live here. We'll turn it on in a future update." — no live fetch, no CTA. (Engineer note: reserved shape is `name`, `leadId`, `status: backlog|planned|in_progress|paused|completed|cancelled`, `startDate`/`targetDate`, many-to-many to items, so the eventual layout — a grid of module cards with progress bars — can light up later.)

**Responsive** — placeholder, single column on mobile.

---

### 3.9 Filter / command bar + saved views

**Purpose** — slice the current project's items and recall views; the keyboard entry point.

**Layout — two coexisting patterns:**
- **(a) Saved-view chip sub-nav** — a `.chiprow` of `.chip` / `.chip.on` (with `aria-current` on the active one) directly under the view switcher: "All", "My items", "Active", "Overdue", "No assignee" — each maps to query params on `GET /api/pm/projects/:id/work-items` (`state`, `assignee`, `priority`, `parent=none`, `q`). A right-pushed `+` chip ("Save view") persists the current filter set.
- **(b) Segmented filter rail** for live slicing — a horizontal scrollable rail of pill filters with count badges (per-state, per-priority, per-assignee); active pill uses the `.chip.on` (`--brand-subtle` / `--brand`) treatment, inactive the resting `.chip`, driving a client-side slice.
- **Command bar** — a `.search` field (220–360px, mono `⌘K` `kbd` hint) wired to `GET /api/pm/work-items?workspace=home&q=` (the workspace-wide search that also backs the assistant's search tool, ordered `updatedAt desc`). `⌘K` focuses it from anywhere; typing filters live (debounced); results show `key` + title + a project `.chip`; Enter opens the top hit's drawer.

**Saved-views persistence + states (design all of these):**
- **Where they live** — saved views are **per-owner, persisted server-side so they're consistent across this owner's sessions/devices** (not browser-local; a localStorage-only view would contradict the household-shared, multi-device promise). Design them as durable named filters.
- **Empty** — before any view is saved, the chip sub-nav shows only the built-in presets ("All", "My items", …) and the `+ Save view` chip; no "your views" section until one exists.
- **Save / rename / delete** — saving prompts for a short name (sentence case). A saved chip's overflow (long-press on touch, kebab on hover) offers Rename and Delete (Delete is a low-risk Write — a quiet confirm, not the destructive red dialog).
- **Stale reference** — if a saved view's filter references a label or assignee that was later deleted, the view still loads but drops the missing facet and shows a one-line note "One filter was removed because it no longer exists." — never an error, never an empty-by-accident board.
- **Max count** — cap at a sensible small number (e.g. 12); past the cap the `+ Save view` chip is disabled with a tooltip "You've reached the saved-view limit — delete one to add another."

**Content/fields** — filter values map exactly to the route query params (`state, assignee, label, priority, parent ("none"|id), q, per_page (≤200), page`). Pagination drives a "Load more" affordance on long lists.

**Responsive** — the bar collapses to a single `.search` pill + a "Filters" `.btn.ghost` that opens the chip/segment rail in a bottom sheet on mobile.

---

### 3.10 Every state — empty, loading/skeleton, error (per view)

Honesty rules apply throughout: calm copy, no exclamation marks, no emoji; pending/unknown states use info-blue not red; never imply something is done that isn't. (Verbatim copy in §6.)

- **Loading / skeleton** — reuse the grid/list with skeleton cards (a `.card` filled with a shimmering `--surface-2` block): Projects home → 6 card skeletons + KPI skeleton bars; Board → 4 column skeletons each with 2–3 card placeholders; List → 8 `.lrow` shimmer rows; Detail → header + property-rail + comment skeletons. **Skeletons, not spinners** — the only spinner is the `RefreshCw` icon while a manual refresh runs.
- **Empty (per view)** — the `.empty` block inside a `.card` (`.ei` icon / `.eh` heading / ≤44ch body / optional CTA), using the verbatim copy in §6:
  - Projects home: **"No projects yet."** / **"Create one to start tracking work."** · `New project` CTA (writers only; readers get the line without the button).
  - Board/List (project with zero items): **"No work items in this project yet — add one to get started."** · `New item` CTA.
  - Empty column: **"Nothing in {state name}."**
  - Filtered-to-empty: **"No work items match these filters."** / **"Try clearing a filter."** · `Clear filters` quiet button — distinct from the truly-empty case so users aren't misled.
  - Search no-results: **"No work items match that search."**
  - Comments: **"No comments yet."** · composer still shown.
  - Cycles/Modules: the "aren't ready yet" states in §3.7/§3.8.
- **Error** — the same `.empty` block with an error icon and friendly copy, never blaming the user: **"Couldn't load this project. Check the appliance connection and try again."** + a `Try again` `.btn.ghost` that re-fetches. A read-only role renders the surface with write affordances simply absent (not an error). Mutation failures surface as a toast (e.g. **"Couldn't move that item — try again."**), not a full-view error, leaving the optimistic card to roll back.

**Cross-cutting DoD for every view:** pixel-accurate in **light and dark** (bind the dark re-maps), a **mobile width**, real `/api/pm/*` data, **loading + empty + error + all domain states** (per-state columns, terminal/cancelled styling, overdue, unassigned, archived, AI-authored comment, schema-only Cycles/Modules placeholders), full **keyboard navigation** (roving tabindex on cards/rows, `⌘K` search, `⌘↵` send), `prefers-reduced-motion` honored (no drag-lift, no transition), and the **`Write · confirm to apply` chip on every assistant-proposed write** (transition, create, edit) with confirm-before-execute — reads carry none, and direct human edits self-confirm.

---

## 4. Interactions

How the Projects surface behaves. Every rule reuses the existing dashboard system — no new tokens, no new vocabulary.

### 4.1 Drag-to-transition (kanban) and reorder

The board is the primary view. Cards move two ways, both backed by the work-item `sortOrder` **Float** (chosen so a drag inserts a card *between* two neighbors without renumbering the column).

- **Drag across columns = state transition.** Dropping a card into another column calls `POST /api/pm/work-items/:id/transition` with `{ state_id }` (the column's `stateId`) — the route that runs the `completedAt` logic (dropping into a `completed`/`cancelled` group stamps completion; dragging back out clears it). Do **not** PATCH `stateId` directly from a drag; use `transition`.
- **Drag within a column = reorder.** Dropping between two cards PATCHes a new `sortOrder` = the midpoint of the neighbors' floats. No other field changes.
- **Drop targets.** A column shows a single insertion line (1px `--brand`, pill caps) at the gap the card will land in — not a full-card placeholder shuffle. The lifted card gets the `--lift` shadow and `opacity: 0.9`; the source gap collapses at ~200ms `--ease`.
- **Empty column** is still a valid drop target — render the `.empty` block but keep the column's full height droppable.
- **Motion budget.** Lift/drop at ~200ms `--ease`. No springs, no bounce, no settle overshoot — one easing curve. Under reduced motion the drag still works but the card snaps with no transition (§5.4).
- **No drag for read-only roles** — members/viewers/guests get a static board (§8 RBAC inheritance).
- **Human vs assistant.** A human drag is the user's own confirm — it writes optimistically. An assistant-*proposed* move renders a pending card + `Write · confirm to apply` and waits for Confirm before the route fires (§8).

The List/table view mirrors the board for keyboard and screen-reader users (§5.5); the same `sortOrder`/`transition` writes back it.

### 4.2 Inline edit

Frequent edits happen in place, not in a modal:

- **Work-item title** — click (or `Enter` on a focused card/row) turns the title into a `.dp-input`-style field. `Enter`/blur commits via `PATCH … { name }`; `Esc` reverts. Empty title is rejected inline (`type-caption-2` `--color-system-red`, copy: "Name can't be empty.") and the field stays open.
- **Priority** — a small popover of the five values; selection PATCHes `priority`.
- **Assignees / labels** — popover multi-selects. These are **full-set replacements** on the wire (`assignees: string[]`, `label_ids: string[]`) — the popover holds the complete desired set and sends it whole, not a delta.
- **Project key prefix / identifier / lead / icon/color** — edited from the project modal (§3.6), not inline on the board.
- **Not editable today** (schema-only, no route): `cycleId`, modules, custom properties, attachments, per-item activity. The UI must not render affordances that POST to non-existent routes.

User references (`leadId`, `assignees`, `authorId`, `createdById`) are plain user-id strings — resolve display names from the people directory separately; never block a write on name resolution.

### 4.3 Rich-text editor (Tiptap) — work-item description and comments

`descriptionHtml` and comment `commentHtml` are HTML on the wire. Use **Tiptap** for both.

- **Toolbar (minimal, sentence-case tooltips):** bold, italic, bullet list, ordered list, link, inline `code`, code block, blockquote. No font pickers, no color pickers, no emoji button — the editor inherits `--font-ui` for prose and `--font-mono` for inline/block code.
- **Description** autosaves on blur and on a debounced pause (`PATCH … { description_html }`; sending `null` clears it). Comments are **append-only** (`POST …/comments { comment_html }`) — there is no comment edit/delete route, so render comments as immutable once posted.
- **Placeholders** follow copy rules: "Add a description" / "Write a comment" — sentence case, no period, no exclamation.
- **Sanitize on render.** Stored HTML, some authored by the LLM (`authorId: null`). Render through the app's sanitizer; never inject raw model output.
- **Reduced motion:** any toolbar fade respects §5.4.

### 4.4 Optimistic updates

Built on the SWR cache + mutate, matching the cameras data convention (per-domain hooks, polling refresh).

- **Pattern:** mutate the local cache immediately (card moves / title changes), fire the write, then revalidate. On rejection, roll back to the prior snapshot and raise a toast.
- **Drag** is optimistic: card lands instantly; a failed `transition`/`sortOrder` PATCH snaps it back and toasts. Because `sortOrder` is a float midpoint and `sequenceId` is server-minted, an optimistic insert never collides.
- **Create** is optimistic with a temporary card; reconcile to the real `key` (`${identifier}-${sequenceId}`) and `sequenceId` when `201 { work_item }` returns.
- **Honesty rule:** never show a write as *done* before the server confirms it as anything stronger than optimistic; an assistant-proposed write stays **pending** until accept (§8). Skeletons/inline patterns, not blocking spinners.
- **Counts** (`commentCount`, `subItemCount`) are server-derived; optimistically bump on create, reconcile on revalidate.

### 4.5 LLM / assistant tie-in (agent-friendly surfaces)

The same `/api/pm/*` data is read and written by the in-app AI — the write routes admit the MCP service principal, so the assistant's *confirmed* write tools dispatch through the **identical** routes the UI uses (backed by the `pm_*` MCP tools). The surface must feel agent-friendly:

- **"Ask AI about this project" affordance.** The project header carries a quiet `.btn.ghost` — `MessageSquare` + "Ask AI about this project" — that opens the `chat` surface with the project pinned as a removable context chip (the accent-icon context pin already in the system). A per-item "Ask AI about this item" lives in the work-item detail's overflow, pinning the item's `key`.
- **Workspace-wide search parity.** The board search uses `GET /api/pm/work-items?workspace=home&q=` (the same route the assistant's search tool uses), so the user's search and the assistant's are one query surface. `⌘K` is the global search; the local field is the scoped filter.
- **Assistant-authored content reads as such.** A comment with `authorId: null` renders with the aurora AI treatment (aurora tints, aurora-ink avatar) and an "AI" attribution — never disguised as a human teammate.
- **Every assistant write is a Write-tier action** and renders the `Write · confirm to apply` chip + confirm before it touches `/api/pm/*` (§8). The assistant proposes; the user confirms; the same route executes.
- **Single seeded workspace.** One `home` workspace, household-shared reads (no per-user visibility filtering). Copy in second person to the owner ("your projects"), never per-user "my items" (except the saved-view preset "My items," which filters by the signed-in owner).

---

## 5. Accessibility — WCAG 2.1 AA

A surface is not done until it passes here. These are concrete, testable requirements.

### 5.1 Color contrast (AA)
- **Body and label text ≥ 4.5:1; large text (≥ 20px or ≥18.66px bold) ≥ 3:1.** `--text` on `--surface`/`--card-bg` and `--color-label-primary` on its surfaces pass. `--text-muted` / `--color-label-secondary` is for secondary text only — and note `--color-label-secondary` is `rgba(60,60,67,0.8)` (the WARP-611 value; it measures ~5.97:1 on white). Do not cite or design to the old `0.6` value — it failed AA (3.44:1) and was raised; using `0.6` would regress the fix.
- **Status by more than color.** Priority and state are never color-only — pair the system color dot/chip with a text label and the lucide glyph. Color-blind users read state from the label, not the hue.
- **Accent on accent.** White text on `--brand` (`#6366f1`) for `.btn.primary` passes AA. Do **not** put `--brand` text on `--brand-subtle` for body-size copy — that pair is for chips/large or non-text emphasis only.
- **The safety chip ink rule.** The `SafetyChip` puts its **label in `--color-label-primary`** (black/white), color only on the icon and tint — because tinted text fails AA at caption size. Match this; never color the chip label. (Status `.badge` variants are a separate case: their ink hexes were tuned against their specific tints and are fine inside the badge — but they're badge labels at badge size, not the caption-size safety chip.)
- **Dark mode** re-maps every variable (accent → `#818cf8`, brighter system colors). Re-verify every pair in dark; do not assume light ratios carry.

### 5.2 Focus rings
- Every interactive element shows a **visible focus indicator** — the system `:focus-visible` ring (a ~3px accent-mix ring; the `.dp-input` focus pattern). Cards-as-buttons (`role="button" tabIndex={0}`) get the same ring.
- Focus order is logical: sidebar → top bar → page-header actions → filter chips → board columns → cards (left-to-right, top-to-bottom). Drag handles, inline-edit fields, and popovers are reachable and the ring is never clipped by a column's `overflow`.
- The `Dialog` (drawer + create/edit modals) already traps focus, restores to the trigger on close, handles `Esc`, and locks scroll — reuse it; do not hand-roll a trap.

### 5.3 Target sizes
- **Minimum 24×24 CSS px** for any pointer target (WCAG 2.5.8). The `.icon-btn` (36×36) and `.btn` (36h, `.btn.sm` 28h) clear it. Inline chip removers and the drag affordance must keep a ≥24px hit area even if the glyph is smaller — pad the target, don't shrink it.
- The toggle `.sw` (38×22) is fine; its label is part of the target.

### 5.4 Reduced motion
- `prefers-reduced-motion: reduce` **disables all motion** — aurora drift, fade-rise, slide-up, scan-pulse, drag transitions, drawer slides (the global reduced-motion block cuts animation/transition durations to ~0). Cards snap; dialogs appear without translate/scale. State changes still happen — only the animation is removed.
- No spinner theatrics, no parallax, single `--ease` curve in the body. Aurora's 18s loop is paused under reduced motion.

### 5.5 Screen-reader / keyboard parity
- The **List/table view is the screen-reader path** and must be a true equivalent of the board: every transition and reorder achievable from the keyboard there.
- Cards expose an accessible name = `key` + title (e.g. "INBOX-42, Fix onboarding copy"), `aria-current` on the active filter chip, an `aria-label`/`title` on every `.icon-btn`, and live-region announcements for optimistic results ("Moved to In Progress" / "Couldn't move — try again").

### 5.6 Keyboard model + shortcuts

| Keys | Action |
|---|---|
| `⌘K` | Global search, system-wide |
| `⌘↵` | Send chat / submit the assistant prompt / send a comment |
| `C` | New work item in the focused project |
| `/` | Focus the in-page board filter/search field |
| `Enter` | Open the focused card's detail; on an inline field, commit |
| `Esc` | Cancel inline edit · close popover · close dialog/drawer |
| `← →` | Move focused card to the previous/next column (= keyboard `transition`) |
| `↑ ↓` | Move focus / reorder within a column (with a modifier to reorder = `sortOrder` write) |
| `Tab / Shift+Tab` | Standard focus traversal (logical order, §5.2) |

`⌘K` and `⌘↵` are the two non-negotiable system shortcuts; the rest are Projects-local and must not collide with them. Show `kbd` hints in `--font-mono` where the system already does (the `.search` field).

---

## 6. Copy & tone (ADR-002)

The persona is the **non-technical owner/admin of a small business who owns the appliance**, addressed in second person. Plain meaning first, jargon as a quiet mono secondary.

- **Sentence case everywhere** — labels, buttons, headers, menu items, and the segmented-control options. "New project," not "New Project." The view-switcher and "Group by" options read **state · assignee · priority · none** (lowercase) as control labels, even though the underlying enum is `State`/`Assignee`/etc.
- **No emoji. No exclamation marks** — especially not in empty states.
- **Em-dashes for asides; middle-dots (`·`) as separators.** "In progress · 4 items," "Lead — Stefan."
- **Never blame the user.** "No projects yet." not "You haven't created any projects."
- **Never imply a guarantee that isn't real** — pending/optimistic states use info/blue, never red. Red is reserved for genuine errors and destructive confirmation.
- **`--font-mono`** (`ui-monospace, "SF Mono", Menlo, Consolas, monospace`) is reserved for ids and identifiers: work-item keys (`INBOX-42`), project `identifier` prefixes, dates/timestamps, and `kbd` hints. **`--font-ui`** for everything else. The Instrument Serif display utility is for premium hero numbers only — not for body, labels, or the standard KPI value (which is the 28px UI font).
- **No "coming soon."** The schema-only placeholders use the owner-facing "aren't ready yet … we'll turn it on in a future update" phrasing (§3.7/§3.8), never the marketing cliché "coming soon" and never implementation detail like "the data model is ready."

**One verbatim string per concept — these are final; do not produce variants:**

| Context | Copy (verbatim) |
|---|---|
| Empty board (no items) | "No work items in this project yet — add one to get started." |
| Empty project list | "No projects yet." (heading) · "Create one to start tracking work." (body) |
| Empty column | "Nothing in {state name}." |
| Filtered-to-empty | "No work items match these filters." (heading) · "Try clearing a filter." (body) |
| Search no-results | "No work items match that search." |
| Load error | "Couldn't load this project. Check the appliance connection and try again." |
| Write rejected (toast) | "Couldn't move that item — try again." |
| Inline title empty | "Name can't be empty." |
| Identifier collision (409) | "That key is already taken — pick another." |
| Comment placeholder | "Write a comment" |
| Description placeholder | "Add a description" |
| Assistant attribution (pending write) | "Write · confirm to apply" |
| Assistant-authored content tag | "AI" |
| Per-item activity placeholder | "Activity history is recorded but you can't view it here yet." |
| Cycles placeholder | "Cycles aren't ready yet." · "Sprint planning will live here. We'll turn it on in a future update." |
| Modules placeholder | "Modules aren't ready yet." · "Grouping work into bigger efforts will live here. We'll turn it on in a future update." |
| No description | "No description yet." |
| No comments | "No comments yet." |
| No sub-issues | "No sub-issues yet." |
| Cross-project sub-issue blocked | "Sub-issues stay in the same project." |
| Delete-project confirm | "Delete this project? This removes its work items and can't be undone." |

Note on attribution: the assistant's pending-write chip says exactly **"Write · confirm to apply"** — the same string the human-facing Write tier uses, because it *is* the Write tier. There is no separate "Added by AI · confirm to apply" string; the AI authorship is conveyed by the "AI" tag on the actor, and the action's safety is conveyed by the one canonical Write chip. Keep these two signals distinct (who did it = "AI"; what tier = "Write · confirm to apply") and never merge them into a second chip string.

Lead-with-human-label pattern in headers: **"Onboarding · `INBOX`"** (plain name, then the mono key as the quiet secondary).

---

## 7. Cross-viewport cohesion (one system)

Web, **iOS, Android, and Windows must share ONE design system** — **indigo `#6366f1` accent + bento layout** — with **no per-viewport divergence**. This is a standing rule, not a suggestion.

- **Same tokens.** All four viewports bind the identical color/type/spacing/radii/shadow/motion values and the dark re-maps. Indigo is the accent on every surface — no viewport may drift to a violet (or any other) accent. No per-platform palette, no per-platform type ramp.
- **Same shell vocabulary.** Sidebar nav grouping (Workspace / Operations / Admin), the page header, bento cards, chips, the 2-tier safety chip, and the aurora AI treatment look and behave the same across web/iOS/Android/Windows. Projects must read as native to the existing twelve surfaces on every platform.
- **Same copy and safety contract** everywhere — sentence case, no emoji, no exclamation marks, em-dashes, and the safety chip on every assistant-proposed write regardless of viewport.
- **Adapt density, not identity.** Mobile collapses the multi-column board into the denser List/table layout (which is also the screen-reader path) and a single-column bento; it does **not** restyle. The desktop board is the wide layout; the phone is the table. Touch targets follow §5.3 (≥24px, with mobile comfortably larger).
- **One brand mark** (`DropletMark`, the 22px sidebar wordmark), one motion language (the shell `--ease` in the body; no platform-specific springs/bounces).

If any viewport's Projects surface would diverge in accent, layout system, copy tone, or safety treatment, that is a cohesion violation and must be reconciled before handoff.

---

## 8. The safety chip on writes

The one promise we cannot ship without honouring. Every assistant-proposed/side-effecting card on the Projects surface renders the safety chip, and the backend MUST NOT execute the side effect until the user confirms. The chip is the shipped **2-tier** `SafetyChip` — `Read` and `Write · confirm`. There is no third tier on this surface.

| Tier | When it appears on Projects | Chip text (verbatim) | Construction | Backend behaviour |
|---|---|---|---|---|
| **Read** | Loading a board, filtering, searching, opening an item — all `GET /api/pm/*` | **`Read · stays on LAN`** | green tint + `Eye` icon + **`--color-label-primary` label** | Runs immediately. Logged `read`. |
| **Write** | Any assistant-proposed create/edit/move/comment, and any state-change the model proposes | **`Write · confirm to apply`** + accept/reject | orange tint + `Pencil` icon + **`--color-label-primary` label** | UI renders a **pending** card. Backend executes on `accept`, drops on `reject`. Logged `write · ok` / `write · cancelled`. |

- **The chip never colors its label.** Color is on the icon and the faint tint only; the label is high-contrast `--color-label-primary`. This is the shipped AA construction — do not regress it to colored chip text.
- **Direct human edits** (a user dragging a card, typing a title, clicking a state) execute on the user's own action — the click *is* the confirm, no pending card. **Assistant-proposed** writes render the pending card + chip and wait for an explicit Confirm before any `/api/pm/*` call fires.
- **Destructive confirms** (delete project / state / label / work-item) route through the destructive confirm dialog (red `#ef4444`), with the safety chip optionally in the dialog's accessory slot and a `confirmedIdentifier` echo where deletion is irreversible. The backend stays inert until Confirm.
- **RBAC inheritance.** Reads are open to any authenticated role. Writes require **owner/admin/family**; members/viewers/guests see the board **read-only** — hide drag, inline edit, create, and the accept/apply buttons (don't disable-and-tease). Effective ability = role default ∧ resource scope. The assistant's writes are admitted via the MCP service principal but still render the Write chip and confirm.
- **No write is shown as applied** until the server confirms; pending/optimistic states use info/blue, never red.

---

## 9. Deliverables checklist

Recreate these in the dashboard using the existing primitives, hooks, and tokens — **high-fidelity, pixel-accurate at 1440w, token-driven, light + dark, no new tokens.** Use the real shell primitives (`ShellPage`/`Phead`/`.card`/`.kpi`/`.lrow`/`.chip`/`.badge`/`.empty`/`.btn.primary`/`.icon-btn`) from §2.7; treat any prototype as layout intent only.

### Screens to produce (each at 1440w, light + dark)

1. **Project board (kanban)** — the primary surface. Board: the 5 seeded columns (Backlog · Todo[default] · In Progress · Done · Cancelled) with their group-derived state pills + live dot colors, `sortOrder`-ordered `.card.hover` cards showing `key` (mono), title, priority, assignee `.ava`s, label chips, `commentCount`/`subItemCount`. Header = `Phead` with title (project name), live `sub`, primary "New item" + refresh `.icon-btn`. Saved-view `.chiprow` + segmented filter rail. Drag insertion line shown.
2. **Project list / table view** — the keyboard- and screen-reader-equivalent of the board (`.rows`/`.lrow`); sortable, groupable, the mobile layout.
3. **Work-item detail** — right-`placement` `Dialog` drawer **and** the dedicated route: Tiptap `descriptionHtml`, priority/assignees/labels/state inline edits, parent + one-level sub-issue list with counts (with its empty/loading/error states), comments thread (append-only, AI-authored comments in aurora), "Ask AI about this item" affordance, the per-item activity placeholder, attachments/custom-fields **omitted**. Show the assistant-pending Write card variant here.
4. **Projects index** — grid of project cards (icon/color/`identifier`/lead/archived), "New project" primary, archived filter, KPI summary strip (28px UI numbers).
5. **Create/edit modals** — new project and new work item, both on the canonical `Dialog` (`placement="center"`, `maxWidth="md"`), not a hand-rolled shell.

### For every screen, show all of these (light + dark)

- **Domain states:** loading (skeleton, no spinner theatrics) · empty (calm, ADR-002 copy, no exclamation) · error (reachability) · populated · a drag-in-progress frame · an inline-edit-active frame · a **pending assistant Write card** with the safety chip · a destructive confirm dialog.
- **Component coverage:** `Phead` + actions · the **already-shipped** sidebar with Projects active (Workspace group, after Calendar, `FolderKanban`, `--color-accent-subtle`/`--color-accent`, 17px glyph) · saved-view `.chip.on` (`aria-current`) + segmented filter rail · board column + work-item `.card` · `.kpi` summary tiles · Tiptap toolbar · priority/assignee/label popovers · the chat context-pin for "Ask AI" · the **two** safety chips (`Read · stays on LAN` / `Write · confirm to apply`, label in `--color-label-primary`) · the role-aware read-only board.
- **Accessibility frames:** a visible `:focus-visible` ring on card, chip, and button; a reduced-motion note; AA-verified contrast in both themes (cite the `0.8` secondary-label value, not `0.6`).
- **Cohesion note:** confirm indigo accent + bento + system copy hold identically across web/iOS/Android/Windows (no per-viewport divergence).

### Definition of done

Pixel match in light **and** dark at 1440w + a mobile width (the table layout) · bound to the live `/api/pm/*` contract (single `home` workspace, household-shared reads, `key` like `INBOX-42`, float `sortOrder`, full-set assignee/label replacement, snake_case wire ↔ camelCase model) · every state covered (loading/empty/error + all domain states) · keyboard navigation + screen-reader parity via the table view · `prefers-reduced-motion` respected · the **2-tier** safety chip on every assistant-proposed write with confirm-before-execute and a `--color-label-primary` label · RBAC read-only for members/viewers/guests · reuse over invention, no new tokens, no invented class names · the sidebar entry matched to the shipped `FolderKanban` Workspace slot (not redesigned). Do **not** surface schema-only entities (cycles, modules, custom properties, attachments, `cycleId`, per-item activity history) — they have no API yet.
