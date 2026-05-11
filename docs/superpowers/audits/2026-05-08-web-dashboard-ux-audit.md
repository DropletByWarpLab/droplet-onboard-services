# Web dashboard UX audit — 2026-05-08

**Codebase:** `main` @ `772f0e2` (`feat(WARP-230): TPM 2.0-sealed device identity + first-boot enrollment`)
**Auditor:** Claude (controller session) — 5 parallel `general-purpose` subagents, each playing the `.superpowers/agents/ui-ux.md` role on a scoped surface.
**Scope:** `apps/web-dashboard/` — 195 TS/TSX files across 13 page routes + 12 component directories.

This document captures **the full audit findings** and the **prioritized remediation plan**. It exists so future Claude sessions can reference both the synthesis (top of doc) and the verbatim subagent output (appendix) without re-running the audit.

---

## 1. Executive summary

All five surfaces returned **HAS-BLOCKERS**. The design-token system itself is genuinely clean (zero raw hex / px font-sizes in inline styles anywhere in scope), but the dashboard ships with **broken/undefined utility classes that Tailwind silently drops to nothing**, missing dialog ARIA on half the modals, hover-only destructive actions, Frigate branding leaking to users, and no streaming-stop affordance on the chat surface.

The good news: `apps/web-dashboard/src/app/users/page.tsx` (from WARP-217) is the **gold-standard pattern** for modal ARIA + per-row actions + optimistic updates with rollback. The rest of the dashboard should be ported to match.

### Verdict matrix

| Surface | Verdict | Headline issues |
|---|---|---|
| Auth + Shell + Layout | HAS-BLOCKERS | Mobile nav drawer missing (Settings/Users/Cameras/Network unreachable < 1024 px); toast a11y; hero textarea no focus ring |
| Network + Devices + Smart-home | HAS-BLOCKERS | `dp-button-*` typo across ~30 sites renders Network buttons unstyled; Block/Unblock silent destructive (TODO WARP-41); smart-home `DeviceDetailPanel` no dialog ARIA; `system-yellow` token undefined |
| Cameras + Clips + Recordings + PTZ | HAS-BLOCKERS | PTZ keyboard-unreachable; live `<img>` no loading skeleton; **14+ Frigate-branded user-facing strings**; native `confirm()`/`alert()` on destructive |
| Chat + Files + Knowledge | HAS-BLOCKERS | No streaming Stop button; auto-scroll yanks user back to bottom; RAG citation chips not rendered in chat; FileRow has zero keyboard nav; `AttachmentChip` uses 4 undefined utility classes |
| Settings + Users + Remote + Calendar + Events + Notifications | HAS-BLOCKERS | Calendar uses `type-caption`/`type-title` (don't exist) and `border-separator-primary` (doesn't exist); `EventClipModal` uses `alert(e.message)`; `MotionMaskEditor` paints with hardcoded `rgb(220, 38, 38)` |

---

## 2. Cross-cutting themes (in priority order)

### 2.1 Silently-broken utility classes — **P0**

Tailwind drops unknown classes without error. The audit found:

| Bad class | Correct class | Sites | Effect |
|---|---|---|---|
| `dp-button-primary` / `-secondary` | `dp-btn-primary` / `-secondary` | ~30 sites in `components/network/` + `app/network/page.tsx` | Network primary buttons render as unstyled `<button>` |
| `type-caption` | `type-caption-1` | 10+ in `components/calendar/`, `AttachmentChip.tsx` | Reminder/subscription rail has no body-size token |
| `type-title` (bare) | `type-title-3` | `EventForm.tsx:139` | Modal heading falls back to UA default |
| `border-separator-primary` | `border-separator` | `SubscriptionsPanel.tsx:214` | Publish-URL divider invisible |
| `bg-system-yellow` / `text-system-yellow` | (token missing entirely) | `events/EventCard.tsx`, `events/EventClipModal.tsx`, `smart-home/DeviceDetailPanel.tsx` | Saved badge invisible; smart-home warning invisible |
| `border-warning` / `text-positive` / `text-warning` | (undefined) | `AttachmentChip.tsx` | Failed/ready chip styling absent |

Tracked: **WARP-288**.

### 2.2 Modal dialog ARIA gaps — **P0**

Pattern from `users/page.tsx` (WARP-217) is correct: `role="dialog"` + `aria-modal="true"` + `aria-labelledby` (via `useId`) + Escape close + focus return to trigger. **Missing on:** `PairDialog`, smart-home `DeviceDetailPanel`, `ClientDetailPanel`, `EventForm`, `EventClipModal`, `ZoneEditor` name-prompt, `AddDeviceDialog`, network `DeviceDetailPanel` (partial). Tracked: **WARP-289**.

### 2.3 Mobile nav black-hole — **P0**

`Sidebar.tsx` bottom tab bar on mobile only shows `primaryNav`. Settings, Users, Cameras, Network, Events, Remote Access, ThemeToggle, sign-out — all unreachable on phone/tablet. 7 tabs at 360 px is also over the iOS 5-tab convention. Tracked: **WARP-290**.

