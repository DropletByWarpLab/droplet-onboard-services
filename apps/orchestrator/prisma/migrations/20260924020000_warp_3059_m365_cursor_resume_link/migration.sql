-- WARP-3059 — a Microsoft 365 enumeration too big for one tick can resume.
--
-- Additive only: one nullable column, no index, no backfill. NULL is every
-- existing cursor's correct value (no run in progress).
--
-- resumeLink holds the @odata.nextLink of the last page a run handled before
-- its page budget ran out. It is a checkpoint inside one run, kept apart from
-- deltaLink so the cursor still advances only when a run completes.

-- AlterTable
ALTER TABLE "M365DeltaCursor" ADD COLUMN     "resumeLink" TEXT;
