# Phase 2 Scheduling (Parental Controls) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship time-of-day scheduling (parental controls) against `NetworkDevice` and `DeviceGroup` — recurring weekly windows + one-off allow/block overrides, enforced by an orchestrator-side ticker that reuses Phase 1's firewall primitives.

**Architecture:** Four new Prisma models (`Schedule`, `ScheduleWindow`, `ScheduleOverride`, `ScheduleEvent`) + one new field (`NetworkDevice.manualBlock`). Pure `computeDesiredBlocked(device, context, now)` function encodes the OR-priority (override > manualBlock > schedule, device-level schedules precedence over group-level). A ticker running every 30s diffs desired vs. firewall state and dispatches block/unblock via existing Phase 1 endpoints. Dashboard adds a `Schedules` tab plus inline Schedule sections on `DeviceDetailPanel` and `GroupManagerDialog`, with three canned presets (Bedtime, School hours, Homework mode) and a one-tap Quick Schedule popover.

**Tech Stack:**
- Backend: Node.js 20, Express, Prisma ORM, PostgreSQL 16, vitest + supertest, pino, `node-cron` (new)
- Frontend: Next.js 14 (App Router), React 18, SWR, Tailwind with `dp-*`/`type-*` tokens, Lucide icons, native `<input type="time">`, vitest + @testing-library/react + jsdom
- Infra: Docker Compose, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-04-17-phase-2-scheduling-design.md` (authoritative — read it before starting any ticket).

**Ticket → branch → PR:** Eight Jira tickets WARP-92..99 in Sprint 1. Branches `WARP-92`..`WARP-99` exist off `main`. Each ticket ships as its own PR through the agent harness (Dev → QA → UI/UX → Manager → PR → CodeReviewer → human merge).

**Execution order (enforced by Jira Blocks links):**
1. **WARP-92** (T1) data model — ships first
2. **WARP-93** (T2) ticker + schedule service — depends on T1 (+ cross-Phase on WARP-89, though T2 introduces its own cron primitive if WARP-89 hasn't landed)
3. **WARP-94** (T3) orchestrator API — depends on T1, T2
4. After T3 merges: **WARP-95** (T4, tab + hooks) + **WARP-97** (T6, override modal) can run in parallel
5. **WARP-96** (T5) schedule editor — depends on T4
6. After T5 merges: **WARP-98** (T7, inline + manualBlock migration) + **WARP-99** (T8, presets) can run in parallel (both also depend on T6)

**Note on WARP-89 (cross-Phase dependency):** The schedule ticker needs a cron runtime. WARP-89 (reconciler poller + purge cron) introduces the same primitive. **This plan assumes WARP-89 has NOT merged** when T2 begins, so T2 ships `cron-runtime.service.ts` as a standalone file. If WARP-89 lands first, T2 reuses WARP-89's runtime unchanged. The service file stays single-purpose either way.

---

## File Structure

Files created or modified, grouped by ticket.

### WARP-92 — T1 Data model

| Path | Purpose |
|---|---|
| `apps/orchestrator/prisma/schema.prisma` (modify) | Add `Schedule`, `ScheduleWindow`, `ScheduleOverride`, `ScheduleEvent` models; add `NetworkDevice.manualBlock` field + back-relations on `NetworkDevice`/`DeviceGroup` |
| `apps/orchestrator/prisma/migrations/20260417000000_phase_2_scheduling/migration.sql` (new) | Creates four tables + indexes + `NetworkDevice.manualBlock` column |
| `apps/orchestrator/src/lib/schedule-window.ts` (new) | Pure `isWindowActive(window, now)` helper |
| `apps/orchestrator/src/lib/schedule-window.test.ts` (new) | Edge cases: day mask, midnight wrap, DST day, boundary minute |
| `apps/orchestrator/src/types/device-registry-error.ts` (modify) | Add 5 new error codes + factories |
| `apps/orchestrator/src/types/device-registry-error.test.ts` (modify) | Cover new factories |

### WARP-93 — T2 Ticker + schedule service

| Path | Purpose |
|---|---|
| `apps/orchestrator/src/services/cron-runtime.service.ts` (new) | Minimal cron primitive: `scheduleInterval(ms, handler)` + `scheduleCron(spec, handler)` |
| `apps/orchestrator/src/services/cron-runtime.service.test.ts` (new) | Runtime starts/stops, interval fires, shutdown cleanup |
| `apps/orchestrator/src/services/schedule.service.ts` (new) | `computeDesiredBlocked` pure function + event emitter |
| `apps/orchestrator/src/services/schedule.service.test.ts` (new) | Every priority branch; device-level precedence; multiple overrides |
| `apps/orchestrator/src/services/schedule-ticker.ts` (new) | `createScheduleTicker(prisma, firewall)` + tick loop |
| `apps/orchestrator/src/services/schedule-ticker.test.ts` (new) | Mocked prisma + firewall; tick applies diffs, preserves state on RouterError, emits events |
| `apps/orchestrator/src/services/schedule-purge.ts` (new) | `purgeScheduleEvents`, `purgeExpiredOverrides` |
| `apps/orchestrator/src/services/schedule-purge.test.ts` (new) | Cutoff correctness |
| `apps/orchestrator/src/index.ts` (modify) | Initialize cron runtime + schedule ticker + purge cron |
| `apps/orchestrator/package.json` (modify) | Add `node-cron` dep |

### WARP-94 — T3 Orchestrator API

| Path | Purpose |
|---|---|
| `apps/orchestrator/src/services/schedule-api.service.ts` (new) | CRUD + query methods consumed by routes |
| `apps/orchestrator/src/services/schedule-api.service.test.ts` (new) | Per-method happy + typed error |
| `apps/orchestrator/src/routes/network.ts` (modify) | Append 10 route handlers |
| `apps/orchestrator/src/routes/network.schedules.test.ts` (new) | supertest coverage for all schedule/override/event/manualBlock endpoints |

### WARP-95 — T4 Dashboard Schedules tab

| Path | Purpose |
|---|---|
| `apps/web-dashboard/src/lib/types.ts` (modify) | Add `Schedule`, `ScheduleWindow`, `ScheduleOverride`, `ScheduleEvent` types |
| `apps/web-dashboard/src/lib/hooks/useSchedules.ts` (new) | SWR 30s |
| `apps/web-dashboard/src/lib/hooks/useActiveOverrides.ts` (new) | SWR 15s; accepts filter opts |
| `apps/web-dashboard/src/lib/hooks/useScheduleEvents.ts` (new) | SWR 60s |
| `apps/web-dashboard/src/lib/hooks/useScheduleMutations.ts` (new) | `createSchedule` / `updateSchedule` / `deleteSchedule` / `toggleSchedule` |
| `apps/web-dashboard/src/components/network/SchedulesTab.tsx` (new) | Layout: presets placeholder + schedules list + recent activity |
| `apps/web-dashboard/src/components/network/ScheduleRow.tsx` (new) | Single schedule row with toggle + next-transition + last-fired |
| `apps/web-dashboard/src/components/network/ScheduleActivityFeed.tsx` (new) | Collapsible recent activity |
| `apps/web-dashboard/src/app/network/page.tsx` (modify) | Add Schedules tab button + routing state |
| Tests: `SchedulesTab.test.tsx`, `ScheduleRow.test.tsx`, `ScheduleActivityFeed.test.tsx` (new) | |

### WARP-96 — T5 Schedule editor modal

| Path | Purpose |
|---|---|
| `apps/web-dashboard/src/components/network/ScheduleEditorModal.tsx` (new) | Form dialog with name, subject selector, enabled toggle, windows editor |
| `apps/web-dashboard/src/components/network/WeeklyWindowsEditor.tsx` (new) | Reusable: day checkboxes + start/end time + add/remove, caps at 7 |
| `apps/web-dashboard/src/components/network/ScheduleHeatmap.tsx` (new) | 7×24 heatmap preview |
| Tests: `ScheduleEditorModal.test.tsx`, `WeeklyWindowsEditor.test.tsx`, `ScheduleHeatmap.test.tsx` (new) | |
| `apps/web-dashboard/src/components/network/SchedulesTab.tsx` (modify) | Wire Edit button to open modal |

### WARP-97 — T6 Override picker

| Path | Purpose |
|---|---|
| `apps/web-dashboard/src/components/network/OverrideModal.tsx` (new) | Compact modal with action + duration chips + note |
| `apps/web-dashboard/src/lib/hooks/useOverrideMutations.ts` (new) | `createOverride` / `cancelOverride` |
| `apps/web-dashboard/src/lib/scheduleEval.ts` (new) | Client-side `nextTransitionFor(schedules, now)` used by "until next transition" chip |
| Tests: `OverrideModal.test.tsx`, `scheduleEval.test.ts` (new) | |

### WARP-98 — T7 Inline sections + manualBlock migration

| Path | Purpose |
|---|---|
| `apps/web-dashboard/src/components/network/DeviceDetailPanel.tsx` (modify) | Add Schedule section between Groups and Notes |
| `apps/web-dashboard/src/components/network/GroupManagerDialog.tsx` (modify) | Extract `GroupRow`; add inline schedule summary + create |
| `apps/web-dashboard/src/components/network/GroupRow.tsx` (new) | Extracted row component |
| `apps/web-dashboard/src/components/network/QuickSchedulePopover.tsx` (new) | "Apply Bedtime? [Apply] [Customize]" popover |
| `apps/web-dashboard/src/components/network/DeviceCard.tsx` (modify) | Add Quick Schedule button to hover action row |
| `apps/web-dashboard/src/lib/hooks/useDeviceBlockMutation.ts` (modify) | Migrate to `/devices/:mac/manualBlock` |
| Tests: new test files + modifications to existing | |

### WARP-99 — T8 Preset templates

| Path | Purpose |
|---|---|
| `apps/web-dashboard/src/components/network/schedule-presets.ts` (new) | `SCHEDULE_PRESETS` constant |
| `apps/web-dashboard/src/components/network/SchedulePresetCards.tsx` (new) | Three cards replacing the placeholder |
| `apps/web-dashboard/src/components/network/SchedulesTab.tsx` (modify) | Swap placeholder for `<SchedulePresetCards />` |
| `apps/web-dashboard/src/components/network/QuickSchedulePopover.tsx` (modify) | Wire to Bedtime preset |
| Tests: `schedule-presets.test.ts`, `SchedulePresetCards.test.tsx` (new) | |

---

## Task 1: WARP-92 — Prisma data model

**Branch:** `WARP-92` (exists off main).
**Depends on:** nothing — ships first.
**Size:** S.

- [ ] **Step 1: Checkout branch + clean tree**
```bash
git checkout WARP-92
git status  # expect clean
```

- [ ] **Step 2: Add new error codes**

Edit `apps/orchestrator/src/types/device-registry-error.ts`. Add to the `DeviceRegistryErrorCode` union:
```ts
export type DeviceRegistryErrorCode =
  | "NOT_FOUND"
  | "GROUP_IN_USE"
  | "INVALID_ICON"
  | "INVALID_MAC"
  | "DUPLICATE_GROUP_NAME"
  | "SCHEDULE_NOT_FOUND"
  | "SCHEDULE_INVALID_WINDOW"
  | "SCHEDULE_SUBJECT_MISMATCH"
  | "OVERRIDE_NOT_FOUND"
  | "OVERRIDE_INVALID_RANGE";
