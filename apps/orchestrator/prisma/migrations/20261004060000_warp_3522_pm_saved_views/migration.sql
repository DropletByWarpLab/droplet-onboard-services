-- WARP-3522 (ADR-069 s8, Work Suite WS-6) — saved views, and the plain-text
-- projection the filter DSL's `text` condition searches.
--
-- Additive only. Existing rows keep their meaning: every PmWorkItem gains one
-- nullable column the trigger below fills, and PmSavedView is a new table.
--
--   1. PmSavedView — a named, persisted filter (project-scoped or cross-project,
--      personal or shared). Three invariants Prisma cannot express are enforced
--      here and proven in pm-saved-view.pg.test.ts: the name's length, the
--      filter being a JSON object, and name uniqueness per scope.
--   2. PmWorkItem.descriptionText — `descriptionHtml` with the markup removed.
--      The DSL's `text` condition is `name ILIKE ... OR descriptionText ILIKE
--      ...`; the old `ILIKE` over the raw HTML matched tag and attribute names
--      ("class", "strong", every href) and, being unindexed, scanned the table.
--      A TRIGGER maintains it, not the service, so every write path keeps it
--      true — this service's, another slice's, an import, a hand-run UPDATE —
--      and no pm.service.ts write site has to know the column exists.
--   3. Trigram GIN indexes on PmWorkItem.name and .descriptionText, so each arm
--      of that OR is a bitmap scan. pg_trgm is already installed
--      (20260926120000_warp_3193_activity_feed_indexes); IF NOT EXISTS keeps a
--      box that somehow lacks it, and a re-run, clean.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "PmViewScope" AS ENUM ('PERSONAL', 'SHARED');

-- CreateEnum
CREATE TYPE "PmViewLayout" AS ENUM ('BOARD', 'LIST', 'TABLE', 'CALENDAR', 'TIMELINE');

-- AlterTable
ALTER TABLE "PmWorkItem" ADD COLUMN     "descriptionText" TEXT;

-- CreateTable
CREATE TABLE "PmSavedView" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "ownerId" TEXT NOT NULL,
    "scope" "PmViewScope" NOT NULL DEFAULT 'PERSONAL',
    "name" TEXT NOT NULL,
    "layout" "PmViewLayout" NOT NULL DEFAULT 'BOARD',
    "filter" JSONB NOT NULL,
    "groupBy" TEXT,
    "sortBy" JSONB,
    "columns" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmSavedView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PmSavedView_workspaceId_projectId_scope_idx" ON "PmSavedView"("workspaceId", "projectId", "scope");

-- CreateIndex
CREATE INDEX "PmSavedView_projectId_idx" ON "PmSavedView"("projectId");

-- CreateIndex
CREATE INDEX "PmWorkItem_name_idx" ON "PmWorkItem" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "PmWorkItem_descriptionText_idx" ON "PmWorkItem" USING GIN ("descriptionText" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "PmSavedView" ADD CONSTRAINT "PmSavedView_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "PmWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmSavedView" ADD CONSTRAINT "PmSavedView_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── PmSavedView invariants (raw: not expressible in the Prisma datamodel) ────

-- A name a person can read and a chip can hold. The service refuses first and
-- says why; this is what stops a second writer (an import, the assistant) that
-- forgets to.
ALTER TABLE "PmSavedView"
  ADD CONSTRAINT "PmSavedView_name_length"
  CHECK (char_length(btrim("name")) BETWEEN 1 AND 60);

-- The filter DSL's root is always an object ({and}, {or} or a condition).
-- Structure beyond that is judged by the shared validator on every read and
-- write — it is not duplicated in SQL.
ALTER TABLE "PmSavedView"
  ADD CONSTRAINT "PmSavedView_filter_is_object"
  CHECK (jsonb_typeof("filter") = 'object');

-- One "Overdue" per place. The key is (workspace, project-or-none, scope,
-- owner-if-personal, lower(name)): a PERSONAL view is unique among its OWNER's
-- (two people may both keep a personal "Mine"), a SHARED one among everyone's,
-- and a cross-project view (projectId NULL) is compared as ''. COALESCE and
-- CASE are what let one index say all of that — Postgres treats NULLs in a
-- plain unique index as distinct, which would let a cross-project name repeat.
CREATE UNIQUE INDEX "PmSavedView_name_scope_key" ON "PmSavedView" (
  "workspaceId",
  (COALESCE("projectId", '')),
  "scope",
  (CASE WHEN "scope" = 'PERSONAL' THEN "ownerId" ELSE '' END),
  (lower("name"))
);

-- ── PmWorkItem.descriptionText: the plain-text projection ───────────────────

-- HTML -> what a person typed. Tags become a space (so `<p>a</p><p>b</p>` is
-- "a b", not "ab"), the entities the PM sanitizer emits are decoded (`&amp;`
-- LAST, so the literal text "&amp;lt;" survives as "&lt;" and not "<"),
-- whitespace is collapsed and trimmed, and a description with no text in it is
-- NULL, not ''. The sanitizer's allowlist is a dozen formatting tags with no
-- `>` inside an attribute, which is what makes the tag pattern safe.
CREATE OR REPLACE FUNCTION pm_html_to_text(html text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT NULLIF(
    btrim(
      regexp_replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      regexp_replace(html, '<[^>]*>', ' ', 'g'),
                      '&nbsp;', ' '),
                    '&quot;', '"'),
                  '&#39;', ''''),
                '&#x27;', ''''),
              '&lt;', '<'),
            '&gt;', '>'),
          '&amp;', '&'),
        '[[:space:]]+', ' ', 'g')),
    '')
$$;

CREATE OR REPLACE FUNCTION pm_work_item_description_text() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."descriptionText" := pm_html_to_text(NEW."descriptionHtml");
  RETURN NEW;
END
$$;

-- BEFORE INSERT, and BEFORE UPDATE only when the statement sets descriptionHtml:
-- a state drag or a title edit does not pay for a regexp.
DROP TRIGGER IF EXISTS pmworkitem_description_text ON "PmWorkItem";
CREATE TRIGGER pmworkitem_description_text
  BEFORE INSERT OR UPDATE OF "descriptionHtml" ON "PmWorkItem"
  FOR EACH ROW EXECUTE FUNCTION pm_work_item_description_text();

-- Backfill. Sets descriptionText directly (the trigger above is UPDATE OF
-- "descriptionHtml" and does not fire for this statement). Idempotent: running
-- it again rewrites the same values.
UPDATE "PmWorkItem"
   SET "descriptionText" = pm_html_to_text("descriptionHtml")
 WHERE "descriptionHtml" IS NOT NULL;
