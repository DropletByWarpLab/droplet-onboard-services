-- WARP-493 (lineage: WARP-491): backfill the brain-memory user-id surfaces
-- from Nextcloud username → local User.id UUID.
--
-- Data-only migration — NO schema changes. Third and final pre-WARP-485
-- username-keyed surface, deferred out of WARP-488 (see that migration's
-- header): the brain-memory cutover is only safe as an ATOMIC deploy that
-- bundles this backfill with
--
--   1. the `getUserId` flip in routes/files-brain.ts + me-context-stats.ts
--      (reads/writes now key on `req.user.id`, the local User UUID),
--   2. the boot-time `migrateBrainMemoryDirectoryLayout` pass that renames
--      `BRAIN_ROOT/<username>/` dirs to `BRAIN_ROOT/<uuid>/`,
--   3. the orchestrator's MQTT `droplet/files/brain/uploaded` publisher
--      sending the UUID so `brain_ingest.py` writes UUID-keyed chunks.
--
-- Shipping any one of these without the others regresses reads (the
-- WARP-488 reviewer caught exactly that: renamed dirs + username-keyed
-- reader = ENOENT on every pre-fix item). See docs/UPGRADE-NOTES.md.
--
-- ── Mapping path ──
--
-- Username → UUID resolution uses `User.nextcloudUsername` (WARP-485,
-- migration `20260526150000_warp_485_user_nextcloud_username`). Rows whose
-- userId matches no `User.nextcloudUsername` are orphans: logged via
-- RAISE NOTICE below, never deleted (operator decides).
--
-- ── Idempotency ──
--
-- Same UUID-regex posture as the WARP-488 Camera* backfill: the WHERE
-- clause requires `"userId" !~ uuid_regex`, so rows that already carry a
-- UUID key are not eligible and a re-run on a converged DB updates zero
-- rows. The storagePath rewrite is additionally self-idempotent — its
-- search needle embeds the (username, itemId) pair, which no longer
-- occurs in the path once rewritten.
--
-- ── Scoping note (deliberate deviation from a literal reading of the
--    ticket): FileContentChunk is filtered to `source = 'brain'` ──
--
-- Nextcloud-watcher chunks (`source = 'nextcloud'`) are username-keyed BY
-- DESIGN and will KEEP being written username-keyed after this deploy —
-- the file-indexer's watcher derives the key from the Nextcloud data-dir
-- path (services/file-indexer/watcher.py) and deletes/upserts by
-- `(username, path)` (db.py::delete_chunks_for_path). Blanket-flipping
-- those rows would (a) break the watcher's delete-then-insert coherence
-- (duplicate chunks on the next re-index) and (b) hide the rows from the
-- username-keyed knowledge-search reads, then immediately diverge again.
-- Only the brain-ingest-owned rows flip here.
--
-- ── Fail-loud collision case ──
--
-- `BrainMemoryItem` has `@@unique([userId, sha256])`. If the same person
-- uploaded byte-identical files under BOTH the pre-485 username key AND
-- the post-485 UUID key, the flip collides and Postgres aborts the whole
-- transaction — the correct signal for manual operator review (dropping
-- either row silently would discard a user-visible item).

BEGIN;

-- ── 1. BrainMemoryItem.storagePath : /<username>/<itemId>/ → /<uuid>/<itemId>/ ──
--
-- MUST run before the userId flip in (2): the join predicate
-- (`userId = nextcloudUsername`) only holds while the row still carries
-- the username key.
--
-- The replace needle is anchored on the `/<username>/<itemId>/` pair —
-- the itemId is a cuid, so the needle cannot accidentally match a
-- username-shaped substring inside BRAIN_ROOT itself (e.g. an operator
-- who mounted the tree under `/data/alice/brain-memory/` with a user
-- named `alice`). Rows with storagePath = '' (WARP-871 byte-less
-- orphans) pass through unchanged: replace('') = ''.
UPDATE "BrainMemoryItem"
   SET "storagePath" = replace(
         "BrainMemoryItem"."storagePath",
         '/' || "User"."nextcloudUsername" || '/' || "BrainMemoryItem"."id" || '/',
         '/' || "User"."id" || '/' || "BrainMemoryItem"."id" || '/'
       )
  FROM "User"
 WHERE "BrainMemoryItem"."userId" = "User"."nextcloudUsername"
   AND "BrainMemoryItem"."userId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- ── 2. BrainMemoryItem.userId : username → UUID ──
UPDATE "BrainMemoryItem"
   SET "userId" = "User"."id"
  FROM "User"
 WHERE "BrainMemoryItem"."userId" = "User"."nextcloudUsername"
   AND "BrainMemoryItem"."userId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- ── 3. FileContentChunk.userId : username → UUID (brain-sourced rows only) ──
UPDATE "FileContentChunk"
   SET "userId" = "User"."id"
  FROM "User"
 WHERE "FileContentChunk"."userId" = "User"."nextcloudUsername"
   AND "FileContentChunk"."source" = 'brain'
   AND "FileContentChunk"."userId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- ── 4. Orphan reporting (RAISE NOTICE, no deletions) ──
--
-- Any row STILL non-UUID-keyed after the UPDATEs is an orphan: a username
-- with no matching `User.nextcloudUsername` (pre-pairing junk, or an OCS
-- user who has not signed in since WARP-485 — their mapping row is written
-- on first sign-in). Converging such late arrivals requires an OPERATOR to
-- manually re-apply this file's SQL via psql: `prisma migrate deploy`
-- records this migration as applied and will never re-run it. The manual
-- re-apply is safe and idempotent (UUID-regex guards; orphan rows retain
-- both the username userId AND username storagePath, so rewrite-then-flip
-- still applies). The boot-time fs migrator, by contrast, re-runs every
-- boot and converges the DIRS automatically.
-- Counts surface in the migrate output for operator review; nothing is
-- deleted. Mirrors the boot-time fs migrator's orphan posture.
DO $$
DECLARE
    orphan_items   INTEGER;
    orphan_chunks  INTEGER;
BEGIN
    SELECT COUNT(*)
      INTO orphan_items
      FROM "BrainMemoryItem"
     WHERE "userId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    SELECT COUNT(*)
      INTO orphan_chunks
      FROM "FileContentChunk"
     WHERE "source" = 'brain'
       AND "userId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    IF orphan_items > 0 THEN
        RAISE NOTICE 'WARP-493: % BrainMemoryItem row(s) have non-UUID userId with no matching User.nextcloudUsername — operator review needed (rows NOT deleted).', orphan_items;
    END IF;

    IF orphan_chunks > 0 THEN
        RAISE NOTICE 'WARP-493: % brain-sourced FileContentChunk row(s) have non-UUID userId with no matching User.nextcloudUsername — operator review needed (rows NOT deleted).', orphan_chunks;
    END IF;
END $$;

COMMIT;