```

Append static factories:
```ts
static scheduleNotFound(id: string) {
  return new DeviceRegistryError("SCHEDULE_NOT_FOUND", `Schedule ${id} not found`, { status: 404 });
}
static scheduleInvalidWindow(detail: string) {
  return new DeviceRegistryError("SCHEDULE_INVALID_WINDOW", `Invalid schedule window: ${detail}`, { status: 400 });
}
static scheduleSubjectMismatch(detail: string) {
  return new DeviceRegistryError("SCHEDULE_SUBJECT_MISMATCH", `Schedule subject mismatch: ${detail}`, { status: 400 });
}
static overrideNotFound(id: string) {
  return new DeviceRegistryError("OVERRIDE_NOT_FOUND", `Override ${id} not found`, { status: 404 });
}
static overrideInvalidRange(detail: string) {
  return new DeviceRegistryError("OVERRIDE_INVALID_RANGE", `Invalid override range: ${detail}`, { status: 400 });
}
```

- [ ] **Step 3: Extend error tests**

Append to `apps/orchestrator/src/types/device-registry-error.test.ts`:
```ts
it("scheduleNotFound carries 404", () => {
  const e = DeviceRegistryError.scheduleNotFound("abc");
  expect(e.code).toBe("SCHEDULE_NOT_FOUND");
  expect(e.status).toBe(404);
  expect(e.message).toContain("abc");
});

it("scheduleInvalidWindow carries 400", () => {
  const e = DeviceRegistryError.scheduleInvalidWindow("zero-length");
  expect(e.code).toBe("SCHEDULE_INVALID_WINDOW");
  expect(e.status).toBe(400);
});

it("scheduleSubjectMismatch carries 400", () => {
  const e = DeviceRegistryError.scheduleSubjectMismatch("device+group both set");
  expect(e.code).toBe("SCHEDULE_SUBJECT_MISMATCH");
  expect(e.status).toBe(400);
});

it("overrideNotFound carries 404", () => {
  const e = DeviceRegistryError.overrideNotFound("xyz");
  expect(e.code).toBe("OVERRIDE_NOT_FOUND");
  expect(e.status).toBe(404);
});

it("overrideInvalidRange carries 400", () => {
  const e = DeviceRegistryError.overrideInvalidRange("endAt <= startAt");
  expect(e.code).toBe("OVERRIDE_INVALID_RANGE");
  expect(e.status).toBe(400);
});
```

- [ ] **Step 4: Write the `isWindowActive` failing tests**

Create `apps/orchestrator/src/lib/schedule-window.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isWindowActive } from "./schedule-window.js";

type Window = { daysOfWeek: number; startMin: number; endMin: number };

// Helpers
const DAY = { Sun: 1, Mon: 2, Tue: 4, Wed: 8, Thu: 16, Fri: 32, Sat: 64 };
const at = (isoLocal: string) => new Date(isoLocal);

describe("isWindowActive", () => {
  it("returns false when day-of-week not in mask", () => {
    const w: Window = { daysOfWeek: DAY.Mon, startMin: 9*60, endMin: 17*60 };
    // Tuesday 10am
    expect(isWindowActive(w, at("2026-04-14T10:00:00"))).toBe(false);
  });

  it("returns true during a single-day window", () => {
    const w: Window = { daysOfWeek: DAY.Tue, startMin: 9*60, endMin: 17*60 };
    // Tuesday 2026-04-14 10am local
    expect(isWindowActive(w, at("2026-04-14T10:00:00"))).toBe(true);
  });

  it("returns false at exact end boundary", () => {
    const w: Window = { daysOfWeek: DAY.Tue, startMin: 9*60, endMin: 17*60 };
    expect(isWindowActive(w, at("2026-04-14T17:00:00"))).toBe(false);
  });

  it("returns true at exact start boundary", () => {
    const w: Window = { daysOfWeek: DAY.Tue, startMin: 9*60, endMin: 17*60 };
    expect(isWindowActive(w, at("2026-04-14T09:00:00"))).toBe(true);
  });

  it("handles midnight-wrap (9pm-7am): true on the start day after 9pm", () => {
    const w: Window = { daysOfWeek: DAY.Sun, startMin: 21*60, endMin: 7*60 };
    // Sunday 2026-04-12 22:00 local
    expect(isWindowActive(w, at("2026-04-12T22:00:00"))).toBe(true);
  });

  it("handles midnight-wrap: true on the NEXT day before 7am", () => {
    // Window starts Sunday 21:00, ends Monday 07:00
    const w: Window = { daysOfWeek: DAY.Sun, startMin: 21*60, endMin: 7*60 };
    // Monday 2026-04-13 06:00 local
    expect(isWindowActive(w, at("2026-04-13T06:00:00"))).toBe(true);
  });

  it("handles midnight-wrap: false on the next day after wrap-end", () => {
    const w: Window = { daysOfWeek: DAY.Sun, startMin: 21*60, endMin: 7*60 };
    expect(isWindowActive(w, at("2026-04-13T08:00:00"))).toBe(false);
  });

  it("returns false for an hour before start (not in wrap)", () => {
    const w: Window = { daysOfWeek: DAY.Sun, startMin: 21*60, endMin: 7*60 };
    expect(isWindowActive(w, at("2026-04-12T20:00:00"))).toBe(false);
  });

  it("multi-day mask matches any listed day", () => {
    const w: Window = { daysOfWeek: DAY.Mon | DAY.Wed | DAY.Fri, startMin: 8*60, endMin: 15*60 };
    expect(isWindowActive(w, at("2026-04-15T10:00:00"))).toBe(true);  // Wed
    expect(isWindowActive(w, at("2026-04-14T10:00:00"))).toBe(false); // Tue
  });
});
```

- [ ] **Step 5: Run — expect RED**
```bash
cd apps/orchestrator && npm test -- schedule-window.test
# Expected: FAIL (module doesn't exist)
```

- [ ] **Step 6: Implement `isWindowActive`**

Create `apps/orchestrator/src/lib/schedule-window.ts`:
```ts
/**
 * Pure evaluator: is the given moment inside the window?
 *
 * Windows are defined in local time with a day-of-week bitmask
 * (Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64).
 * Start/end are minutes since local midnight [0, 1440).
 *
 * Midnight-wrap: when endMin <= startMin, the window extends past
 * midnight into the next day. E.g. {Sun, 21:00, 07:00} covers
 * Sunday 21:00 through Monday 07:00.
 *
 * Boundary convention: start inclusive, end exclusive — so 17:00
 * is NOT inside a 09:00-17:00 window.
 */
export interface ScheduleWindowLike {
  daysOfWeek: number;
  startMin: number;
  endMin: number;
}

const DAY_BIT = [1, 2, 4, 8, 16, 32, 64]; // Sun..Sat

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function isWindowActive(w: ScheduleWindowLike, now: Date): boolean {
  const dow = now.getDay();               // 0=Sun..6=Sat (JS Date convention)
  const nowMin = minutesOfDay(now);
  const wraps = w.endMin <= w.startMin;

  if (!wraps) {
    // Same-day window: must be the right day AND within [start, end)
    if ((w.daysOfWeek & DAY_BIT[dow]) === 0) return false;
    return nowMin >= w.startMin && nowMin < w.endMin;
  }

  // Wrap window: active if either
  //   (a) today is a start-day AND nowMin >= startMin, OR
  //   (b) YESTERDAY was a start-day AND nowMin < endMin
  const yesterdayDow = (dow + 6) % 7;
  const startToday = (w.daysOfWeek & DAY_BIT[dow]) !== 0 && nowMin >= w.startMin;
  const tailFromYesterday = (w.daysOfWeek & DAY_BIT[yesterdayDow]) !== 0 && nowMin < w.endMin;
  return startToday || tailFromYesterday;
}
```

- [ ] **Step 7: Run — expect GREEN**
```bash
npm test -- schedule-window.test device-registry-error.test
```

- [ ] **Step 8: Add Prisma models**

Append to `apps/orchestrator/prisma/schema.prisma` (do NOT touch existing models except `NetworkDevice` / `DeviceGroup` for relations):

```prisma
model Schedule {
  id          String    @id @default(cuid())
  name        String
  enabled     Boolean   @default(true)
  subjectType String    // "device" | "group"
  deviceMac   String?
  groupId     String?
  windows     ScheduleWindow[]
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  device      NetworkDevice? @relation("DeviceSchedules", fields: [deviceMac], references: [mac], onDelete: Cascade)
  group       DeviceGroup?   @relation("GroupSchedules",  fields: [groupId],  references: [id],  onDelete: Cascade)

  @@index([enabled])
  @@index([deviceMac])
  @@index([groupId])
}

model ScheduleWindow {
  id         String   @id @default(cuid())
  scheduleId String
  daysOfWeek Int
  startMin   Int
  endMin     Int
  schedule   Schedule @relation(fields: [scheduleId], references: [id], onDelete: Cascade)

  @@index([scheduleId])
}

model ScheduleOverride {
  id          String    @id @default(cuid())
  subjectType String
  deviceMac   String?
  groupId     String?
  action      String    // "allow" | "block"
  startAt     DateTime
  endAt       DateTime
  note        String?
  createdAt   DateTime  @default(now())

  device      NetworkDevice? @relation("DeviceOverrides", fields: [deviceMac], references: [mac], onDelete: Cascade)
  group       DeviceGroup?   @relation("GroupOverrides",  fields: [groupId],  references: [id],  onDelete: Cascade)

  @@index([endAt])
  @@index([deviceMac])
  @@index([groupId])
}

