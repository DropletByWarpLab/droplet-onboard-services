-- WARP-3266: subscribed recurring events are expanded into occurrences; each
-- row states explicitly whether it is a one-off, an occurrence, or a series
-- whose rule could not be expanded.
ALTER TABLE "CalendarEvent" ADD COLUMN "recurrence" TEXT NOT NULL DEFAULT 'none';
