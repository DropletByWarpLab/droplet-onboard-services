# Spec — Phase 2: Scheduling (Parental Controls / Time-of-Day)

**Date:** 2026-04-17
**Status:** Draft for review
**Parent:** `docs/ADR-002-network-page-home-user-supervision.md` (deliberate departure — see §1)
**Depends on:** WARP-89 (orchestrator cron runtime)

---

## 1. Context

Phase 1 (device intelligence) shipped: home users can name, group, block, and track 30-day presence of every device on the network. ADR-002 originally prescribed Alerting as Phase 2; this spec departs from that ordering to deliver time-of-day scheduling first. Rationale:

- **Parental controls is the #1 consumer-router feature.** Every competing product (Eero, Orbi, Google Wifi) leads with it. Competing on this surface is table stakes for the "home AI appliance" position.
- **Phase 1 built exactly the primitives scheduling needs.** `NetworkDevice`, `DeviceGroup`, the block endpoint, the reconciler's block-state cascade, optimistic-rollback UX — all directly reusable.
- **Alerting becomes more useful *after* scheduling exists** — schedule firings are themselves events worth alerting on. Phase 3 Alerting will subsume Phase 2's lightweight `ScheduleEvent` into its unified `NetworkEvent` model.

Spec §3 Non-goals of the Phase 1 design doc called out "QoS / parental controls" and "time-of-day scheduling" as deferred. This spec unblocks the scheduling half.

## 2. Goals

- Home user can define recurring weekly schedules (e.g. "Kids offline 9pm–7am") against a device or a group, with multiple non-contiguous windows per schedule.
- Home user can grant one-off allow / block overrides (e.g. "give Emma 30 extra minutes tonight") without editing the recurring schedule.
- Multiple schedules per subject are allowed and independently toggleable (so "Bedtime" and "School hours" coexist on the Kids group).
- Device-level schedules take precedence over group-level schedules for the same device.
- Schedules evaluate in orchestrator-side logic (not router-native UCI time rules) so all business logic lives in Node code that's unit-testable.
- Effective block state is the OR of three sources, with clear priority: active override > manual block (existing WARP-86 semantics) > active schedule window.
- Dashboard surfaces schedules via a dedicated `Schedules` tab, inline sections on `DeviceDetailPanel` and `GroupManagerDialog`, and a one-tap "Quick Schedule" action on device cards + group rows.
- Three canned presets (Bedtime, School hours, Homework mode) give first-run users a zero-to-useful path.
- Lightweight in-app activity feed (`ScheduleEvent` table, 7-day retention) so parents can verify schedules fired as expected.

## 3. Non-goals (deferred)

Each of these is a follow-up Jira ticket once Phase 2 lands:

- Browser push, email, or mobile push notifications — Phase 3 Alerting owns notification channels
- Unified `NetworkEvent` model — Phase 3 owns this; Phase 2's `ScheduleEvent` is a precursor that migrates in Phase 3
- Bandwidth / QoS per schedule window — separate phase
- DNS-based content filtering per schedule — separate phase
- Per-app (Layer 7) blocking — MAC-level firewall only
- Schedule analytics / time-of-use reports
- Schedule import / export or cross-device sync
- Multi-user permissions on schedules (any authenticated dashboard user can edit any schedule)
- Per-schedule timezone customization — uses the orchestrator's system-local timezone (appliance convention)
- AI gateway LLM tool-call integration for schedule CRUD — separate ticket

## 4. Data model

### 4.1 Prisma additions

