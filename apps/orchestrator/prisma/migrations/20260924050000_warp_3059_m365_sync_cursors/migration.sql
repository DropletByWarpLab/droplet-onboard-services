-- WARP-3059 — Microsoft 365 sync cursors: an enumeration too big for one tick
-- can resume, and a reconnect as someone else does not inherit them.
--
-- Additive only: two nullable columns, no index, no backfill. NULL is every
-- existing row's correct value.
--
-- Re-stamped before merge from 20260924020000_warp_3059_m365_cursor_resume_link,
-- which sorted before 20260924030000_warp_2900_extensions (#2326) on stage, and
-- renamed because it now also adds cursorLinkHash (#2347 review). No box
-- applied the old name.
--
-- M365DeltaCursor.resumeLink holds the @odata.nextLink of the last page a run
-- handled before its page budget ran out. It is a checkpoint inside one run,
-- kept apart from deltaLink so the cursor still advances only when a run
-- completes.
--
-- M365Connection.cursorLinkHash is a SHA-256 of the app, account and tenant
-- the person's cursors were built under. A sign-in that completes as anything
-- else purges them before the row turns CONNECTED. NULL (every existing row)
-- means "not known", which a completing sign-in treats as someone else's.

-- AlterTable
ALTER TABLE "M365DeltaCursor" ADD COLUMN     "resumeLink" TEXT;

-- AlterTable
ALTER TABLE "M365Connection" ADD COLUMN     "cursorLinkHash" TEXT;
