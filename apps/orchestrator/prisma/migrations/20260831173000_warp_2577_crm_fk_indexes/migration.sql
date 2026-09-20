-- WARP-2577 — index the five CRM foreign keys that are ON DELETE SET NULL.
--
-- Postgres does not auto-index a foreign key column. It indexes the PRIMARY
-- KEY side of a relation, never the referencing side, so every one of these
-- five columns had no index at all.
--
-- The cost is paid on the PARENT's delete, which is why it stayed invisible in
-- CRM testing: to null a child column, Postgres must first find the children,
-- and with no index that is a sequential scan of the child table. Deleting one
-- project scanned "CrmDeal"; deleting one note, email message, calendar event
-- or work item scanned "CrmActivity" — the timeline, which is the largest
-- table in this group and the one that grows without an operator ever pruning
-- it. A single note delete on a mature box walks every activity row.
--
-- This repo already documents the identical hazard verbatim on its own
-- relation (schema.prisma, WARP-845: "Postgres doesn't auto-index FK columns")
-- and indexes it there. These five were missed when the CRM core landed.
--
-- The three CrmActivity SUBJECT columns are deliberately absent from this
-- migration: companyId, contactId and dealId are already the leading column of
-- a composite index each, and a leading-column prefix is usable for exactly
-- this lookup. Adding single-column duplicates would be dead weight on every
-- write.
--
-- Pure index additions: no column changes, no backfill, no lock beyond the
-- build itself.

-- Deleting a PmProject nulls CrmDeal.projectId.
CREATE INDEX "CrmDeal_projectId_idx" ON "CrmDeal"("projectId");

-- Deleting a Note, EmailMessage, CalendarEvent or PmWorkItem nulls the
-- corresponding CrmActivity reference.
CREATE INDEX "CrmActivity_noteId_idx" ON "CrmActivity"("noteId");
CREATE INDEX "CrmActivity_emailMessageId_idx" ON "CrmActivity"("emailMessageId");
CREATE INDEX "CrmActivity_calendarEventId_idx" ON "CrmActivity"("calendarEventId");
CREATE INDEX "CrmActivity_workItemId_idx" ON "CrmActivity"("workItemId");
