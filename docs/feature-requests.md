# Feature requests — UI surfaces awaiting a backend

These dashboard surfaces were mocked in the Claude Design handoff but have **no
backing endpoint / data structure** in the orchestrator yet. Per repo policy we
do not ship stubbed data dressed up as real, so each is hidden behind a
default-off frontend feature flag (`apps/web-dashboard/src/lib/feature-flags.ts`,
`NEXT_PUBLIC_FEATURE_*`). This file is the request log: when a backend lands,
wire the widget to a real hook and delete the flag.

> Convention: file a matching WARP ticket and cross-reference it here. The
> `FR-00x` ids below are the local handles used by the flag comments.

---

## FR-001 — Home Tasks (per-user to-do)

- **Flag:** `NEXT_PUBLIC_FEATURE_HOME_TASKS` → `FEATURES.homeTasks`
- **Surface:** Home bento "Tasks" widget (`components/home/widgets.tsx` `TasksWidget`).
- **Needed:** a per-user task store with completion + ordering.
- **Proposed data structure (Prisma):**
  ```prisma
  model Task {
    id        String   @id @default(uuid())
    userId    String
    title     String
    done      Boolean  @default(false)
    dueAt     DateTime?
    order     Int      @default(0)
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt
  }
  ```
- **Proposed endpoints:** `GET/POST /api/tasks`, `PATCH/DELETE /api/tasks/:id`.

## FR-002 — Home Activity feed (aggregated)

- **Flag:** `NEXT_PUBLIC_FEATURE_HOME_ACTIVITY` → `FEATURES.homeActivity`
- **Surface:** Home bento "Activity" timeline (`ActivityWidget`).
- **Needed:** a unified recent-activity feed across subsystems (camera events,
  storage jobs, network joins, smart-home changes, chat turns). Distinct from
  `/api/admin/claude-activity`, which is the AI-engineer dev feed.
- **Proposed shape:** `GET /api/activity/recent?limit=N` →
  `{ items: { id, at, kind, severity: "ok"|"warn"|"error", source, summary }[] }`.
  Likely backed by an MQTT-fed `activity_event` table or a query that unions the
  existing per-domain event sources.

## FR-003 — Home Smart-home scenes

- **Flag:** `NEXT_PUBLIC_FEATURE_HOME_SCENES` → `FEATURES.homeScenes`
- **Surface:** Home bento "Smart home" scenes + quick toggles (`ScenesWidget`).
- **Needed:** Matter scene definitions + recall, and safe device quick-control
  from the board. The Devices page already controls real devices via
  `useSmartHome().command`; scenes need a stored grouping + a recall command.
- **Proposed endpoints:** `GET/POST /api/matter/scenes`,
  `POST /api/matter/scenes/:id/recall`. Quick toggles should reuse the existing
  `POST /api/matter/devices/:nodeId/command` (no new write path).

## FR-004 — Home Automations (scheduled jobs)

- **Flag:** `NEXT_PUBLIC_FEATURE_HOME_AUTOMATIONS` → `FEATURES.homeAutomations`
- **Surface:** Home bento "Tools" widget showing scheduled automations
  (`ToolsWidget`) — e.g. "Nightly NAS snapshot · 2 AM". NOTE: this is distinct
  from the `/tools` capability catalog (`/api/llm/tools/catalog`), which is
  already real and wired.
- **Needed:** a scheduled-automation store with next-run metadata.
- **Proposed shape:** `GET /api/automations` →
  `{ automations: { id, name, schedule, nextRunAt, enabled }[] }`, backed by the
  orchestrator's existing cron-runtime (`cron-runtime.service.ts`).
