-- WARP-112 — DB-level guard against duplicate windows in one schedule.
--
-- schedule-api.service.ts validates `windows.length <= 7` and per-window
-- shape, but NOT uniqueness: two concurrent POST/PATCH requests can both pass
-- the in-process check and insert identical (daysOfWeek, startMin, endMin)
-- rows under the same schedule. This composite unique index makes "no two
-- windows in a schedule share the same day-mask + minute range" a database
-- guarantee. The losing insert fails with a unique violation (Prisma P2002),
-- which the service translates to a clean 400 SCHEDULE_INVALID_WINDOW.
--
-- DEPLOY NOTE: this index build FAILS if any existing schedule already holds
-- duplicate windows. No box should — the service has always rejected the
-- length>7 case and the UI dedupes — but if a migration run errors here,
-- de-duplicate ScheduleWindow rows first (keep one per
-- scheduleId+daysOfWeek+startMin+endMin) and re-run. No dedup is baked in
-- because the repo has no precedent for silently mutating user schedule data.

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleWindow_scheduleId_daysOfWeek_startMin_endMin_key" ON "ScheduleWindow"("scheduleId", "daysOfWeek", "startMin", "endMin");