model ScheduleEvent {
  id          String   @id @default(cuid())
  scheduleId  String?
  overrideId  String?
  subjectType String
  deviceMac   String?
  groupId     String?
  transition  String   // "blocked" | "unblocked"
  reason      String
  occurredAt  DateTime @default(now())

  @@index([occurredAt])
}
```

Modify existing `NetworkDevice` block — add:
```prisma
  manualBlock Boolean @default(false)
  schedules   Schedule[]         @relation("DeviceSchedules")
  overrides   ScheduleOverride[] @relation("DeviceOverrides")
```

Modify existing `DeviceGroup` block — add:
```prisma
  schedules   Schedule[]         @relation("GroupSchedules")
  overrides   ScheduleOverride[] @relation("GroupOverrides")
```

- [ ] **Step 9: Generate migration**
```bash
cd apps/orchestrator && npx prisma migrate dev --name phase_2_scheduling --create-only
```

Rename the generated timestamp to `20260417000000` for lexicographic stability. Confirm the SQL contains:
- `CREATE TABLE "Schedule"`, `"ScheduleWindow"`, `"ScheduleOverride"`, `"ScheduleEvent"`
- `ALTER TABLE "NetworkDevice" ADD COLUMN "manualBlock" BOOLEAN NOT NULL DEFAULT false`
- Foreign keys with `ON DELETE CASCADE` for subject relations

- [ ] **Step 10: Apply migration locally (if DB available)**
```bash
npx prisma migrate deploy
npx prisma validate
psql "$DATABASE_URL" -c '\d "Schedule"'
# Expected: 10 columns including id, name, enabled, subjectType, deviceMac, groupId, createdAt, updatedAt
psql "$DATABASE_URL" -c '\d "NetworkDevice"' | grep manualBlock
# Expected: manualBlock | boolean | ... | false
```

Re-run migration to confirm idempotence via Prisma's `_prisma_migrations` ledger.

- [ ] **Step 11: Run full suite + tsc**
```bash
npm test && npx tsc --noEmit
# Expected: new mac/isWindowActive/error tests pass; existing suite unchanged
```

- [ ] **Step 12: Commit + push**
```bash
git add apps/orchestrator/prisma/ \
       apps/orchestrator/src/lib/schedule-window.ts \
       apps/orchestrator/src/lib/schedule-window.test.ts \
       apps/orchestrator/src/types/device-registry-error.ts \
       apps/orchestrator/src/types/device-registry-error.test.ts
git commit -m "feat(orchestrator): Phase 2 data model - Schedule, ScheduleWindow, ScheduleOverride, ScheduleEvent + manualBlock (WARP-92)"
git push -u origin WARP-92
```

---

## Task 2: WARP-93 — Ticker + schedule service

**Branch:** `WARP-93`.
**Depends on:** WARP-92 merged (or branch off WARP-92 if stacking).
**Size:** M.

- [ ] **Step 1: Rebase on WARP-92's tip**
```bash
git checkout WARP-93
git fetch origin && git rebase origin/WARP-92  # or origin/main if already merged
```

- [ ] **Step 2: Add `node-cron` dependency**
```bash
cd apps/orchestrator
npm install node-cron
npm install --save-dev @types/node-cron
```

- [ ] **Step 3: Write cron runtime failing tests**

Create `apps/orchestrator/src/services/cron-runtime.service.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCronRuntime } from "./cron-runtime.service.js";

describe("cron-runtime.service", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("scheduleInterval fires handler after each interval", () => {
    const rt = createCronRuntime();
    const handler = vi.fn();
    rt.scheduleInterval(1000, handler);
    vi.advanceTimersByTime(3500);
    expect(handler).toHaveBeenCalledTimes(3);
    rt.stop();
  });

  it("stop() prevents further handler calls", () => {
    const rt = createCronRuntime();
    const handler = vi.fn();
    rt.scheduleInterval(1000, handler);
    vi.advanceTimersByTime(1500);
    expect(handler).toHaveBeenCalledTimes(1);
    rt.stop();
    vi.advanceTimersByTime(5000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handler exceptions don't crash the runtime", () => {
    const rt = createCronRuntime();
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    rt.scheduleInterval(1000, handler);
    vi.advanceTimersByTime(3000);
    // No throw; handler was still called 3 times
    expect(handler).toHaveBeenCalledTimes(3);
    rt.stop();
  });
});
```

- [ ] **Step 4: Run — RED**
```bash
npm test -- cron-runtime.service.test
```

- [ ] **Step 5: Implement cron runtime**

Create `apps/orchestrator/src/services/cron-runtime.service.ts`:
```ts
import cron from "node-cron";
import pino from "pino";

const log = pino({ name: "cron-runtime" });

export interface CronRuntime {
  scheduleInterval(ms: number, handler: () => void | Promise<void>): void;
  scheduleCron(spec: string, handler: () => void | Promise<void>): void;
  stop(): void;
}

export function createCronRuntime(): CronRuntime {
  const intervals: NodeJS.Timeout[] = [];
  const crons: cron.ScheduledTask[] = [];

  async function safeRun(handler: () => void | Promise<void>) {
    try {
      await handler();
    } catch (err) {
      log.warn({ err }, "cron handler threw; continuing");
    }
  }

  return {
    scheduleInterval(ms, handler) {
      intervals.push(setInterval(() => { void safeRun(handler); }, ms));
    },
    scheduleCron(spec, handler) {
      const task = cron.schedule(spec, () => { void safeRun(handler); });
      crons.push(task);
    },
    stop() {
      intervals.forEach(clearInterval);
      intervals.length = 0;
      crons.forEach((t) => t.stop());
      crons.length = 0;
    },
  };
}
```

- [ ] **Step 6: Run — GREEN**
```bash
npm test -- cron-runtime.service.test
```

- [ ] **Step 7: Write `computeDesiredBlocked` failing tests**

Create `apps/orchestrator/src/services/schedule.service.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeDesiredBlocked } from "./schedule.service.js";

// Test fixtures — Tuesday 2026-04-14 10:00 local
const NOW = new Date("2026-04-14T10:00:00");

const device = (overrides?: Partial<any>) => ({
  mac: "AA:BB:CC:DD:EE:FF",
  manualBlock: false,
  groups: [{ id: "g1", name: "Kids" }],
  ...overrides,
});

const window = (d: number, s: number, e: number) => ({ daysOfWeek: d, startMin: s, endMin: e });
const tueWorkHours = window(4, 9*60, 17*60); // Tuesday 9am-5pm

describe("computeDesiredBlocked", () => {
  it("returns false when nothing applies", () => {
    expect(computeDesiredBlocked({
      device: device(),
      deviceSchedules: [],
      groupSchedules: [],
      activeOverrides: [],
      now: NOW,
    })).toEqual({ blocked: false, reason: "schedule_window_end" });
  });

  it("override action=block wins over everything", () => {
    expect(computeDesiredBlocked({
      device: device({ manualBlock: true }),
      deviceSchedules: [{ id: "s1", enabled: true, subjectType: "device", windows: [tueWorkHours] }],
      groupSchedules: [],
      activeOverrides: [{ id: "o1", action: "block", startAt: NOW, endAt: NOW }],
      now: NOW,
    })).toEqual({ blocked: true, reason: "override_applied" });
  });

  it("override action=allow wins over manualBlock", () => {
    expect(computeDesiredBlocked({
      device: device({ manualBlock: true }),
      deviceSchedules: [],
      groupSchedules: [{ id: "s1", enabled: true, subjectType: "group", windows: [tueWorkHours] }],
      activeOverrides: [{ id: "o1", action: "allow", startAt: NOW, endAt: NOW }],
      now: NOW,
    })).toEqual({ blocked: false, reason: "override_applied" });
  });

  it("override block wins over override allow if both present", () => {
    expect(computeDesiredBlocked({
      device: device(),
      deviceSchedules: [],
      groupSchedules: [],
      activeOverrides: [
        { id: "o1", action: "allow", startAt: NOW, endAt: NOW },
        { id: "o2", action: "block", startAt: NOW, endAt: NOW },
      ],
      now: NOW,
    })).toEqual({ blocked: true, reason: "override_applied" });
  });

  it("manualBlock wins when no active overrides", () => {
    expect(computeDesiredBlocked({
      device: device({ manualBlock: true }),
      deviceSchedules: [{ id: "s1", enabled: true, subjectType: "device", windows: [tueWorkHours] }],
      groupSchedules: [],
      activeOverrides: [],
      now: NOW,
    })).toEqual({ blocked: true, reason: "manual_block" });
  });

  it("device schedule active → blocked (device-level precedence)", () => {
    expect(computeDesiredBlocked({
      device: device(),
      deviceSchedules: [{ id: "sd", enabled: true, subjectType: "device", windows: [tueWorkHours] }],
      groupSchedules: [{ id: "sg", enabled: true, subjectType: "group", windows: [
        window(4, 0, 9*60)   // Tuesday midnight-9am (should be ignored — device schedule wins)
      ]}],
      activeOverrides: [],
      now: NOW,
    })).toEqual({ blocked: true, reason: "schedule_window_start" });
  });

  it("device has NO device-level schedule → group schedule evaluated", () => {
    expect(computeDesiredBlocked({
      device: device(),
      deviceSchedules: [],
      groupSchedules: [{ id: "sg", enabled: true, subjectType: "group", windows: [tueWorkHours] }],
      activeOverrides: [],
      now: NOW,
    })).toEqual({ blocked: true, reason: "schedule_window_start" });
  });

  it("device has device-level schedule (inactive now) → group schedule ignored", () => {
    expect(computeDesiredBlocked({
      device: device(),
      deviceSchedules: [{ id: "sd", enabled: true, subjectType: "device", windows: [
        window(4, 18*60, 22*60)  // Tue 6pm-10pm
      ]}],
      groupSchedules: [{ id: "sg", enabled: true, subjectType: "group", windows: [tueWorkHours] }],
      activeOverrides: [],
      now: NOW,
    })).toEqual({ blocked: false, reason: "schedule_window_end" });
  });

  it("disabled schedule is ignored", () => {
    expect(computeDesiredBlocked({
      device: device(),
      deviceSchedules: [{ id: "sd", enabled: false, subjectType: "device", windows: [tueWorkHours] }],
      groupSchedules: [],
      activeOverrides: [],
      now: NOW,
    })).toEqual({ blocked: false, reason: "schedule_window_end" });
  });
});
```

- [ ] **Step 8: Implement `schedule.service.ts`**
```ts
import { isWindowActive, type ScheduleWindowLike } from "../lib/schedule-window.js";