```prisma
model Schedule {
  id          String   @id @default(cuid())
  name        String
  enabled     Boolean  @default(true)
  subjectType String   // "device" | "group"
  deviceMac   String?
  groupId     String?
  windows     ScheduleWindow[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  device      NetworkDevice? @relation(fields: [deviceMac], references: [mac], onDelete: Cascade)
  group       DeviceGroup?   @relation(fields: [groupId],  references: [id],  onDelete: Cascade)

  @@index([enabled])
  @@index([deviceMac])
  @@index([groupId])
}

model ScheduleWindow {
  id         String   @id @default(cuid())
  scheduleId String
  daysOfWeek Int      // bitmask: Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64
  startMin   Int      // 0..1439 minutes since local midnight
  endMin     Int      // 0..1439; if endMin <= startMin window wraps past midnight
  schedule   Schedule @relation(fields: [scheduleId], references: [id], onDelete: Cascade)
}

model ScheduleOverride {
  id          String   @id @default(cuid())
  subjectType String   // "device" | "group"
  deviceMac   String?
  groupId     String?
  action      String   // "allow" | "block"
  startAt     DateTime
  endAt       DateTime
  note        String?
  createdAt   DateTime @default(now())

  device      NetworkDevice? @relation(fields: [deviceMac], references: [mac], onDelete: Cascade)
  group       DeviceGroup?   @relation(fields: [groupId],  references: [id],  onDelete: Cascade)

  @@index([endAt])
  @@index([deviceMac])
  @@index([groupId])
}

model ScheduleEvent {
  id             String   @id @default(cuid())
  scheduleId     String?
  overrideId     String?
  subjectType    String
  deviceMac      String?
  groupId        String?
  transition     String   // "blocked" | "unblocked"
  reason         String   // "schedule_window_start" | "schedule_window_end" | "override_applied" | "override_expired" | "manual_block" | "manual_unblock"
  occurredAt     DateTime @default(now())

  @@index([occurredAt])
}
```

### 4.2 `NetworkDevice.manualBlock` addition

```prisma
model NetworkDevice {
  // ...existing Phase 1 fields...
  manualBlock Boolean @default(false)  // user's persisted block intent, set via POST /devices/:mac/manualBlock
  schedules   Schedule[]
  overrides   ScheduleOverride[]
}
```

`isBlocked` (Phase 1) stays unchanged — reconciled firewall state. `manualBlock` is the new user-intent field that the ticker reads.

### 4.3 Validation rules

- `Schedule`: exactly one of `deviceMac` / `groupId` set, matching `subjectType`; max 7 windows per schedule.
- `ScheduleWindow`: `daysOfWeek` ∈ [1, 127]; `startMin`, `endMin` ∈ [0, 1439]; `startMin !== endMin` (zero-length rejected).
- `ScheduleOverride`: exactly one of `deviceMac` / `groupId` set; `endAt > startAt`; `action` ∈ `{"allow", "block"}`.
- New `DeviceRegistryError` codes: `SCHEDULE_NOT_FOUND`, `SCHEDULE_INVALID_WINDOW`, `SCHEDULE_SUBJECT_MISMATCH`, `OVERRIDE_NOT_FOUND`, `OVERRIDE_INVALID_RANGE`.

### 4.4 Timezone

All times are interpreted in the orchestrator's system-local timezone. DST transitions are handled by the platform `Date` API (`new Date()` + `getDay()` / `getHours()` / `getMinutes()`). Per-schedule timezone override is out of scope (appliance convention: router, orchestrator, and home are colocated).

### 4.5 Cascading

Deleting a `NetworkDevice` cascades to its `Schedule` and `ScheduleOverride` rows (Prisma `onDelete: Cascade`). Same for `DeviceGroup`. `ScheduleEvent` rows keep their `deviceMac` / `groupId` string fields on delete (no FK), so activity history remains intact for the 7-day retention window.

## 5. Service layer

### 5.1 `schedule.service.ts`

Core evaluation function — pure, no Prisma calls inside:

```ts
export function computeDesiredBlocked(input: {
  device: NetworkDevice & { groups: DeviceGroup[] };
  deviceSchedules: (Schedule & { windows: ScheduleWindow[] })[];  // subjectType=device schedules for this mac
  groupSchedules: (Schedule & { windows: ScheduleWindow[] })[];   // subjectType=group schedules for any group the device is in
  activeOverrides: ScheduleOverride[];                              // overrides where startAt <= now < endAt
  now: Date;
}): { blocked: boolean; reason: string }
```

Priority implementation:

1. Any active override with `action === "block"` → blocked, `reason = "override_applied"`
2. Any active override with `action === "allow"` → unblocked, `reason = "override_applied"`
3. `device.manualBlock` → blocked, `reason = "manual_block"`
4. If `deviceSchedules.length > 0`: evaluate only those (device-level wins, per Q4 precedence). Any active window → blocked, `reason = "schedule_window_start"`.
5. Else evaluate `groupSchedules`: any active window → blocked, `reason = "schedule_window_start"`.
6. Otherwise unblocked, `reason = "schedule_window_end"`.