### 2.4 Destructive actions on native `confirm()` / `alert()` / `prompt()` — **P0**

ui-ux.md flags this as CHANGES_REQUESTED. Native dialogs block JS, can't be themed, can't be a11y-labelled. Found in 12+ sites (Block/Unblock TODO WARP-41, file deletes, ProviderKey delete with NO confirm, EventClipModal save/tag/regen, camera deletes, calendar reminder, share dialog, trash). Tracked: **WARP-291**.

### 2.5 Hover-only row actions on touch / keyboard — **P0**

`opacity-0 group-hover:opacity-100` on destructive actions in: `settings/page.tsx` (delete user), `remote-access/page.tsx` (revoke device), `RemindersPanel.tsx` (delete reminder), `cameras/CameraCard.tsx`, `network/DeviceCard.tsx` (Quick-Schedule + Block), `FileManager/FileRow.tsx` (download/delete). WARP-220 fixed this for `users/page.tsx` — apply same pattern elsewhere. Tracked: **WARP-292**.

### 2.6 Frigate branding leaks to home-user copy — **P0**

14+ user-facing strings name Frigate explicitly. Worst offender: `cameras/birdseye/page.tsx:92-95` literally tells users to edit `config.yml`. CLAUDE.md requires Frigate to be transparent. Tracked: **WARP-293**.

### 2.7 Raw error messages leak — **P0**

`err.message` from orchestrator ships verbatim in `login/page.tsx`, `AttachmentChip`, `ProviderKeyForm`, `EventClipModal` (3 `alert()`), `HlsPlayer` (raw hls.js enum), `PushSubscriptionCard`. Pattern in `useChat.ts:96-112` (`friendlyErrorMessage`) and `invite/[token]/page.tsx` is the model. Tracked: **WARP-294**.

### 2.8 Streaming chat missing standard affordances — **P0**

No Stop/Cancel; auto-scroll unconditional; no Copy/Quote/Regenerate; **RAG citation chips not rendered in chat** (only in `/knowledge/SearchTab`). Tracked: **WARP-295**.

### 2.9 PTZ keyboard-unreachable — **P0**

`PtzOverlay.tsx` responds only to pointer events. Tracked: **WARP-296**.

### 2.10 Toast a11y — **P0**

No `aria-live` / `role="status"` / `role="alert"`. Auto-dismiss-after-5s violates WCAG 2.2.1 for errors. Tracked: **WARP-297**.

### 2.11 Everything-else a11y polish — **P1**

Skip link, `aria-current="page"`, icon-button labels, hero textarea focus ring, FileRow keyboard nav, knowledge/network tab WAI-ARIA, setup discovery upper bound, WelcomeFlourish duplicate copy, ThemeToggle radiogroup ARIA, range-input labels, StatusCard human-copy aria-label. Tracked: **WARP-298**.

---

## 3. Strengths to preserve

These are the patterns to copy, not regress:

- **`users/page.tsx`** — gold-standard modal ARIA + per-row actions + optimistic updates with rollback. Reuse everywhere.
- **`invite/[token]/page.tsx`** — gold-standard error mapping (`err.code` → friendly copy + fixed fallback).
- **`WelcomeFlourish`** — full `useReducedMotion` alternate-path. Exemplary for any future animated surface.
- **`globals.css` + `tailwind.config.ts`** — token system itself is clean. Light/dark variants, semantic tokens, global `prefers-reduced-motion` reset. **Zero hardcoded hex / px font-size** in any inline style across the entire scope.
- **`CameraCard` preload-then-swap snapshot logic** — eliminates blink; well-commented rationale.
- **PTZ STOP-on-everything semantics** (`onPointerLeave` + `onPointerCancel` + Esc + unmount) — belt-and-braces, exactly right for actuator-driven hardware.
- **HLS dynamic import** — library only fetched on the recordings route.
- **Network page typed-error → human-copy mapping** (`ROUTER_ERROR_COPY`, `TOAST_COPY`).
- **`DeviceDetailPanel.tsx` real snapshot+rollback** on display-name edit — apply this to Block/Group/Schedule mutations.
- **`GroupTypeahead.tsx`** — full ArrowUp/Down roving with `aria-activedescendant`. Best a11y in the dashboard; reuse for any future combobox.
- **`AddDeviceDialog`** — "private key shown once" warning + QR + `.conf` flow is well thought out.

---

## 4. Ticket map