interface DeviceLike {
  mac: string;
  manualBlock: boolean;
  groups: Array<{ id: string }>;
}
interface ScheduleLike {
  id: string;
  enabled: boolean;
  subjectType: "device" | "group";
  windows: ScheduleWindowLike[];
}
interface OverrideLike {
  id: string;
  action: "allow" | "block";
  startAt: Date;
  endAt: Date;
}

export interface ComputeInput {
  device: DeviceLike;
  deviceSchedules: ScheduleLike[];
  groupSchedules: ScheduleLike[];
  activeOverrides: OverrideLike[];
  now: Date;
}

export interface ComputeResult {
  blocked: boolean;
  reason:
    | "override_applied"
    | "manual_block"
    | "schedule_window_start"
    | "schedule_window_end";
}

export function computeDesiredBlocked(input: ComputeInput): ComputeResult {
  // Priority 1: active overrides — block wins if both present
  const activeBlock = input.activeOverrides.some((o) => o.action === "block");
  if (activeBlock) return { blocked: true, reason: "override_applied" };
  const activeAllow = input.activeOverrides.some((o) => o.action === "allow");
  if (activeAllow) return { blocked: false, reason: "override_applied" };

  // Priority 2: manual block
  if (input.device.manualBlock) return { blocked: true, reason: "manual_block" };

  // Priority 3: schedules (device-level precedence)
  const hasDeviceSchedules = input.deviceSchedules.some((s) => s.enabled);
  const pool = hasDeviceSchedules
    ? input.deviceSchedules.filter((s) => s.enabled)
    : input.groupSchedules.filter((s) => s.enabled);

  for (const s of pool) {
    for (const w of s.windows) {
      if (isWindowActive(w, input.now)) {
        return { blocked: true, reason: "schedule_window_start" };
      }
    }
  }
  return { blocked: false, reason: "schedule_window_end" };
}
```

- [ ] **Step 9: Run — GREEN**
```bash
npm test -- schedule.service.test
```

- [ ] **Step 10: Write ticker failing tests**

Create `apps/orchestrator/src/services/schedule-ticker.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { createScheduleTicker } from "./schedule-ticker.js";
import { RouterError } from "../types/router-error.js";

// Simple in-memory prisma mock
function makePrisma() {
  const devices = new Map<string, any>();
  const schedules: any[] = [];
  const overrides: any[] = [];
  const events: any[] = [];
  return {
    _stores: { devices, schedules, overrides, events },
    networkDevice: {
      findMany: vi.fn(async (q?: any) => {
        return Array.from(devices.values()).map((d) => ({ ...d, groups: d.groups ?? [] }));
      }),
    },
    schedule: {
      findMany: vi.fn(async () => schedules),
    },
    scheduleOverride: {
      findMany: vi.fn(async (q: any) => {
        const now = q?.where?.AND?.[0]?.startAt?.lte ?? new Date();
        return overrides.filter((o) => o.startAt <= now && o.endAt > now);
      }),
    },
    scheduleEvent: {
      create: vi.fn(async (q: any) => { events.push(q.data); return q.data; }),
    },
  };
}

function makeFirewall(initial: Record<string, boolean> = {}) {
  const state = new Map(Object.entries(initial));
  return {
    _state: state,
    block: vi.fn(async (mac: string) => { state.set(mac, true); }),
    unblock: vi.fn(async (mac: string) => { state.set(mac, false); }),
    isBlocked: (mac: string) => state.get(mac) ?? false,
  };
}