### 5.2 `isWindowActive(window, now)` helper

```ts
export function isWindowActive(window: ScheduleWindow, now: Date): boolean
```

Given a window and a local time, returns whether `now` is inside the window accounting for day-of-week mask and possible past-midnight wrap. Pure, unit-tested independently.

### 5.3 Ticker

```ts
export function createScheduleTicker(prisma: PrismaClient, firewall: FirewallClient, intervalMs = 30_000): Ticker
```

Every `intervalMs`, load every `NetworkDevice` with groups + relevant schedules + active overrides in two-to-three queries, compute `computeDesiredBlocked` for each, diff against current firewall state, dispatch block/unblock via the existing `/api/network/firewall/block|unblock` endpoints, emit a `ScheduleEvent` on transition. Rides on the cron runtime introduced by WARP-89.

### 5.4 Event purge

Daily cron at 03:00 local (shares WARP-89's purge schedule):

```ts
async function purgeScheduleEvents(olderThanDays = 7): Promise<number>
async function purgeExpiredOverrides(olderThanHours = 24): Promise<number>  // keep expired overrides for 24h so UI back-refs remain valid
```

## 6. API surface

Extends `apps/orchestrator/src/routes/network.ts` (or its split per WARP-91 if that lands first).

### 6.1 Schedules

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/network/schedules` | — | `{ schedules: ScheduleWithWindows[] }` including `lastFiredAt`, `nextTransitionAt` (computed) |
| GET | `/api/network/schedules/:id` | — | schedule + windows + last 10 events |
| POST | `/api/network/schedules` | `{ name, enabled?, subjectType, deviceMac?, groupId?, windows: [{ daysOfWeek, startMin, endMin }] }` | created schedule |
| PATCH | `/api/network/schedules/:id` | `{ name?, enabled?, windows? }` (subject is immutable) | updated schedule |
| DELETE | `/api/network/schedules/:id` | — | 204 |

### 6.2 Overrides

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/network/overrides?active=1&deviceMac=...&groupId=...` | — | `{ overrides: ScheduleOverride[] }` |
| POST | `/api/network/overrides` | `{ subjectType, deviceMac?, groupId?, action, startAt?, endAt, note? }` | created override |
| DELETE | `/api/network/overrides/:id` | — | 204 |

### 6.3 Schedule events

| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/api/network/schedule-events` | `?since=ISO&limit=50` | `{ events: ScheduleEvent[] }` — newest first |

### 6.4 Manual block (new)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/network/devices/:mac/manualBlock` | `{ blocked: boolean }` | `{ mac, manualBlock: boolean }` |

Sets `NetworkDevice.manualBlock`. Ticker applies firewall state on next tick. Existing `/firewall/block|unblock` endpoints unchanged — retained as a low-level admin lever.

### 6.5 Errors

All endpoints return `{ error: DeviceRegistryError.toJSON() }` on typed errors (Phase 1 pattern). Prisma P2025 translation is reused from WARP-82.

### 6.6 Caching

No Redis SWR needed for Phase 2. If profiled slow post-launch, wire in later (follow-up of WARP-90).

### 6.7 Auth

Existing auth middleware. No new roles.

## 7. Dashboard UI

### 7.1 Navigation

New `Schedules` tab in `/network`, between Devices and WiFi. Identical `dp-card` / `type-*` / `text-label-*` token vocabulary as Phase 1.

### 7.2 Schedules tab

Three stacked sections:

1. **Presets row (always visible):** three cards (Bedtime, School hours, Homework mode). Each has a pattern summary + "Use preset" button. Bedtime/School open the schedule editor pre-filled; Homework opens the override picker.
2. **Schedules list:** one row per `Schedule` with enabled toggle, name (click-to-edit inline), subject badge, windows summary, "Active now" green dot, next transition, last fired, Edit / Delete actions. Empty state: "No schedules yet. Pick a preset above, or create a custom schedule." + "+ New schedule" button.
3. **Recent activity:** collapsed by default; expanded shows last 20 `ScheduleEvent` rows. 7-day retention footer.

### 7.3 Schedule editor modal

Form fields: Name, Subject (radio Device / Group + secondary dropdown), Windows (`WeeklyWindowsEditor`), Enabled toggle. `WeeklyWindowsEditor` is a reusable component with per-row day checkboxes + start/end time pickers (native `<input type="time">`), "+ Add window" button capped at 7, a 7×24 heatmap preview below the list. Optimistic save with server-truth rollback (WARP-84 pattern).

### 7.4 Override picker modal

Compact modal: Action (Allow / Block radio), Duration quick chips (15m / 30m / 1h / 2h / "until [next transition]" / custom), note field. "Until next transition" chip is smart-computed from the subject's applicable schedule. Existing overrides on the same subject show as a banner with Cancel link.

### 7.5 Quick Schedule action

Surfaces on device card hover row, group row in GroupManagerDialog, DeviceDetailPanel footer. Tap opens a compact popover: "Apply Bedtime? Sun–Thu 9pm–7am, Fri–Sat 11pm–8am. [Apply] [Customize]". Apply creates the schedule in one tap; Customize opens the full editor.

### 7.6 Inline sections

- **`DeviceDetailPanel`:** new Schedule section between Groups and Notes. Shows effective schedule + source ("own" or "via Kids group"), current state, Allow-for / Block-for override buttons, active override banner if present.
- **`GroupManagerDialog`:** per-row expandable schedules list scoped to that group, Create button launches editor pre-filled. Natural time to extract a `GroupRow` sub-component.

### 7.7 SWR hooks + mutations

- `useSchedules()` — `/api/network/schedules`, 30s refresh
- `useActiveOverrides({ deviceMac?, groupId? })` — 15s refresh
- `useScheduleEvents()` — 60s refresh, only when Recent activity expanded
- `useScheduleMutations` — create / update / delete / toggle
- `useOverrideMutations` — create / cancel
- `useDeviceBlockMutation` — migrated to `/devices/:mac/manualBlock`

All mutations use the shared `apiFetch` helper from the Phase 1 cleanup PR (#46).

### 7.8 Accessibility

- Schedule editor: `role="dialog"`, ESC closes, focus-trap on first field
- Day checkboxes: proper `<label>` + `<input>` pairs
- Time pickers: native `<input type="time">`
- Enabled toggle: `<button role="switch" aria-checked>`
- Recent activity feed: `role="log"` with live-region updates

## 8. Testing strategy

### 8.1 New coverage

| Layer | Tool | Target |
|---|---|---|
| Prisma migration | `prisma migrate diff` | tables created; `NetworkDevice.manualBlock` field added |
| `isWindowActive` helper | vitest | day mask, midnight wrap, DST transition day, every-5-min boundary sweep |
| `computeDesiredBlocked` | vitest | every priority branch: override-block, override-allow, manualBlock, device schedule, group schedule, no schedule, device+group precedence |
| Schedule ticker | vitest with fake timers + mocked prisma + mocked firewall | tick applies diffs, emits events on transition, preserves isBlocked on firewall error |
| Event purge | vitest | deletes events older than 7d, expired overrides older than 24h |
| Schedule service | vitest | create/update/delete/toggle; subject validation; window validation |
| Override service | vitest | create/cancel; time-range validation |
| Schedule routes | supertest | happy path + typed-error codes on every endpoint; auth gate |
| Dashboard components | vitest + testing-library | Schedules tab render, editor form validation, override picker quick chips, Quick Schedule popover, inline panels |
| Dashboard hooks | vitest | SWR polling cadence, optimistic mutations + rollback |

### 8.2 Regression baselines

Every PR keeps:
- `apps/orchestrator` — existing 328+ vitest tests passing, `tsc --noEmit` clean
- `apps/web-dashboard` — existing 78+ vitest tests passing, `tsc --noEmit` clean
- `services/routing` — 73 pytest tests passing
- Phase 1 endpoints unchanged in behavior (checked via existing `network.device.test.ts`)

### 8.3 Device-side acceptance (Hardware Test column in Jira)

Recorded but run manually when hardware is available:
- Schedule fires at the configured time; devices go offline within 30s
- One-off override grants extra time; schedule resumes at next window boundary
- `manualBlock` persists across orchestrator restart
- Activity feed reflects real transitions

## 9. Agent harness

Same Dev → QA → UI/UX → Manager → CodeReviewer pipeline that shipped Phase 1 (role prompts in `.superpowers/agents/`, playbook in `docs/superpowers/agent-harness.md`). No prompt changes needed; UI/UX agent continues applying to dashboard tickets only (T4, T5, T6, T7, T8).

## 10. Acceptance criteria per ticket

**T1 — Data model**
- Migration creates `Schedule`, `ScheduleWindow`, `ScheduleOverride`, `ScheduleEvent`; adds `NetworkDevice.manualBlock`
- `isWindowActive` helper + unit tests
- New `DeviceRegistryError` codes defined
- `tsc --noEmit` + `prisma validate` clean

**T2 — Ticker + schedule service**
- `computeDesiredBlocked` covers every priority branch with tests
- Ticker runs on WARP-89's cron runtime; configurable interval via env
- Block/unblock dispatched via existing firewall endpoints
- `ScheduleEvent` emitted on transition with correct `reason`
- Purge cron removes events >7d and expired overrides >24h
- `manualBlock` read by ticker; respected as Phase 1's Block-button semantics extended

**T3 — Orchestrator API**
- All endpoints in §6 return typed responses + typed errors
- Subject-immutability enforced on PATCH /schedules
- `/devices/:mac/manualBlock` replaces WARP-86's direct-firewall path from dashboard
- Existing `/firewall/block|unblock` endpoints unchanged

**T4 — Schedules tab + hooks**
- Tab navigation includes Schedules
- List renders schedules with active-now indicator, last-fired, next-transition
- Empty state + Recent activity feed implemented
- `useSchedules` / `useActiveOverrides` / `useScheduleEvents` hooks present

**T5 — Schedule editor + WeeklyWindowsEditor**
- Form validation matches §4.3
- Heatmap preview renders
- Optimistic save + rollback verified

**T6 — Override picker**
- Action + Duration quick chips + smart "until next transition"
- Current-override banner with Cancel
- `useOverrideMutations` hook

**T7 — Inline sections + `manualBlock` migration**
- Schedule section on `DeviceDetailPanel` shows effective schedule + source
- Schedule section on `GroupManagerDialog` per-row
- Quick Schedule popover on device cards + group rows
- `useDeviceBlockMutation` points at `/devices/:mac/manualBlock`

**T8 — Presets**
- Three preset cards on Schedules tab top row
- Bedtime / School hours wired to schedule editor pre-fill
- Homework mode wired to override picker
- Quick Schedule popover defaults to Bedtime

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Ticker fires during firewall outage, leaves stale state | Reconciler (WARP-81) re-syncs `isBlocked`; ticker re-attempts next cycle. Typed RouterError preserves previous firewall state. |
| `manualBlock` migration subtly breaks existing `/firewall/block|unblock` callers | Existing endpoints retained unchanged per §6.4. Dashboard migrates; old callers unaffected. |
| 30s ticker cadence feels sluggish ("my kid is still online 25s after bedtime") | Ticker interval is env-configurable (`SCHEDULE_TICK_MS`, default 30000). If real usage demands it, drop to 15s or 10s. Optimistic UI flip on manualBlock click provides instant user feedback regardless. |
| Schedule editor complexity scares home users | Preset-first onboarding (Q9 C); Quick Schedule one-tap path sidesteps the editor entirely for common cases. |
| DST transitions cause "missed" schedule firings | Ticker runs every 30s regardless; the 1-hour DST jump affects "next transition" display but not firing correctness — the first tick after the transition catches up. |
| Event table grows unbounded | 7-day retention via daily purge cron; typical household generates <50 events/day → <350 rows steady-state. |
| Phase 3 Alerting migration path for `ScheduleEvent` → `NetworkEvent` | Column-level migration script maps `ScheduleEvent.transition + reason` → `NetworkEvent.type + severity`. Deferred to Phase 3 ticket. |

## 12. Open questions (none blocking)

None as of 2026-04-17. All design decisions captured in §1–§11.

## 13. Success metric

A parent sets up Bedtime for their kids in under 2 minutes (tap Kids group → Quick Schedule → Apply), grants Emma 30 extra minutes tonight in one tap from her device card, and sees in the Recent activity feed that both actions took effect.
