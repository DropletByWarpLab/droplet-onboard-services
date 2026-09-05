-- WARP-2554 — give `Contact` the explicit archive pair `CrmCompany` and
-- `CrmDeal` already carry.
--
-- Why Contact needs it more than either of them: a row whose `origin` is
-- EXTERNAL cannot be edited or deleted (the source owns its fields, and a
-- delete would be undone by the next sync). Without an archive flag there is
-- NO action a human can take to get a synced person off their screen — the
-- refusal is a dead end rather than a redirect.
--
-- `isArchived` is the state; `archivedAt` is the audit timestamp only. Never
-- derive one from the other (WARP-884).
--
-- Additive and backfill-free: the column defaults to false, so every existing
-- row keeps its current visibility with no data migration.

ALTER TABLE "Contact" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false;

-- The default listing is "this person's contacts, unarchived, by name".
CREATE INDEX "Contact_userId_isArchived_idx" ON "Contact"("userId", "isArchived");
