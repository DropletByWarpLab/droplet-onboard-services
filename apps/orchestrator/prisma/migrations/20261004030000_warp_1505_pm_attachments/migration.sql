-- WARP-1505 (Work Suite WS-3) — attachments on work items and comments.
--
-- `PmAttachment` has existed since the native_pm_foundation migration and no
-- route has ever written it, so every row that could exist here is a row no
-- code ever produced; the migration still handles them (see 3) rather than
-- assuming the table is empty.
--
-- ── what ships here ────────────────────────────────────────────────────────
--
--   1. PmAttachmentStatus (UPLOADING | READY | FAILED | DELETED) — the explicit
--      lifecycle column. Only READY rows are listed or served; FAILED and
--      DELETED are the sweep's work queue (pm-attachments.service).
--
--   2. PmAttachment.commentId — an attachment on a COMMENT, FK to PmComment with
--      ON DELETE CASCADE, indexed (an unindexed cascading FK is the WARP-845
--      hazard). Always a comment of the same work item; the service checks it,
--      because a CHECK cannot hold a subquery.
--
--   3. PmAttachment.sha256 (NOT NULL) and PmAttachment.status. Added with a
--      throwaway DEFAULT so the ALTER cannot fail on a non-empty table, then the
--      sha256 default is dropped again so the final shape is exactly what
--      schema.prisma declares (the drift gate compares them). Any row that
--      already exists never had bytes on a volume — there was no volume — so it
--      is marked FAILED, which the sweep then clears, instead of READY, which
--      would advertise a download that cannot be served.
--
--   4. PmAttachment_ready_has_sha256 — a READY row must carry a real digest.
--      The other states carry '' (the digest does not exist until the last
--      byte has streamed). Prisma's schema language cannot express a CHECK, so
--      it lives here and is proven against a real Postgres in
--      pm-attachment.pg.test.ts.
--
--   5. PmActivityVerb gains attachment_added / attachment_removed.
--      NOTE: added here but NOT referenced by any statement in this file —
--      Postgres refuses to USE an enum value added by ALTER TYPE inside the
--      transaction that added it, and Prisma applies a migration file inside
--      one (same constraint 20260904140100_warp_2586_pm_work_item_relation
--      documents). PmAttachmentStatus is different: a type CREATEd in this
--      transaction may be used in it, which is what step 3 does.

-- ── PmAttachmentStatus ──────────────────────────────────────────────────────
CREATE TYPE "PmAttachmentStatus" AS ENUM ('UPLOADING', 'READY', 'FAILED', 'DELETED');

-- ── PmAttachment: columns ───────────────────────────────────────────────────
ALTER TABLE "PmAttachment"
    ADD COLUMN "commentId" TEXT,
    ADD COLUMN "sha256" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "status" "PmAttachmentStatus" NOT NULL DEFAULT 'UPLOADING';

-- The sha256 default existed only to make the ALTER above safe on a table that
-- already holds rows. schema.prisma declares no default, and neither may the
-- database, or `migrate diff` reports drift forever.
ALTER TABLE "PmAttachment" ALTER COLUMN "sha256" DROP DEFAULT;

-- Rows that predate this migration have no bytes anywhere (see the header).
UPDATE "PmAttachment" SET "status" = 'FAILED';

-- ── PmAttachment: indexes + FK ──────────────────────────────────────────────
CREATE INDEX "PmAttachment_commentId_idx" ON "PmAttachment"("commentId");

CREATE INDEX "PmAttachment_status_createdAt_idx" ON "PmAttachment"("status", "createdAt");

ALTER TABLE "PmAttachment" ADD CONSTRAINT "PmAttachment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "PmComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── PmAttachment: a READY row has a real digest ─────────────────────────────
ALTER TABLE "PmAttachment"
    ADD CONSTRAINT "PmAttachment_ready_has_sha256"
    CHECK ("status" <> 'READY' OR "sha256" ~ '^[0-9a-f]{64}$');

-- ── PmActivityVerb: attachment_added / attachment_removed ───────────────────
-- Idempotent guard — ALTER TYPE ... ADD VALUE has no transaction-safe
-- IF NOT EXISTS on every supported PG and re-adding an existing value errors.
-- Same pattern as 20260904140100_warp_2586_pm_work_item_relation.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'attachment_added'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'attachment_added';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'attachment_removed'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'attachment_removed';
    END IF;
END $$;