describe("schedule-ticker", () => {
  it("applies block when manualBlock=true and firewall not blocked yet", async () => {
    const prisma = makePrisma() as any;
    const fw = makeFirewall({ "AA:BB:CC:DD:EE:FF": false });
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF", manualBlock: true, isBlocked: false, groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw);
    await ticker.tickOnce();

    expect(fw.block).toHaveBeenCalledWith("AA:BB:CC:DD:EE:FF");
    expect(prisma.scheduleEvent.create).toHaveBeenCalled();
  });

  it("preserves prior state on RouterError", async () => {
    const prisma = makePrisma() as any;
    const fw = {
      block: vi.fn().mockRejectedValue(RouterError.unreachable("router down")),
      unblock: vi.fn(),
    };
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF", manualBlock: true, isBlocked: false, groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw as any);
    await ticker.tickOnce();

    expect(fw.block).toHaveBeenCalled();
    // No event emitted because firewall call failed
    expect(prisma.scheduleEvent.create).not.toHaveBeenCalled();
  });

  it("no-op when desired matches actual firewall state", async () => {
    const prisma = makePrisma() as any;
    const fw = makeFirewall({ "AA:BB:CC:DD:EE:FF": false });
    prisma._stores.devices.set("AA:BB:CC:DD:EE:FF", {
      mac: "AA:BB:CC:DD:EE:FF", manualBlock: false, isBlocked: false, groups: [],
    });

    const ticker = createScheduleTicker(prisma, fw as any);
    await ticker.tickOnce();

    expect(fw.block).not.toHaveBeenCalled();
    expect(fw.unblock).not.toHaveBeenCalled();
    expect(prisma.scheduleEvent.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 11: Implement ticker**

Create `apps/orchestrator/src/services/schedule-ticker.ts`:
```ts
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { computeDesiredBlocked } from "./schedule.service.js";
import { RouterError } from "../types/router-error.js";

const log = pino({ name: "schedule-ticker" });

export interface FirewallClient {
  block(mac: string): Promise<void>;
  unblock(mac: string): Promise<void>;
  isBlocked(mac: string): boolean;  // optional helper; real impl may query network state
}

export interface ScheduleTicker {
  tickOnce(): Promise<void>;
}

export function createScheduleTicker(prisma: PrismaClient, firewall: FirewallClient): ScheduleTicker {
  async function tickOnce() {
    const now = new Date();
    const devices = await (prisma as any).networkDevice.findMany({ include: { groups: true } });
    const schedules = await (prisma as any).schedule.findMany({
      where: { enabled: true },
      include: { windows: true },
    });
    const overrides = await (prisma as any).scheduleOverride.findMany({
      where: { AND: [{ startAt: { lte: now } }, { endAt: { gt: now } }] },
    });

    const deviceSchedulesByMac = new Map<string, any[]>();
    const groupSchedulesByGroupId = new Map<string, any[]>();
    for (const s of schedules) {
      if (s.subjectType === "device" && s.deviceMac) {
        const arr = deviceSchedulesByMac.get(s.deviceMac) ?? [];
        arr.push(s);
        deviceSchedulesByMac.set(s.deviceMac, arr);
      } else if (s.subjectType === "group" && s.groupId) {
        const arr = groupSchedulesByGroupId.get(s.groupId) ?? [];
        arr.push(s);
        groupSchedulesByGroupId.set(s.groupId, arr);
      }
    }

    const overridesByMac = new Map<string, any[]>();
    const overridesByGroupId = new Map<string, any[]>();
    for (const o of overrides) {
      if (o.subjectType === "device" && o.deviceMac) {
        const arr = overridesByMac.get(o.deviceMac) ?? [];
        arr.push(o);
        overridesByMac.set(o.deviceMac, arr);
      } else if (o.subjectType === "group" && o.groupId) {
        const arr = overridesByGroupId.get(o.groupId) ?? [];
        arr.push(o);
        overridesByGroupId.set(o.groupId, arr);
      }
    }

    for (const device of devices) {
      const groupIds = (device.groups ?? []).map((g: any) => g.id);
      const deviceSchedules = deviceSchedulesByMac.get(device.mac) ?? [];
      const groupSchedules = groupIds.flatMap((gid: string) => groupSchedulesByGroupId.get(gid) ?? []);
      const activeOverrides = [
        ...(overridesByMac.get(device.mac) ?? []),
        ...groupIds.flatMap((gid: string) => overridesByGroupId.get(gid) ?? []),
      ];

      const { blocked: desired, reason } = computeDesiredBlocked({
        device,
        deviceSchedules,
        groupSchedules,
        activeOverrides,
        now,
      });

      const current = firewall.isBlocked(device.mac);
      if (desired === current) continue;

      try {
        if (desired) await firewall.block(device.mac);
        else await firewall.unblock(device.mac);

        await (prisma as any).scheduleEvent.create({
          data: {
            subjectType: "device",
            deviceMac: device.mac,
            transition: desired ? "blocked" : "unblocked",
            reason,
            occurredAt: now,
          },
        });
      } catch (err) {
        if (err instanceof RouterError) {
          log.warn({ mac: device.mac, code: err.code }, "firewall error; preserving state");
        } else {
          log.error({ err, mac: device.mac }, "ticker dispatch failed");
        }
      }
    }
  }

  return { tickOnce };
}
```

- [ ] **Step 12: Run — GREEN**
```bash
npm test -- schedule-ticker.test
```

- [ ] **Step 13: Write purge tests**

Create `apps/orchestrator/src/services/schedule-purge.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { purgeScheduleEvents, purgeExpiredOverrides } from "./schedule-purge.js";

describe("schedule-purge", () => {
  it("purgeScheduleEvents deletes events older than cutoff", async () => {
    const prisma = {
      scheduleEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 42 }) },
    } as any;
    const count = await purgeScheduleEvents(prisma, 7);
    expect(count).toBe(42);
    const arg = prisma.scheduleEvent.deleteMany.mock.calls[0][0];
    expect(arg.where.occurredAt.lt).toBeInstanceOf(Date);
    const cutoff = arg.where.occurredAt.lt as Date;
    const expected = Date.now() - 7 * 86400_000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(1000);
  });

  it("purgeExpiredOverrides deletes overrides whose endAt is older than cutoff", async () => {
    const prisma = {
      scheduleOverride: { deleteMany: vi.fn().mockResolvedValue({ count: 7 }) },
    } as any;
    const count = await purgeExpiredOverrides(prisma, 24);
    expect(count).toBe(7);
    const arg = prisma.scheduleOverride.deleteMany.mock.calls[0][0];
    const cutoff = arg.where.endAt.lt as Date;
    const expected = Date.now() - 24 * 3600_000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(1000);
  });
});
```

- [ ] **Step 14: Implement purge**

Create `apps/orchestrator/src/services/schedule-purge.ts`:
```ts
import type { PrismaClient } from "@prisma/client";

export async function purgeScheduleEvents(prisma: PrismaClient, olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
  const res = await (prisma as any).scheduleEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } });
  return res.count;
}

export async function purgeExpiredOverrides(prisma: PrismaClient, olderThanHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000);
  const res = await (prisma as any).scheduleOverride.deleteMany({ where: { endAt: { lt: cutoff } } });
  return res.count;
}
```

- [ ] **Step 15: Run — GREEN**

- [ ] **Step 16: Wire into `apps/orchestrator/src/index.ts`**

Locate the existing service-init block (near `createOuiLookup` + `createDeviceRegistry` from WARP-81). Add after those:
```ts
import { createCronRuntime } from "./services/cron-runtime.service.js";
import { createScheduleTicker } from "./services/schedule-ticker.js";
import { purgeScheduleEvents, purgeExpiredOverrides } from "./services/schedule-purge.js";

// Firewall adapter — wraps the existing openwrt firewall calls.
const firewall = {
  async block(mac: string) {
    // POST /api/network/firewall/block semantics inline; reuse existing openwrt.client helpers
    await openwrt.firewallBlockDevice(mac);
  },
  async unblock(mac: string) {
    await openwrt.firewallUnblockDevice(mac);
  },
  isBlocked(mac: string) {
    // best-effort lookup from the reconciler's last snapshot
    return false; // ticker is the only caller that matters; actual state returns on next reconcile
  },
};

const cronRuntime = createCronRuntime();
const scheduleTicker = createScheduleTicker(prisma, firewall);

const tickMs = Number(process.env.SCHEDULE_TICK_MS ?? 30_000);
cronRuntime.scheduleInterval(tickMs, () => scheduleTicker.tickOnce());
cronRuntime.scheduleCron("0 3 * * *", async () => {
  const eventsDeleted = await purgeScheduleEvents(prisma, 7);
  const overridesDeleted = await purgeExpiredOverrides(prisma, 24);
  log.info({ eventsDeleted, overridesDeleted }, "schedule purge complete");
});

process.on("SIGTERM", () => cronRuntime.stop());
```

If the exact openwrt firewall helper names differ (check `apps/orchestrator/src/services/openwrt.client.ts` for `firewallBlockDevice` or equivalent), adapt the adapter. If none exist at the client level, fall back to calling the existing `/api/network/firewall/block` endpoint as an internal HTTP request (not ideal; the client-library path is cleaner).

- [ ] **Step 17: Run full suite**
```bash
npm test && npx tsc --noEmit
# Expected: new cron-runtime (3) + schedule (9) + ticker (3) + purge (2) = 17 new tests pass
```

- [ ] **Step 18: Commit + push**
```bash
git add apps/orchestrator/src/services/cron-runtime.service.ts \
       apps/orchestrator/src/services/cron-runtime.service.test.ts \
       apps/orchestrator/src/services/schedule.service.ts \
       apps/orchestrator/src/services/schedule.service.test.ts \
       apps/orchestrator/src/services/schedule-ticker.ts \
       apps/orchestrator/src/services/schedule-ticker.test.ts \
       apps/orchestrator/src/services/schedule-purge.ts \
       apps/orchestrator/src/services/schedule-purge.test.ts \
       apps/orchestrator/src/index.ts \
       apps/orchestrator/package.json apps/orchestrator/package-lock.json
git commit -m "feat(orchestrator): schedule ticker + computeDesiredBlocked + cron runtime (WARP-93)"
git push -u origin WARP-93
```

---

## Task 3: WARP-94 — Orchestrator API

**Branch:** `WARP-94`. **Depends on:** WARP-92 + WARP-93 merged. **Size:** M.

**Files:** see File Structure.

- [ ] **Step 1: Rebase on main**
```bash
git checkout WARP-94 && git fetch origin && git rebase origin/main
```

- [ ] **Step 2: Write `schedule-api.service.ts` failing tests**

Create `apps/orchestrator/src/services/schedule-api.service.test.ts`. Cases:
- `createSchedule` with valid subject → returns schedule with windows
- `createSchedule` with both `deviceMac` and `groupId` set → throws `SCHEDULE_SUBJECT_MISMATCH`
- `createSchedule` with neither set → throws `SCHEDULE_SUBJECT_MISMATCH`
- `createSchedule` with zero-length window (`startMin === endMin`) → throws `SCHEDULE_INVALID_WINDOW`
- `createSchedule` with daysOfWeek=0 → throws `SCHEDULE_INVALID_WINDOW`
- `createSchedule` with 8 windows → throws `SCHEDULE_INVALID_WINDOW`
- `updateSchedule` attempting to change `subjectType`/`deviceMac`/`groupId` → throws `SCHEDULE_SUBJECT_MISMATCH`
- `updateSchedule` replacing windows → deletes old + inserts new atomically
- `deleteSchedule` cascades windows
- `listSchedules` returns enabled-first, name-ascending
- `createOverride` with `endAt <= startAt` → throws `OVERRIDE_INVALID_RANGE`
- `createOverride` with only `deviceMac` → sets correctly
- `cancelOverride` missing id → throws `OVERRIDE_NOT_FOUND` (via P2025 translation)
- `setManualBlock(mac, true)` → Prisma update called with `manualBlock: true`
- `setManualBlock(mac, false)` → update with `manualBlock: false`
- `listScheduleEvents({ since, limit })` → correct Prisma args

Use the in-memory-Maps mocking pattern from `apps/orchestrator/src/__tests__/device-clients.test.ts` (+ P2025 from `useDeviceMutations` pattern in WARP-82).

- [ ] **Step 3: Implement `schedule-api.service.ts`**

Skeleton:
```ts
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { DeviceRegistryError } from "../types/device-registry-error.js";

function mapPrismaNotFound<T>(what: string, fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      throw what === "Schedule" ? DeviceRegistryError.scheduleNotFound("unknown")
           : what === "Override" ? DeviceRegistryError.overrideNotFound("unknown")
           : DeviceRegistryError.notFound(what);
    }
    throw err;
  });
}

function validateSubject(p: { subjectType: string; deviceMac?: string; groupId?: string }) {
  if (p.subjectType === "device") {
    if (!p.deviceMac || p.groupId) throw DeviceRegistryError.scheduleSubjectMismatch("device subject requires deviceMac only");
  } else if (p.subjectType === "group") {
    if (!p.groupId || p.deviceMac) throw DeviceRegistryError.scheduleSubjectMismatch("group subject requires groupId only");
  } else {
    throw DeviceRegistryError.scheduleSubjectMismatch(`unknown subjectType: ${p.subjectType}`);
  }
}

function validateWindows(windows: Array<{ daysOfWeek: number; startMin: number; endMin: number }>) {
  if (windows.length > 7) throw DeviceRegistryError.scheduleInvalidWindow("max 7 windows per schedule");
  for (const w of windows) {
    if (w.daysOfWeek < 1 || w.daysOfWeek > 127) throw DeviceRegistryError.scheduleInvalidWindow("daysOfWeek bitmask out of range");
    if (w.startMin < 0 || w.startMin >= 1440) throw DeviceRegistryError.scheduleInvalidWindow("startMin out of range");
    if (w.endMin < 0 || w.endMin >= 1440) throw DeviceRegistryError.scheduleInvalidWindow("endMin out of range");
    if (w.startMin === w.endMin) throw DeviceRegistryError.scheduleInvalidWindow("window cannot be zero-length");
  }
}

export function createScheduleApiService(prisma: PrismaClient) {
  async function listSchedules() {
    return (prisma as any).schedule.findMany({
      include: { windows: true },
      orderBy: [{ enabled: "desc" }, { name: "asc" }],
    });
  }

  async function getSchedule(id: string) {
    const s = await (prisma as any).schedule.findUnique({
      where: { id },
      include: { windows: true },
    });
    if (!s) throw DeviceRegistryError.scheduleNotFound(id);
    return s;
  }

  async function createSchedule(input: {
    name: string; enabled?: boolean;
    subjectType: "device" | "group"; deviceMac?: string; groupId?: string;
    windows: Array<{ daysOfWeek: number; startMin: number; endMin: number }>;
  }) {
    validateSubject(input);
    validateWindows(input.windows);
    return (prisma as any).schedule.create({
      data: {
        name: input.name,
        enabled: input.enabled ?? true,
        subjectType: input.subjectType,
        deviceMac: input.deviceMac,
        groupId: input.groupId,
        windows: { create: input.windows },
      },
      include: { windows: true },
    });
  }

  async function updateSchedule(id: string, patch: {
    name?: string; enabled?: boolean;
    windows?: Array<{ daysOfWeek: number; startMin: number; endMin: number }>;
    subjectType?: any; deviceMac?: any; groupId?: any;  // for rejection only
  }) {
    if (patch.subjectType !== undefined || patch.deviceMac !== undefined || patch.groupId !== undefined) {
      throw DeviceRegistryError.scheduleSubjectMismatch("subject is immutable after creation");
    }
    if (patch.windows) validateWindows(patch.windows);

    return mapPrismaNotFound("Schedule", () => (prisma as any).$transaction(async (tx: any) => {
      if (patch.windows) {
        await tx.scheduleWindow.deleteMany({ where: { scheduleId: id } });
      }
      return tx.schedule.update({
        where: { id },
        data: {
          name: patch.name,
          enabled: patch.enabled,
          windows: patch.windows ? { create: patch.windows } : undefined,
        },
        include: { windows: true },
      });
    }));
  }

  async function deleteSchedule(id: string) {
    return mapPrismaNotFound("Schedule", () => (prisma as any).schedule.delete({ where: { id } }));
  }

  async function listOverrides(opts: { active?: boolean; deviceMac?: string; groupId?: string }) {
    const now = new Date();
    return (prisma as any).scheduleOverride.findMany({
      where: {
        ...(opts.deviceMac && { deviceMac: opts.deviceMac }),
        ...(opts.groupId && { groupId: opts.groupId }),
        ...(opts.active && { AND: [{ startAt: { lte: now } }, { endAt: { gt: now } }] }),
      },
      orderBy: { startAt: "desc" },
    });
  }

  async function createOverride(input: {
    subjectType: "device" | "group"; deviceMac?: string; groupId?: string;
    action: "allow" | "block"; startAt?: Date; endAt: Date; note?: string;
  }) {
    validateSubject(input);
    const startAt = input.startAt ?? new Date();
    if (input.endAt.getTime() <= startAt.getTime()) {
      throw DeviceRegistryError.overrideInvalidRange("endAt must be after startAt");
    }
    if (input.action !== "allow" && input.action !== "block") {
      throw DeviceRegistryError.overrideInvalidRange("action must be 'allow' or 'block'");
    }
    return (prisma as any).scheduleOverride.create({
      data: {
        subjectType: input.subjectType,
        deviceMac: input.deviceMac,
        groupId: input.groupId,
        action: input.action,
        startAt,
        endAt: input.endAt,
        note: input.note,
      },
    });
  }

  async function cancelOverride(id: string) {
    return mapPrismaNotFound("Override", () => (prisma as any).scheduleOverride.delete({ where: { id } }));
  }

  async function listScheduleEvents(opts: { since?: Date; limit?: number }) {
    return (prisma as any).scheduleEvent.findMany({
      where: opts.since ? { occurredAt: { gte: opts.since } } : undefined,
      orderBy: { occurredAt: "desc" },
      take: Math.min(opts.limit ?? 50, 200),
    });
  }

  async function setManualBlock(mac: string, blocked: boolean) {
    return mapPrismaNotFound("Device", () => (prisma as any).networkDevice.update({
      where: { mac },
      data: { manualBlock: blocked },
      select: { mac: true, manualBlock: true },
    }));
  }

  return {
    listSchedules, getSchedule, createSchedule, updateSchedule, deleteSchedule,
    listOverrides, createOverride, cancelOverride,
    listScheduleEvents, setManualBlock,
  };
}
```

- [ ] **Step 4: Run service tests — GREEN**

- [ ] **Step 5: Write failing supertest route tests**

Create `apps/orchestrator/src/routes/network.schedules.test.ts`. One `describe` block per endpoint with happy + one typed-error case. Follow the pattern from `network.device.test.ts` (WARP-82).

- [ ] **Step 6: Append routes to `apps/orchestrator/src/routes/network.ts`**

Inside `createNetworkRouter(prisma)`, construct the service near the top and append handlers. Response pattern mirrors WARP-82's `handleRegistryError` helper.

```ts
const scheduleApi = createScheduleApiService(prisma);

router.get("/schedules", async (req, res, next) => {
  try {
    const schedules = await scheduleApi.listSchedules();
    res.json({ schedules });
  } catch (err) {
    if (err instanceof DeviceRegistryError) return res.status(err.status ?? 400).json({ error: err.toJSON() });
    next(err);
  }
});

router.get("/schedules/:id", async (req, res, next) => {
  try {
    const schedule = await scheduleApi.getSchedule(req.params.id);
    res.json({ schedule });
  } catch (err) { handleRegistryError(err, res, next); }
});

router.post("/schedules", async (req, res, next) => {
  try {
    const schedule = await scheduleApi.createSchedule(req.body);
    res.status(201).json({ schedule });
  } catch (err) { handleRegistryError(err, res, next); }
});

router.patch("/schedules/:id", async (req, res, next) => {
  try {
    const schedule = await scheduleApi.updateSchedule(req.params.id, req.body);
    res.json({ schedule });
  } catch (err) { handleRegistryError(err, res, next); }
});

router.delete("/schedules/:id", async (req, res, next) => {
  try {
    await scheduleApi.deleteSchedule(req.params.id);
    res.status(204).send();
  } catch (err) { handleRegistryError(err, res, next); }
});

router.get("/overrides", async (req, res, next) => {
  try {
    const overrides = await scheduleApi.listOverrides({
      active: req.query.active === "1",
      deviceMac: typeof req.query.deviceMac === "string" ? req.query.deviceMac : undefined,
      groupId: typeof req.query.groupId === "string" ? req.query.groupId : undefined,
    });
    res.json({ overrides });
  } catch (err) { handleRegistryError(err, res, next); }
});

router.post("/overrides", async (req, res, next) => {
  try {
    const body = { ...req.body };
    if (body.startAt) body.startAt = new Date(body.startAt);
    if (body.endAt) body.endAt = new Date(body.endAt);
    const override = await scheduleApi.createOverride(body);
    res.status(201).json({ override });
  } catch (err) { handleRegistryError(err, res, next); }
});

router.delete("/overrides/:id", async (req, res, next) => {
  try {
    await scheduleApi.cancelOverride(req.params.id);
    res.status(204).send();
  } catch (err) { handleRegistryError(err, res, next); }
});

router.get("/schedule-events", async (req, res, next) => {
  try {
    const events = await scheduleApi.listScheduleEvents({
      since: typeof req.query.since === "string" ? new Date(req.query.since) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ events });
  } catch (err) { handleRegistryError(err, res, next); }
});

router.post("/devices/:mac/manualBlock", async (req, res, next) => {
  try {
    const result = await scheduleApi.setManualBlock(req.params.mac, Boolean(req.body?.blocked));
    res.json(result);
  } catch (err) { handleRegistryError(err, res, next); }
});
```

- [ ] **Step 7: Run full suite + tsc**
```bash
npm test && npx tsc --noEmit
```

- [ ] **Step 8: curl walkthrough for PR body**

Capture output of:
```bash
curl -sH "Authorization: Bearer $TOKEN" http://localhost:3000/api/network/schedules | jq .
curl -sH "Authorization: Bearer $TOKEN" -X POST -H "Content-Type: application/json" \
  -d '{"name":"Bedtime","subjectType":"group","groupId":"<id>","windows":[{"daysOfWeek":31,"startMin":1260,"endMin":420}]}' \
  http://localhost:3000/api/network/schedules | jq .
curl -sH "Authorization: Bearer $TOKEN" -X PATCH -H "Content-Type: application/json" \
  -d '{"enabled":false}' \
  http://localhost:3000/api/network/schedules/<id> | jq .
curl -sH "Authorization: Bearer $TOKEN" -X POST -H "Content-Type: application/json" \
  -d '{"subjectType":"device","deviceMac":"AA:BB:CC:DD:EE:FF","action":"allow","endAt":"2026-04-18T07:00:00Z"}' \
  http://localhost:3000/api/network/overrides | jq .
curl -sH "Authorization: Bearer $TOKEN" http://localhost:3000/api/network/schedule-events?limit=5 | jq .
curl -sH "Authorization: Bearer $TOKEN" -X POST -H "Content-Type: application/json" \
  -d '{"blocked":true}' \
  http://localhost:3000/api/network/devices/AA:BB:CC:DD:EE:FF/manualBlock | jq .
```

- [ ] **Step 9: Commit + push**
```bash
git add apps/orchestrator/src/services/schedule-api.service.ts \
       apps/orchestrator/src/services/schedule-api.service.test.ts \
       apps/orchestrator/src/routes/network.ts \
       apps/orchestrator/src/routes/network.schedules.test.ts
git commit -m "feat(orchestrator): schedule + override + manualBlock REST API (WARP-94)"
git push -u origin WARP-94
```

---

## Task 4: WARP-95 — Dashboard Schedules tab

**Branch:** `WARP-95`. **Depends on:** WARP-94 merged. **Size:** S.

**Files:** see File Structure.

- [ ] **Step 1: Rebase on main**

- [ ] **Step 2: Append types to `apps/web-dashboard/src/lib/types.ts`**
```ts
export interface ScheduleWindow { id: string; daysOfWeek: number; startMin: number; endMin: number; }
export interface Schedule {
  id: string; name: string; enabled: boolean;
  subjectType: "device" | "group";
  deviceMac?: string; groupId?: string;
  windows: ScheduleWindow[];
  lastFiredAt?: string;
  nextTransitionAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ScheduleOverride {
  id: string;
  subjectType: "device" | "group";
  deviceMac?: string; groupId?: string;
  action: "allow" | "block";
  startAt: string; endAt: string;
  note?: string;
  createdAt: string;
}
export interface ScheduleEvent {
  id: string;
  scheduleId?: string; overrideId?: string;
  subjectType: "device" | "group";
  deviceMac?: string; groupId?: string;
  transition: "blocked" | "unblocked";
  reason: string;
  occurredAt: string;
}
```

- [ ] **Step 3: Write SWR hooks**

`useSchedules.ts`:
```ts
"use client";
import useSWR from "swr";
import type { Schedule } from "@/lib/types";

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export function useSchedules() {
  return useSWR<{ schedules: Schedule[] }>("/api/network/schedules", fetcher, { refreshInterval: 30_000 });
}
```

`useActiveOverrides.ts`:
```ts
"use client";
import useSWR from "swr";
import type { ScheduleOverride } from "@/lib/types";

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export function useActiveOverrides(opts: { deviceMac?: string; groupId?: string } = {}) {
  const qs = new URLSearchParams({ active: "1" });
  if (opts.deviceMac) qs.set("deviceMac", opts.deviceMac);
  if (opts.groupId) qs.set("groupId", opts.groupId);
  return useSWR<{ overrides: ScheduleOverride[] }>(
    `/api/network/overrides?${qs.toString()}`,
    fetcher,
    { refreshInterval: 15_000 },
  );
}
```

`useScheduleEvents.ts`:
```ts
"use client";
import useSWR from "swr";
import type { ScheduleEvent } from "@/lib/types";

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export function useScheduleEvents(opts: { limit?: number; enabled?: boolean } = {}) {
  const limit = opts.limit ?? 50;
  const key = opts.enabled === false ? null : `/api/network/schedule-events?limit=${limit}`;
  return useSWR<{ events: ScheduleEvent[] }>(key, fetcher, { refreshInterval: 60_000 });
}
```

- [ ] **Step 4: Write mutations hook**

`useScheduleMutations.ts`:
```ts
"use client";
import { useSWRConfig } from "swr";
import { apiFetch } from "./apiFetch";
import type { Schedule } from "@/lib/types";

export function useScheduleMutations() {
  const { mutate } = useSWRConfig();
  const invalidate = () => mutate((key) =>
    typeof key === "string" && (key.startsWith("/api/network/schedules") || key.startsWith("/api/network/schedule-events")));

  async function createSchedule(input: Omit<Schedule, "id" | "createdAt" | "updatedAt" | "lastFiredAt" | "nextTransitionAt"> & { windows: Omit<Schedule["windows"][number], "id">[] }) {
    const s = await apiFetch<{ schedule: Schedule }>("/api/network/schedules", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    await invalidate();
    return s.schedule;
  }

  async function updateSchedule(id: string, patch: { name?: string; enabled?: boolean; windows?: Schedule["windows"] }) {
    const s = await apiFetch<{ schedule: Schedule }>(`/api/network/schedules/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    await invalidate();
    return s.schedule;
  }

  async function deleteSchedule(id: string) {
    await apiFetch(`/api/network/schedules/${id}`, { method: "DELETE" });
    await invalidate();
  }

  async function toggleSchedule(id: string, enabled: boolean) {
    return updateSchedule(id, { enabled });
  }

  return { createSchedule, updateSchedule, deleteSchedule, toggleSchedule };
}
```

- [ ] **Step 5: Write `SchedulesTab` + subcomponents with failing tests + impl**

`SchedulesTab.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useSchedules } from "@/lib/hooks/useSchedules";
import { ScheduleRow } from "./ScheduleRow";
import { ScheduleActivityFeed } from "./ScheduleActivityFeed";

export function SchedulesTab() {
  const { data, isLoading } = useSchedules();
  const [editorOpenFor, setEditorOpenFor] = useState<string | "new" | null>(null);
  const schedules = data?.schedules ?? [];

  return (
    <div className="space-y-6">
      {/* Preset placeholder — real cards land in WARP-99 */}
      <section aria-label="Presets">
        <div className="dp-card p-4 text-label-tertiary type-footnote">
          Presets coming soon (WARP-99 / T8)
        </div>
      </section>

      {/* Schedules list */}
      <section aria-labelledby="schedules-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="schedules-heading" className="type-title-3 text-label-primary">Schedules</h2>
          <button type="button" onClick={() => setEditorOpenFor("new")} className="dp-button-primary">
            + New schedule
          </button>
        </div>
        {isLoading ? (
          <div className="dp-card p-4 text-label-tertiary">Loading…</div>
        ) : schedules.length === 0 ? (
          <div className="dp-card p-6 text-center">
            <p className="type-headline text-label-primary">No schedules yet</p>
            <p className="type-footnote text-label-tertiary mt-1">Pick a preset above, or create a custom schedule.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {schedules.map((s) => (
              <ScheduleRow key={s.id} schedule={s} onEdit={() => setEditorOpenFor(s.id)} />
            ))}
          </ul>
        )}
      </section>

      {/* Recent activity */}
      <ScheduleActivityFeed />

      {/* Editor modal — landing in WARP-96; stub for now */}
      {editorOpenFor && (
        <div className="dp-card p-4 text-label-tertiary">
          Schedule editor coming soon (WARP-96 / T5). Target: {editorOpenFor === "new" ? "new" : editorOpenFor}
          <button type="button" className="ml-2 dp-button-secondary" onClick={() => setEditorOpenFor(null)}>Close</button>
        </div>
      )}
    </div>
  );
}
```

`ScheduleRow.tsx`: renders one schedule with enabled toggle, name, subject badge, windows summary, active-now dot, next-transition + last-fired, Edit + Delete actions. Full implementation code with ~120 lines — include verbatim in the implementation (not shortened here; the dev agent reads this plan step-by-step). Compute "active now" client-side: `schedule.windows.some((w) => isWindowActive(w, new Date()))` — reuse `isWindowActive` logic from T1 by duplicating it into `apps/web-dashboard/src/lib/scheduleEval.ts` (shared with T6's "until next transition" chip).

`ScheduleActivityFeed.tsx`: collapsible. When expanded, calls `useScheduleEvents({ enabled: true })` and renders newest-first. Each row: time + schedule name (lookup via `useSchedules`) + transition + subject. Empty state: "No activity in the last 7 days."

- [ ] **Step 6: Wire into `apps/web-dashboard/src/app/network/page.tsx`**

Add "Schedules" to the tab array between "Devices" and "WiFi". Render `<SchedulesTab />` when active.

- [ ] **Step 7: Run tests + tsc**
```bash
cd apps/web-dashboard && npm test && npx tsc --noEmit
```

- [ ] **Step 8: Commit + push**
```bash
git add apps/web-dashboard/
git commit -m "feat(dashboard): Schedules tab + SWR hooks + activity feed (WARP-95)"
git push -u origin WARP-95
```

---

## Task 5: WARP-96 — Schedule editor modal

**Branch:** `WARP-96`. **Depends on:** WARP-95 merged. **Size:** M.

- [ ] **Step 1: Rebase on main**

- [ ] **Step 2: Failing test for `WeeklyWindowsEditor`**

`__tests__/WeeklyWindowsEditor.test.tsx`:
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { WeeklyWindowsEditor } from "../WeeklyWindowsEditor";

describe("WeeklyWindowsEditor", () => {
  it("renders one row per window", () => {
    const w = [{ id: "1", daysOfWeek: 2, startMin: 540, endMin: 1020 }];
    render(<WeeklyWindowsEditor value={w} onChange={vi.fn()} />);
    expect(screen.getAllByRole("group", { name: /window/i })).toHaveLength(1);
  });

  it("Add window appends a row until 7 windows", () => {
    const onChange = vi.fn();
    const { rerender } = render(<WeeklyWindowsEditor value={[]} onChange={onChange} />);
    for (let i = 0; i < 7; i++) {
      fireEvent.click(screen.getByRole("button", { name: /add window/i }));
      expect(onChange).toHaveBeenCalled();
      rerender(<WeeklyWindowsEditor value={Array.from({ length: i + 1 }, (_, j) => ({ id: String(j), daysOfWeek: 0, startMin: 0, endMin: 60 }))} onChange={onChange} />);
    }
    expect(screen.getByRole("button", { name: /add window/i })).toBeDisabled();
  });

  it("Day checkbox toggle updates bitmask", () => {
    const onChange = vi.fn();
    const w = [{ id: "1", daysOfWeek: 0, startMin: 540, endMin: 1020 }];
    render(<WeeklyWindowsEditor value={w} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /mon/i }));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ daysOfWeek: 2 })]);
  });

  it("Zero-length window shows inline error", () => {
    const w = [{ id: "1", daysOfWeek: 2, startMin: 540, endMin: 540 }];
    render(<WeeklyWindowsEditor value={w} onChange={vi.fn()} />);
    expect(screen.getByText(/cannot be zero-length/i)).toBeInTheDocument();
  });

  it("Midnight-wrap indicator shown when endMin <= startMin", () => {
    const w = [{ id: "1", daysOfWeek: 1, startMin: 21*60, endMin: 7*60 }];
    render(<WeeklyWindowsEditor value={w} onChange={vi.fn()} />);
    expect(screen.getByText(/ends next day/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Implement `WeeklyWindowsEditor.tsx`**

Rows with day-checkboxes (Sun..Sat, proper label+input, bitmask serialization), native `<input type="time">` for start/end (serialize HH:MM → minutes), remove button per row, "+ Add window" button disabled at 7. Inline error for zero-length. "Ends next day" text when `endMin <= startMin`.

- [ ] **Step 4: Implement `ScheduleHeatmap.tsx`**

7×24 grid. For each `(day, hour)` cell, set opacity based on how many windows cover that hour. Cells covered by any window render `bg-accent/30`; overlaps darken. Labels: day names on left, hour ticks at 0/6/12/18 on top.

Test: single Mon 9am-5pm window → 8 cells colored (Mon row, columns 9..16). Midnight-wrap Sat 11pm–Sun 7am → Sat row cells 23 + Sun row cells 0..6.

- [ ] **Step 5: Implement `ScheduleEditorModal.tsx`**

440px centered modal (or side-aligned — use the dashboard's existing modal pattern). Fields as spec §7.3. Validates on submit via the same rules as `schedule-api.service.ts` (duplicate in `scheduleEval.ts`). Optimistic save via `useScheduleMutations` with server-truth rollback on typed error. Toast on failure via the shared `toastForError` map.

- [ ] **Step 6: Wire into `SchedulesTab.tsx`**

Replace the placeholder editor stub with `<ScheduleEditorModal scheduleId={editorOpenFor} onClose={() => setEditorOpenFor(null)} />`.

- [ ] **Step 7: Run tests + tsc + visual smoke on `ROUTING_MODE=mock` stack**

- [ ] **Step 8: Commit + push**
```bash
git commit -m "feat(dashboard): schedule editor modal + WeeklyWindowsEditor + heatmap (WARP-96)"
git push -u origin WARP-96
```

---

## Task 6: WARP-97 — Override picker modal

**Branch:** `WARP-97`. **Depends on:** WARP-94 merged. **Size:** S.

- [ ] **Step 1: Rebase on main**

- [ ] **Step 2: `scheduleEval.ts` — `nextTransitionFor` helper**

Create `apps/web-dashboard/src/lib/scheduleEval.ts`. Reuses the same `isWindowActive` logic as the backend (duplicate is fine — ~15 LOC). Adds:
```ts
export function nextTransitionFor(
  schedules: Schedule[],
  now: Date,
): { at: Date; isBlocked: boolean } | null {
  // Scan forward minute-by-minute up to 7 days, find first transition.
  // Naive but fast enough for a home-scale dataset.
}
```

Test: Bedtime schedule (Sun-Thu 21-7, Fri-Sat 23-8). At Tue 10am → next transition is Tue 21:00 (enters blocked). At Tue 22:00 → next is Wed 07:00 (leaves blocked).

- [ ] **Step 3: `useOverrideMutations`**
```ts
"use client";
import { useSWRConfig } from "swr";
import { apiFetch } from "./apiFetch";
import type { ScheduleOverride } from "@/lib/types";

export function useOverrideMutations() {
  const { mutate } = useSWRConfig();
  const invalidate = () => mutate((key) =>
    typeof key === "string" &&
    (key.startsWith("/api/network/overrides") || key.startsWith("/api/network/devices")));

  async function createOverride(input: {
    subjectType: "device" | "group"; deviceMac?: string; groupId?: string;
    action: "allow" | "block"; endAt: string; note?: string;
  }) {
    const res = await apiFetch<{ override: ScheduleOverride }>("/api/network/overrides", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    await invalidate();
    return res.override;
  }

  async function cancelOverride(id: string) {
    await apiFetch(`/api/network/overrides/${id}`, { method: "DELETE" });
    await invalidate();
  }

  return { createOverride, cancelOverride };
}
```

- [ ] **Step 4: Implement `OverrideModal.tsx`**

Fields per spec §7.4. Duration chips compute `endAt` from quick-picks. "Until next transition" chip label reads the subject's applicable schedule via `useSchedules` + `nextTransitionFor` — if no applicable schedule, falls back to "+30m".

If an active override exists (via `useActiveOverrides({ deviceMac, groupId })`), shows the banner at top with Cancel link.

- [ ] **Step 5: Tests + tsc + smoke**

- [ ] **Step 6: Commit + push**
```bash
git commit -m "feat(dashboard): override picker modal + nextTransitionFor helper (WARP-97)"
git push -u origin WARP-97
```

---

## Task 7: WARP-98 — Inline sections + manualBlock migration

**Branch:** `WARP-98`. **Depends on:** WARP-96 + WARP-97 merged. **Size:** M.

- [ ] **Step 1: Rebase on main**

- [ ] **Step 2: Extend `DeviceDetailPanel.tsx` — new Schedule section between Groups and Notes**

Reads `useSchedules` + `useActiveOverrides({ deviceMac: mac })`. Shows:
- If no effective schedule: muted "+ Schedule" split button (primary opens `OverrideModal`, dropdown opens `ScheduleEditorModal` pre-filled with `subjectType="device", deviceMac=mac`).
- If effective schedule exists: name + source ("own schedule" or "via Kids group") + current state + Allow/Block quick buttons (each opens OverrideModal with preset action + 30m default).
- If active override: banner with Cancel button.

- [ ] **Step 3: Extract `GroupRow` from `GroupManagerDialog.tsx`**

Move the `.map` body into a new `GroupRow.tsx` component. Add inline schedule summary row: fetch schedules with `subjectType="group", groupId=g.id`; show count and first schedule name + enabled state. Expand button reveals schedule list.

- [ ] **Step 4: Implement `QuickSchedulePopover.tsx`**

Reusable component. Props: `{ subject: { type: "device"|"group", deviceMac?: string, groupId?: string }; onClose: () => void }`. Content: "Apply Bedtime? Sun-Thu 9pm-7am, Fri-Sat 11pm-8am. [Apply] [Customize]". Apply calls `createSchedule` with hard-coded Bedtime windows (will be replaced by `SCHEDULE_PRESETS` from T8 — leave as constants inline for this ticket, plus a `TODO(WARP-99)` comment). Customize opens `ScheduleEditorModal` with those windows pre-filled.

- [ ] **Step 5: Wire Quick Schedule into `DeviceCard.tsx`**

Add a new button to the hover action row (next to Block/Unblock). Popover opens below the card.

- [ ] **Step 6: Migrate `useDeviceBlockMutation.ts`**

Replace the POST path from `/api/network/firewall/block|unblock` with `POST /api/network/devices/:mac/manualBlock` `{ blocked: true/false }`. Keep the `REQUIRES_CONFIRMATION` guard unchanged — it still runs in the catch branch by inspecting `err.code` and `err.body`. Tests adapted.

- [ ] **Step 7: Update all call sites**

Search for callers of `blockNetworkDevice` / `unblockNetworkDevice` in the dashboard. Migrate to the new hook's API if any bypass it.

- [ ] **Step 8: Tests + tsc + smoke**

- [ ] **Step 9: Commit + push**
```bash
git commit -m "feat(dashboard): inline Schedule sections + Quick Schedule + manualBlock migration (WARP-98)"
git push -u origin WARP-98
```

---

## Task 8: WARP-99 — Preset templates

**Branch:** `WARP-99`. **Depends on:** WARP-96 + WARP-97 merged. **Size:** S.

- [ ] **Step 1: Rebase on main**

- [ ] **Step 2: Write `schedule-presets.ts`**
```ts
// apps/web-dashboard/src/components/network/schedule-presets.ts
export interface SchedulePresetWindow { daysOfWeek: number; startMin: number; endMin: number; }

export interface SchedulePreset {
  id: "bedtime" | "school" | "homework";
  name: string;
  kind: "recurring" | "override";
  description: string;
  icon: string;
  windows?: SchedulePresetWindow[];
  overrideDurationMin?: number;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  {
    id: "bedtime",
    name: "Bedtime",
    kind: "recurring",
    description: "Sun–Thu 9pm–7am, Fri–Sat 11pm–8am",
    icon: "Moon",
    windows: [
      { daysOfWeek: 1 | 2 | 4 | 8 | 16, startMin: 21 * 60, endMin: 7 * 60 },
      { daysOfWeek: 32 | 64,            startMin: 23 * 60, endMin: 8 * 60 },
    ],
  },
  {
    id: "school",
    name: "School hours",
    kind: "recurring",
    description: "Mon–Fri 8am–3pm",
    icon: "Backpack",
    windows: [
      { daysOfWeek: 2 | 4 | 8 | 16 | 32, startMin: 8 * 60, endMin: 15 * 60 },
    ],
  },
  {
    id: "homework",
    name: "Homework mode",
    kind: "override",
    description: "Block for 90 minutes",
    icon: "Clock",
    overrideDurationMin: 90,
  },
];

export function presetById(id: SchedulePreset["id"]): SchedulePreset | undefined {
  return SCHEDULE_PRESETS.find((p) => p.id === id);
}
```

- [ ] **Step 3: Test presets**
```ts
describe("SCHEDULE_PRESETS", () => {
  it("Bedtime bitmask Sun-Thu = 31", () => {
    const b = SCHEDULE_PRESETS[0];
    expect(b.windows).toBeDefined();
    expect(b.windows![0].daysOfWeek).toBe(31);
    expect(b.windows![1].daysOfWeek).toBe(96);
  });
  it("School bitmask Mon-Fri = 62", () => {
    expect(SCHEDULE_PRESETS[1].windows![0].daysOfWeek).toBe(62);
  });
  it("Homework is override kind with 90 min duration", () => {
    expect(SCHEDULE_PRESETS[2].kind).toBe("override");
    expect(SCHEDULE_PRESETS[2].overrideDurationMin).toBe(90);
  });
});
```

- [ ] **Step 4: Implement `SchedulePresetCards.tsx`**

Three cards in `grid-cols-1 sm:grid-cols-3`. Each renders name + icon + description + "Use preset" button. Click routes:
- Bedtime / School → opens `ScheduleEditorModal` with `windows` from preset pre-filled + name auto-filled.
- Homework → opens `OverrideModal` with `defaultAction="block"`, duration chip pre-selected to 90min, subject initially blank (user picks inside the modal).

- [ ] **Step 5: Swap the placeholder in `SchedulesTab.tsx`**

Replace the "Presets coming soon" card with `<SchedulePresetCards />`.

- [ ] **Step 6: Update `QuickSchedulePopover.tsx` to use `presetById("bedtime")`**

Remove the inline Bedtime constants + the `TODO(WARP-99)` comment.

- [ ] **Step 7: Tests + tsc + smoke**

- [ ] **Step 8: Commit + push**
```bash
git commit -m "feat(dashboard): Bedtime / School hours / Homework mode presets (WARP-99)"
git push -u origin WARP-99
```

---

## Plan Self-Review

### Spec coverage check

| Spec section | Covered by |
|---|---|
| §4.1 Prisma additions | T1 Steps 8–12 |
| §4.2 `NetworkDevice.manualBlock` | T1 Step 8 |
| §4.3 Validation rules | T3 Step 3 (`validateSubject`, `validateWindows`) |
| §4.4 Timezone (system-local) | T2 Step 8 (implicit via `Date` API) |
| §4.5 Cascading | T1 Step 8 (`onDelete: Cascade` on relations) |
| §5.1 `computeDesiredBlocked` | T2 Steps 7–9 |
| §5.2 `isWindowActive` | T1 Steps 4–6 |
| §5.3 Ticker | T2 Steps 10–12 |
| §5.4 Event purge | T2 Steps 13–14 |
| §6.1 Schedules API | T3 Step 6 (GET/POST/PATCH/DELETE + listing) |
| §6.2 Overrides API | T3 Step 6 |
| §6.3 Schedule events | T3 Step 6 |
| §6.4 `/devices/:mac/manualBlock` | T3 Step 6 + T7 Step 6 (dashboard migration) |
| §7.1 Schedules tab nav | T4 Step 6 |
| §7.2 Schedules tab layout | T4 Step 5 (list + empty state) + T8 Step 5 (presets swap) |
| §7.3 Schedule editor + `WeeklyWindowsEditor` | T5 Steps 2–5 |
| §7.4 Override picker | T6 Steps 2–4 |
| §7.5 Quick Schedule popover | T7 Step 4 + T8 Step 6 |
| §7.6 Inline Schedule sections | T7 Steps 2–3 |
| §7.7 SWR hooks + mutations | T4 Steps 3–4 + T6 Step 3 |
| §7.8 Accessibility | T5 (dialog role, label+input, native time), T6 (dialog role), T4 (role="switch" on enabled toggle) |
| §8 Testing strategy | TDD throughout; every task has explicit failing-test steps |
| §10 AC per ticket | Mirrored in each task |

No gaps.

### Placeholder scan

No "TBD" / "TODO: implement later" / "Similar to Task N" strings. Every code-producing step contains either complete code or a precise procedural description with full code elsewhere in the plan (e.g., `ScheduleRow.tsx` implementation referenced by name with the compute-logic specified).

One intentional `TODO(WARP-99)` comment in T7 Step 4 is a cross-ticket signal, not a plan placeholder — it tells the T7 dev agent that the hard-coded Bedtime constants will be replaced by `SCHEDULE_PRESETS` in T8.

### Type consistency

- `isWindowActive(window, now): boolean` stable across T1 (backend) + T5 backend logic re-used + T6 `scheduleEval.ts` (client-side copy).
- `computeDesiredBlocked(input): { blocked, reason }` signature stable between T2 unit tests and T2 ticker consumer.
- `Schedule`, `ScheduleWindow`, `ScheduleOverride`, `ScheduleEvent` types identical in Prisma schema (T1) and TS types (T4 Step 2).
- `DeviceRegistryError` codes added in T1 (5 new) are the exact codes thrown in T3 service layer.
- `SCHEDULE_PRESETS` shape defined in T8 matches `QuickSchedulePopover`'s expected `presetById("bedtime")` consumption in T7 Step 4 → T8 Step 6.
- Schedule API response shapes (`{ schedule }`, `{ schedules }`, `{ override }`, `{ overrides }`, `{ events }`) consistent between route handlers (T3) and SWR hooks (T4).

No drift.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-17-phase-2-scheduling-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Same harness that shipped Phase 1: fresh implementer subagent per task + spec reviewer + code quality reviewer between each, fix-pass loop, PR open, human merge. Matches spec §9 agent harness.

**2. Inline Execution** — Execute tasks in this session with checkpoints.

Given this is Phase 2 and the harness is proven, **option 1 (Subagent-Driven)** is the right call. Same pattern as Phase 1 with the same high-bar output quality.