| Ticket | Title | Priority | Effort |
|---|---|---|---|
| [WARP-288](https://warp-lab.atlassian.net/browse/WARP-288) | Fix silently-dropped utility classes | P0 | XS |
| [WARP-289](https://warp-lab.atlassian.net/browse/WARP-289) | `<Dialog>` primitive + migrate modals | P0 | M |
| [WARP-290](https://warp-lab.atlassian.net/browse/WARP-290) | Mobile nav drawer | P0 | S |
| [WARP-291](https://warp-lab.atlassian.net/browse/WARP-291) | `<ConfirmDialog>` + WARP-41 + native-dialog scrub | P0 | M |
| [WARP-292](https://warp-lab.atlassian.net/browse/WARP-292) | Always-visible row actions site-wide | P0 | S |
| [WARP-293](https://warp-lab.atlassian.net/browse/WARP-293) | Frigate branding scrub | P0 | S |
| [WARP-294](https://warp-lab.atlassian.net/browse/WARP-294) | Typed-error → friendly-copy | P0 | S |
| [WARP-295](https://warp-lab.atlassian.net/browse/WARP-295) | Streaming chat polish + RAG citations | P0 | M |
| [WARP-296](https://warp-lab.atlassian.net/browse/WARP-296) | PTZ keyboard control | P0 | XS |
| [WARP-297](https://warp-lab.atlassian.net/browse/WARP-297) | Toast a11y | P0 | XS |
| [WARP-298](https://warp-lab.atlassian.net/browse/WARP-298) | A11y polish omnibus | P1 | M |

**Recommended landing order:** WARP-288 first (unblocks visual review of everything else), then WARP-289/290/291/297 in parallel (independent UI primitives), then 292/293/294 (refactoring on top of the primitives), then 295/296/298.

---

## 5. Appendix — verbatim subagent output

The five area-scoped audit reports follow in full. Each was produced by an isolated `general-purpose` agent playing the `.superpowers/agents/ui-ux.md` role on the assigned surface.

### 5.1 Audit A — Auth + Shell + Layout

**Verdict:** HAS-BLOCKERS

**Scope:** `apps/web-dashboard/src/app/{layout.tsx, page.tsx, login/page.tsx, setup/page.tsx, invite/[token]/page.tsx, globals.css}`, `tailwind.config.ts`, `apps/web-dashboard/src/components/{AuthGate.tsx, Sidebar.tsx, BreadcrumbNav.tsx, DropletMark.tsx, ThemeToggle.tsx, Toast.tsx, NotificationToaster.tsx, StatusCard.tsx, auth/WelcomeFlourish.tsx}`.

#### Critical

- **`Sidebar.tsx:206-235`** — Secondary nav unreachable on phone/tablet. Mobile bottom tab bar only renders `primaryNav`. Settings, Users, Cameras, Events, Network, Remote Access, ThemeToggle, sign-out, admin Activity all have **no entry point** below `lg:` (1024 px).
- **`Sidebar.tsx:215-233`** — 7 tabs at 360 px gives each ~51 px width. iOS convention is 5 max.
- **`Toast.tsx:55-77`** — Toasts not announced to screen readers. No `role="status"`/`role="alert"`/`aria-live`. Dismiss button unlabeled.
- **`app/page.tsx:210-212`** — Hero textarea kills focus ring with `focus:outline-none` and no replacement.
- **`app/page.tsx:62-66, 173-178`** — "Needs attention" / "Degraded" / "All systems operational" status chip is non-interactive with no follow-up affordance.

#### Should-fix

- `layout.tsx` + `AuthGate.tsx` — No skip link.
- `Sidebar.tsx:258-272` — No `aria-current="page"` on active nav.
- `login/page.tsx:95-101`, `setup/page.tsx:248-254` — Show/hide password button has no `aria-label` (invite page does it correctly).
- `setup/page.tsx:378-381` — Dead conditional copy: `discoveredDevices.length > 0 ? "Continue" : "Continue"`.
- `setup/page.tsx:95-126` — Discovery polling has no upper bound; `scanSeconds` ticks forever.
- `app/page.tsx:188-194` — Hero headline uses raw `text-[56px] sm:text-[72px] lg:text-[88px]` instead of `.type-large-title`.
- `BreadcrumbNav.tsx:1-46` — No `aria-label="Breadcrumb"` and no `<ol>` semantics.
- `Toast.tsx:34-37` — Auto-dismiss-after-5s on errors violates WCAG 2.2.1 (Timing Adjustable).
- `NotificationToaster.tsx:60-64` — Title fallback "Notification" + body "Notification — {body}" is awkward.
- `login/page.tsx:46, 111-117` — Mixed Title Case / sentence case. H1 "Sign in" vs button "Sign In".
- `login/page.tsx:32-34` — Raw `err.message` fallback can ship orchestrator strings like `"OCS 401"`, `"connect ECONNREFUSED"`.
- `layout.tsx:36-37` — `themeColor` belongs in a Next.js 14 `viewport` export.
- `Sidebar.tsx:107-117` — No `aria-label` on `<aside>` or mobile `<nav>`.
- `setup/page.tsx:149-162` — Step indicator dots have no text equivalent ("Step 2 of 4").

#### Nice-to-have

- `app/page.tsx:124-132` — Hardcoded `deviceCounts.cameras: 0` with the trailing comment.
- `app/page.tsx:443` — "AI models" label is jargon for the home-user persona.
- `app/page.tsx:407-408` — Empty state "Matter controller discovering on your network" leaks installer-grade jargon.
- `Sidebar.tsx:200-202` — Hardcoded `Droplet v0.1.0` version.
- `Sidebar.tsx:191-196` — Logout button has `title=` only, needs `aria-label`.
- `DropletMark.tsx:11-25` — Decorative SVG needs `aria-hidden`.
- `setup/page.tsx:166-189` vs `WelcomeFlourish` — "Welcome to Droplet" appears twice when displayName blank.
- `StatusCard.tsx:23-27` — Status dot announces raw enum strings.
- `ThemeToggle.tsx:23-32` — Three toggles without `role="radiogroup"` / `aria-pressed`.
- `Toast.tsx:50-53` — `text-system-red` on `bg-system-red/10` may fail 4.5:1 contrast.
- `BreadcrumbNav.tsx:14-19` — Home button `min-h-[28px]` below 32 px floor.

#### Strengths

- Token-driven styling is genuinely clean; design-token grep returns 0 hex/rgb/px-font-size hits.
- Dark-mode FOUC prevention in `layout.tsx:40-46` runs synchronously in `<head>` before paint.
- `WelcomeFlourish` honors `useReducedMotion()` with a complete alternative path.
- `invite/[token]/page.tsx` is the gold standard for error mapping.
- `AuthGate` correctly returns `null` for unauth non-redirecting branch.
- `.dp-input` focus-ring tokenization in `globals.css:176-183`.
- Mobile safe-area handling (`pb-[env(safe-area-inset-bottom)]`).
- Global `prefers-reduced-motion` override in `globals.css:458-466`.

#### Design-token grep

| Pattern | Hits | Files |
|---|---|---|
| `background-color:\s*#` | 0 | — |
| `color:\s*#` | 0 | — |
| `font-size:\s*[0-9]` | 0 | — |
| Suspicious inline `style={{ }}` | 13 | All token-driven (`var(--color-*)`, `var(--aurora-*)`) or animation timings |

---

### 5.2 Audit B — Network + Devices + Smart-home

**Verdict:** HAS-BLOCKERS

**Scope:** `app/network/page.tsx`, `app/devices/page.tsx`, `app/devices/clients/page.tsx`, `app/devices/pair/page.tsx`, all of `components/network/` (skipped `__tests__/`), all of `components/smart-home/`, `ClientDeviceCard.tsx`, `ClientDetailPanel.tsx`, `PairDialog.tsx`.

#### Critical

- **`globals.css:186,195` vs ~30 component sites** — `dp-btn-primary`/`-secondary` defined; `.dp-button-primary`/`-secondary` used across the network surface. Every Refresh/Confirm/Apply/Save/Create button on Network page renders as unstyled `<button>`. Sites: `network/page.tsx:180,213,234,254,288,311,537,562,653`; `OverrideModal.tsx:578,586`; `ScheduleEditorModal.tsx:380,388`; `ScheduleRow.tsx:181,191,198,207`; `SchedulesTab.tsx:58`; `QuickSchedulePopover.tsx:128,139`; `GroupManagerDialog.tsx:122`; `GroupRow.tsx:216`; `WeeklyWindowsEditor.tsx:139,161`; `SchedulePresetCards.tsx:59`.
- **`network/DeviceCard.tsx:147-194`** + **`network/DeviceDetailPanel.tsx:128-140`** — Block/Unblock fires with NO Tier 2 confirm. Both have explicit `TODO(WARP-41)`. Hook (`useDeviceBlockMutation.ts:21-24`) confirms it.
- **`app/devices/clients/page.tsx:73,79`** — Revoke uses native `confirm()` and `alert()`. Revoking a paired device kills its session token.
- **`network/DeviceCard.tsx:181-194`** — Explicit "no optimistic flip" comment documenting a 10-second visual lag on Block toggle.
- **`smart-home/DeviceDetailPanel.tsx:33-141`** — No dialog semantics. Missing `role="dialog"`, `aria-modal`, `aria-labelledby`, Escape, focus management.
- **`PairDialog.tsx:124-140`** — Same dialog ARIA gap. Close button (line 135) has no `aria-label`.
- **`smart-home/DeviceCard.tsx:80-88`** — Card is `<div onClick>` with no `role="button"`, `tabIndex`, key handler. Not keyboard-reachable.
- **`smart-home/DeviceDetailPanel.tsx:60`** — Uses `bg-system-yellow/10 border-system-yellow/20` but `system-yellow` is not a defined token.

#### Should-fix

- `smart-home/ClimateControl.tsx:64-80` — Mode chips are `<div>`s not `<button>`s (purely display).
- `smart-home/ClimateControl.tsx:42-47, 53-59` — +/- buttons have no `aria-label`.
- `devices/page.tsx:97-103` — Error copy leaks "Matter controller" and "mDNS" jargon.
- `PairDialog.tsx:273-277` — "is ready to sync" is borderline cloud-language.
- `ClientDeviceCard.tsx:42-48` — `<div onClick>` not keyboard-reachable.
- `ClientDetailPanel.tsx:30-145` — No dialog ARIA + close button no `aria-label`.
- `smart-home/DiscoveryBanner.tsx:33-38` — Dismiss button no `aria-label`; auto-dismiss-5s with no undo.
- `devices/clients/page.tsx:113-119, 221-228` — Refresh + Trash icon-only buttons no `aria-label`.
- `network/DeviceDetailPanel.tsx:155-159` — Has `role="dialog"` but missing `aria-modal` + focus trap.
- `network/DeviceDetailPanel.tsx:317-355` — "Forget device" uses different pattern than other destructives.
- `network/OverrideModal.tsx:379-383` — `"{name} ({mac})"` exposes MAC as sort key.
- `network/DeviceCard.tsx:62, 104` — Hover-only `border-accent/50` + hover-only action buttons.
- `app/network/page.tsx:180` — Retry button on the broken-router state uses the broken class.
- `app/network/page.tsx:320-342` — Tabs missing `role="tab"`/`tablist`/`aria-selected`/`aria-controls`.
- `network/OverrideModal.tsx:81-99,100-101` — `Date.getHours/getMinutes` is locale-insensitive 24h.
- Toast position conflicts: `page.tsx:594-610` and `DeviceDetailPanel.tsx:358-373` both `fixed bottom-4 right-4`.
- `smart-home/BrightnessSlider.tsx:34-44` — Range input no `aria-label`.
- `smart-home/SensorReading.tsx:23-43` — Only temperature handled; other types in dead icon map.
- `network/GroupRow.tsx:109-128` — "{0} ungrouped. Delete?" reads awkward.
- `network/IconPicker.tsx:20-34` — Roving tabindex incomplete.

#### Nice-to-have

- `DeviceSparkline.tsx:18` — Single-tier opacity vs tiered like ScheduleHeatmap.
- `GroupRow.tsx:24-33` — 8 preset hex swatches not in tokens.
- `ScheduleEditorModal.tsx:228-236` + `OverrideModal.tsx:312-322` + `GroupManagerDialog.tsx:64-73` — Missing `aria-modal="true"`.
- `app/devices/pair/page.tsx:91-118` — Polling effect leak in expired branch.
- `app/network/page.tsx:101-135` — Operation poll re-trigger pattern.
- `smart-home/DeviceCard.tsx:54-55` — Hardcoded Matter normalizers in presentation layer.
- Smart-home has zero test coverage; network has heavy coverage.
- `network/DeviceDetailPanel.tsx:479-489` — `jumpToSchedulesTab` only updates `location.hash`, can't switch tabs.

#### Strengths

- Network page typed-error → human-copy mapping (`ROUTER_ERROR_COPY`, `TOAST_COPY`).
- `DeviceDetailPanel.tsx:83-103` real snapshot+rollback.
- DISABLED state renders as `role="status"`.
- Section expand/collapse persistence in `DeviceGridSection.tsx:16-31`.
- `DeviceCard.tsx:41-50` keyboard double-fire guard.
- 30-day sparkline daily-bucketed per spec.
- Schedule heatmap midnight-wrap math.
- `GroupTypeahead.tsx` full ArrowUp/Down roving with `aria-activedescendant`.

#### ADR-002 heuristic compliance

| Heuristic | Compliance |
|---|---|
| Named, not MAC'd | ✓ (one minor leak in OverrideModal sort key) |
| Iconed, not typed | ✓ |
| Grouped, not listed | ✓ |
| 30-day sparkline, not real-time | ✓ |
| Offline-first copy | ~ ("ready to sync" in PairDialog) |
| Tier 2 confirms preserved | ✗ (Block/Unblock no confirm; revoke uses native `confirm()`) |
| Optimistic update + rollback | ~ (display-name path exemplary; Block has neither) |

---

### 5.3 Audit C — Cameras + Clips + Recordings + PTZ

**Verdict:** HAS-BLOCKERS

**Scope:** `app/cameras/{page.tsx, [name]/page.tsx, [name]/recordings/page.tsx, birdseye/page.tsx, people/page.tsx, plates/page.tsx, system/page.tsx}`, `app/clips/page.tsx`, all of `components/cameras/`, `components/recordings/HlsPlayer.tsx`, `components/recordings/RecordingsTimeline.tsx`, `components/ptz/PtzOverlay.tsx`.

#### Critical

- **`cameras/[name]/page.tsx:301-319`** — Live MJPEG `<img>` has no loading state. Black `bg-black` container, no spinner, until first frame.
- **`components/ptz/PtzOverlay.tsx:36-178`** — No keyboard equivalents. Pan/tilt/zoom only respond to `onPointerDown`/`Up`. Enter/Space don't bind.
- **Cameras subpages — 14+ Frigate-branded user-facing strings.** Worst: `cameras/birdseye/page.tsx:92-95` instructs users to edit `config.yml`. Other sites: `cameras/page.tsx:154-164`, `[name]/page.tsx:36-46`, `birdseye/page.tsx:91-104`, `people/page.tsx:113,147`, `plates/page.tsx:111,146`, `system/page.tsx:107,126,144,169,235,382`.
- **`cameras/page.tsx:153`** — "Frigate NVR Not Connected" → "Check the Docker compose configuration or visit the health endpoint" — neither actionable.

#### Should-fix

- `cameras/[name]/page.tsx:107-112` — Escape closes page even when typing in inputs.
- `HlsPlayer.tsx:115-119` — Surfaces raw hls.js enum (`manifestLoadError`).
- `cameras/[name]/page.tsx:269-273, 284-287` — Maximize + Trash icon-only buttons no `aria-label`.
- `PtzOverlay.tsx:93` — Buttons 40×40 px; below WCAG 2.5.5's 44 px.
- `RecordingsTimeline.tsx:244-272` — Timeline has no group label; selection range not announced.
- `cameras/page.tsx:103, 130` + `[name]/page.tsx:82` + others — Error feedback uses `alert()`/`confirm()`.
- `CameraCard.tsx:151` — No skeleton while thumbnail loads.
- `cameras/page.tsx:185-258` — 8-button toolbar; secondary buttons icon-only on mid widths.
- `cameras/page.tsx:124, 277` — "Delete group" `confirm()` omits dependent-count.
- `cameras/[name]/recordings/page.tsx:233-241` — Date input no associated label.

#### Nice-to-have

- `CameraDiscoveryBanner.tsx:55-67` — Accept/Reject icon-only no `aria-label`.
- `cameras/[name]/page.tsx:373` vs `CameraEvents.tsx` — Mixed timestamp patterns.
- `CameraNotificationToast.tsx:24` — No `aria-live`.
- `cameras/[name]/page.tsx:315` — Snapshot fallback has no second-level fallback.
- `CameraGroupEditor.tsx:189` — Emoji input freeform; consider picker.
- `cameras/birdseye/page.tsx:92-95` — `config.yml` instruction.

#### Strengths

- `CameraCard` preload-then-swap snapshot logic.
- Hover-only MJPEG promotion (bandwidth saver).
- PTZ STOP-on-everything semantics (`onPointerLeave`/`Cancel`/Esc/unmount).
- HLS dynamic import on recordings route only.
- Camera-not-found friendly fallback.
- Aspect-ratio reservation prevents CLS.
- Pin-from-grid affordance with `role="button"` wrapper.

#### Media-specific compliance

| Check | Compliance |
|---|---|
| Loading skeleton / poster for video | ✗ |
| Failure state (camera offline) handled | ~ |
| Aspect-ratio reservation | ✓ |
| PTZ keyboard equivalents | ✗ |
| PTZ touch-target ≥ 32 px | ~ (40 px, below WCAG 44) |
| Tier 2 confirms on destructive | ~ (uses native `confirm()`) |
| No Frigate branding leakage | ✗ |
| Scrubber / timeline a11y | ~ |

---

### 5.4 Audit D — Chat + Files + Knowledge

**Verdict:** HAS-BLOCKERS

**Scope:** `app/chat/page.tsx`, `app/files/page.tsx`, `app/knowledge/{page,SearchTab,RecentlyIndexedTab,BrainMemoryTab}.tsx`, `components/chat/SessionHeader.tsx`, `components/{ChatMessage,ChatInput,AttachmentChip,CitationChip,UploadZone,ModelSelector,ProviderKeyForm}.tsx`, all of `components/FileManager/`, `lib/hooks/useChat.ts`.

#### Critical

- **`ChatInput.tsx:171-188` + `useChat.ts:242-340`** — No stop / cancel for streaming response.
- **`app/files/page.tsx:148, 163`**, **`knowledge/BrainMemoryTab.tsx:60`**, **`FileManager/ShareDialog.tsx:96`**, **`FileManager/TrashView.tsx:83`** — Destructive actions use native `window.confirm()`.
- **`ProviderKeyForm.tsx:39-46`** — Deleting an API key has no confirmation at all.
- **`FileManager/FileRow.tsx:123-137`** — File list has zero keyboard navigation. `<div>` rows, no `tabIndex`/role/`onKeyDown`. Action buttons `opacity-0 group-hover:opacity-100`.
- **`AttachmentChip.tsx:51-56, 78-87`** — Uses undefined design tokens (`type-caption`, `border-warning`, `text-positive`, `text-warning`).

#### Should-fix

- `chat/page.tsx:72-74` — Auto-scroll unconditional; yanks user back to bottom on every message.
- `ChatMessage.tsx:91-94` — No syntax highlighting in code blocks.
- `ChatMessage.tsx:27-130` — No copy / quote / regenerate affordances.
- `ChatMessage.tsx` whole file — RAG citations not rendered in chat (`CitationChip` only used in `/knowledge/SearchTab`).
- `ChatInput.tsx:81-97` — Drag-leave detection buggy; no idle "drop here" affordance.
- `app/files/page.tsx:97-118` + `app/chat/page.tsx` — Upload size limit not surfaced before failure.
- `app/files/page.tsx:96-118` — Batch upload only aggregate progress.
- `ModelSelector.tsx:22-53` — No privacy / cost cues beyond label.
- `app/knowledge/page.tsx:121-153` — Tab pattern incomplete WAI-ARIA.
- `FileManager/ContextMenu.tsx:42-115` — No arrow nav, no `role="menu"`, no focus trap.
- `FileManager/FileRow.tsx:134-137` — Context menu is mouse-only.
- `AttachmentChip.tsx:88-93` — Raw error string `{error}` rendered.
- `ProviderKeyForm.tsx:33, 44` — Raw `err.message` surfaced.
- `ChatMessage.tsx:57` — `max-w-[70%]` hurts wide content; tables don't wrap.
- `RecentlyIndexedTab.tsx:195` — Full internal Nextcloud paths shown.

#### Nice-to-have

- `CitationChip.tsx:75` — Snippet preview in `title` only; doesn't work on touch.
- `ChatMessage.tsx:119-124` — Streaming `animate-pulse` killed by reduced-motion; consider text fallback.
- `UploadZone.tsx:52-63` — Orphan file input.
- `app/chat/page.tsx:175` — Generic empty-state suggestion chips.
- `ChatInput.tsx:46-49` — No IME composition guard on Enter-to-send.
- `ModelSelector.tsx:31-35` — "Loading models…" option is selectable.

#### Strengths

- `globals.css` design-token system; zero hardcoded hex/font-size.
- `UploadZone.tsx:14-26` drag-counter pattern.
- `useChat.ts:96-112` `friendlyErrorMessage` template.
- `ChatMessage.tsx:66-67` `role="status"` + `aria-live="polite"` on streaming bubble.
- `ChatMessage.tsx:91-94` markdown sanitized by default (no `rehype-raw`).
- `app/knowledge/SearchTab.tsx:132-146` 503-handling friendly copy.
- `CitationChip` is well-designed but underused.

#### Chat/Files compliance

| Check | Compliance |
|---|---|
| Streaming auto-scroll behaves (sticky) | ✗ |
| Stop / cancel streaming | ✗ |
| Markdown sanitized | ✓ |
| Code block long-line overflow | ✓ partial (tables don't wrap) |
| Citation chip → source navigation | ✗ (not in chat surface) |
| Per-file upload progress + per-file error | ✗ |
| File-tree keyboard nav | ✗ |
| Tier 2 confirms on file delete | ✗ |
| Model selector privacy/cost cues | ✗ |
| No sensitive data in UI copy | ✗ partial |

---

### 5.5 Audit E — Settings + Users + Remote + Calendar + Events + Notifications

**Verdict:** HAS-BLOCKERS

**Scope:** `app/settings/page.tsx`, `app/users/page.tsx`, `app/remote-access/page.tsx`, `app/calendar/page.tsx`, `app/events/page.tsx`, all of `components/{settings,calendar,events,notifications}/`.

#### Critical

- **`components/calendar/EventForm.tsx:130,139,147,170,180,192,204`** — `type-caption` (does not exist) and `type-title` (does not exist).
- **`components/calendar/{RemindersPanel.tsx:101,103,124, SubscriptionsPanel.tsx:170,172,181,182,220,234, AgendaView.tsx:84}`** — Same `type-caption` ghost-class issue.
- **`components/calendar/SubscriptionsPanel.tsx:214`** — `border-separator-primary` is not a defined token.
- **`components/events/EventCard.tsx:65,67` + `EventClipModal.tsx:223,224`** — `bg-system-yellow/90` / `text-system-yellow` reference an undefined color.
- **`components/events/EventClipModal.tsx:67,80,82,84,89,91,104,106`** — Native `alert()`/`prompt()` for save rollback, "tag as person", and "regenerate description".
- **`components/settings/MotionMaskEditor.tsx:179,193,212,231,233`** — Polygon stroke/fill hardcoded `rgb(220, 38, 38)` instead of `var(--color-system-red)`.
- **`components/calendar/EventForm.tsx:123`** — Modal missing `role="dialog"`, `aria-modal`, `aria-labelledby`, Escape close, focus return.
- **`components/settings/ZoneEditor.tsx:497-546`** — Name-prompt modal missing same.
- **`app/settings/page.tsx:80-92`** — Delete-user button `opacity-0 group-hover:opacity-100`.
- **`app/remote-access/page.tsx:414-424`** — Revoke button hover-only.
- **`components/calendar/RemindersPanel.tsx:126-131`** — Hover-only Trash; no `aria-label`; no Tier-2 confirm.
- **`components/calendar/SubscriptionsPanel.tsx:203-208`** — Trash no `aria-label`.
- **`AddDeviceDialog` (`app/remote-access/page.tsx:489`)** — Modal missing dialog ARIA.

#### Should-fix

- `app/settings/page.tsx:53-92` — Form errors single banner; no per-field; no on-blur validation.
- `app/settings/page.tsx:163` — Create button never disabled when invalid.
- `EventForm.tsx:64-72` — Validation through `toast()` not inline.
- `app/users/page.tsx:225-237` + invite revoke + disable-user — Destructive on `confirm()`; disable not confirmed at all.
- `app/users/page.tsx:239-246` — Toggle-enabled not optimistic.
- `app/remote-access/page.tsx:75-83` — Revoke not optimistic.
- `PushSubscriptionCard.tsx:258` — Substring-matching on raw orchestrator strings.
- `PushSubscriptionCard.tsx:198-215` — "configured-off" copy is sysadmin-flavored.
- `app/events/page.tsx:170-172` — Loading state bare "Loading…" no skeleton.
- `app/calendar/page.tsx` — No multi-user awareness on agenda.
- `app/settings/page.tsx` — No "Saved" feedback after theme flip or key save.
- `app/settings/page.tsx` — No grouping or search; 12+ sections planned.
- `EventForm.tsx:140` — "External calendar — can't be edited here" + disabled inputs lack visual cue.
- `app/events/page.tsx:232` — Smart quotes in `placeholder=` survive Firefox.

#### Nice-to-have

- `RemindersPanel.tsx:8-22` `formatRel` — "just now" / "in <1m" awkward.
- `EventCard.tsx:11-20` `fmtRel` — Duplicated logic; extract `formatRelativeTime`.
- `AgendaView.tsx:46-53` — Empty-state copy could be warmer.
- `app/calendar/page.tsx:42` — Refresh button duplicates SWR.
- `EventFilterBar.tsx:233-241` — Score-floor range no marker; touch-fiddly.
- `app/remote-access/page.tsx:355-362` — `WIREGUARD_ENDPOINT_HOST` instructions sysadmin-flavored.
- `RemindersPanel.tsx:94` — "Create" doesn't reset focus to title input.
- `settings/ZoneEditor.tsx:414-420` — Rename input has no visible border.

#### Strengths

- `users/page.tsx` is gold-standard for this surface (modal ARIA, optimistic, per-row).
- `PushSubscriptionCard` clean state machine.
- `AddDeviceDialog` "private key shown once" warning + QR + .conf flow.
- `AgendaView`'s "Today · Tue Apr 23" copy.
- `EventFilterBar` active-count badge + clear-all + collapse pattern.
- `ZoneEditor` polygon-edit keyboard contract.

#### Admin/Config compliance

| Check | Compliance |
|---|---|
| Tier 2 confirms on destructive | ✗ |
| No raw error codes in toasts | ✗ |
| Modal dialog ARIA | ✗ (only `users/page.tsx` complete) |
| Per-field form validation | ✗ |
| Optimistic toggles + rollback | ~ |
| Settings save-state feedback | ✗ |
| Push notifications opt-in clarity | ✓ |
| Admin-only friendly empty state | ~ (only users/page exemplary) |
| Row actions without hover | ✗ |

#### Cross-cutting

| Pattern | Hits |
|---|---|
| Raw `rgb(`/hex in attributes | 13 (`MotionMaskEditor` + `ZoneEditor` zone palette) |
| Undefined utility classes | 14 (`type-caption`, `type-title`, `border-separator-primary`, `bg-system-yellow/90`, `text-system-yellow`) |

---

## 6. Methodology

Five `general-purpose` agents dispatched in parallel, each given:

1. The `.superpowers/agents/ui-ux.md` role definition.
2. A scoped file list (no overlap).
3. The standard heuristics: persona fit, a11y, responsive, copy/tone, design-token grep, optimistic update+rollback, Tier 2 confirms.
4. Surface-specific extras: ADR-002 for Network/Devices; media UX (loading, failure, CLS, PTZ a11y, Frigate transparency) for Cameras; streaming + sanitization + citations + file-tree kb nav for Chat/Files; admin/config Tier-2 + modal ARIA + per-field validation for Settings/Users.
5. Output format: Critical / Should-fix / Nice-to-have / Strengths + per-surface compliance table.

Each agent read its assigned files end-to-end (no excerpting), ran the design-token grep against its scope, traced at least one mutation per surface (where applicable), and reported back. **Total runtime ~17 minutes** of parallel work; sequential would have been ~80 minutes.

Coverage gaps the agents flagged: live boot at multiple viewports + visual-pixel verification (color contrast tooling, focus-ring rendering, animation feel). Recommended manual pass after WARP-288 lands to unblock visual review of everything else.

---

## 7. For the next Claude session

If you're picking this up after some of the tickets have merged:

1. **Re-run the design-token grep** to confirm WARP-288 stuck (the worst regressions to guard against are bad-class names sneaking back in).
2. **Check the `users/page.tsx` pattern** is still the reference — if the Dialog primitive (WARP-289) shipped, every NEW modal should use it, not hand-roll.
3. **The audit assumed `main @ 772f0e2`.** If the codebase has drifted significantly, re-run the audit in fresh subagents.
4. **The audit doc lives here, not in PR comments.** The QA + UX agents' raw verdicts on the PR threads are tactical (per-PR); this doc is strategic (cross-cutting).
