-- WARP-488: backfill three pre-WARP-485 user-id surfaces from username → UUID.
--
-- WARP-485 added `User.nextcloudUsername` and changed the auth middleware so
-- `req.user.id` is now always the local `User.id` UUID, regardless of whether
-- the session originated from a JWT or an OCS-token fallback. Before that
-- normalization landed, the OCS fallback path set `req.user.id` to the raw
-- Nextcloud user-id string (e.g. `stefan-cruceru`), and any row written
-- using `req.user.id` AT THE TIME landed keyed by username rather than by
-- the row's UUID.
--
-- Three surfaces persisted that pre-fix `req.user.id`:
--
--   1. `CameraPin.userId`             — keyed by username for rows minted
--                                       via the OCS-auth path before WARP-485.
--                                       Read at `routes/cameras.ts:269` via
--                                       `pinsSvc.listPins(prisma, req.user.id)`.
--   2. `CameraNotificationPref.userId` — same shape, read at
--                                       `routes/cameras.ts:1549, :1577` via
--                                       `userId_cameraId` composite where-clause.
--   3. `BRAIN_ROOT/<userId>/` on-disk  — see
--                                       `services/brain-memory.service.ts`
--                                       `pathForItem` / `ensureItemDir`. Handled
--                                       by the orchestrator's boot-time
--                                       `migrateBrainMemoryDirectoryLayout`
--                                       helper, NOT this SQL migration, because
--                                       it touches the filesystem and reads
--                                       the same `User.nextcloudUsername`
--                                       table from Node land.
--
-- Without this backfill, a device upgraded across the WARP-485 boundary
-- silently loses every CameraPin / CameraNotificationPref row whose
-- userId is a username string, because the new `req.user.id` (UUID) will
-- never match the old key on read. The on-disk brain-memory dirs strand
-- the same way — files exist but the per-user RBAC + path-resolution
-- can't see them under the new UUID-keyed scheme.
--
-- ── Mapping path ──
--
-- Username → UUID resolution uses `User.nextcloudUsername` (added in
-- WARP-485 migration `20260526150000_warp_485_user_nextcloud_username`).
-- Every pre-WARP-485 OCS-auth user that has authenticated since the
-- WARP-485 deploy has a matching `User.nextcloudUsername` row written
-- on first sign-in. The orphan case is a username with no matching User
-- row — that's logged via RAISE NOTICE for operator review, never
-- deleted (operators decide whether to re-attribute or drop).
--
-- ── Idempotency ──
--
-- UUID-regex filter on the WHERE clause:
--   "userId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
-- Rows that already carry a UUID userId are skipped, so re-running this
-- migration on a converged DB updates zero rows. Same posture as the
-- WARP-330 `backfill_brain_status` migration above.
--
-- ── No deletions ──
--
-- Orphan rows (non-UUID userId with no matching User.nextcloudUsername)
-- stay in place. The operator decides whether to manually re-attribute
-- them (via psql or the People surface in a follow-up ticket) or drop
-- them. RAISE NOTICE captures the count for the operator's review.
--
-- Future deletions: tracked separately if the operator-tooling ticket
-- lands. This migration is strictly additive.

BEGIN;

-- ── 1. CameraPin.userId : username → UUID ──
--
-- Resolve each pre-WARP-485 username key against `User.nextcloudUsername`,
-- substitute the matching `User.id` (UUID). The UUID-regex filter on the
-- WHERE clause means a row that already carries a UUID-shaped userId is
-- not eligible — second-run = no-op.
--
-- We use a single UPDATE … FROM (a Postgres-ism the existing migrations
-- use elsewhere) joined on `nextcloudUsername`. Rows whose userId is a
-- non-UUID string with NO matching User row (= orphan) are untouched
-- and surface via the NOTICE block at the bottom.
--
-- The `@@unique([userId, cameraName])` constraint on CameraPin is
-- per-user → it can never block this UPDATE because we're flipping the
-- key from username form to UUID form ATOMICALLY for one user at a time.
-- Even if the same operator somehow has a (username-keyed) AND (UUID-
-- keyed) row with the same cameraName — exceedingly unlikely without
-- manual SQL — Postgres rejects the UPDATE with a unique violation,
-- which is the correct fail-loud signal (manual operator review).
UPDATE "CameraPin"
   SET "userId" = "User"."id"
  FROM "User"
 WHERE "CameraPin"."userId" = "User"."nextcloudUsername"
   AND "CameraPin"."userId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- ── 2. CameraNotificationPref.userId : username → UUID ──
--
-- Same shape as the CameraPin update. The `@@unique([userId, cameraId])`
-- constraint has the same per-user uniqueness so collisions can only
-- happen in the pathological pre-existing duplicate case, which is a
-- fail-loud rather than fail-silent path here.
UPDATE "CameraNotificationPref"
   SET "userId" = "User"."id"
  FROM "User"
 WHERE "CameraNotificationPref"."userId" = "User"."nextcloudUsername"
   AND "CameraNotificationPref"."userId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- ── 3. Orphan reporting (RAISE NOTICE, no deletions) ──
--
-- After the UPDATEs above, any row whose userId is STILL non-UUID
-- shaped is an orphan: a username string that doesn't map to any
-- `User.nextcloudUsername` in the directory. We RAISE NOTICE the
-- counts so the operator can see them in the migrate output and
-- decide whether to re-attribute (psql) or drop them in a follow-up.
-- We DO NOT delete here — that's an operator decision.
DO $$
DECLARE
    orphan_pins      INTEGER;
    orphan_prefs     INTEGER;
BEGIN
    SELECT COUNT(*)
      INTO orphan_pins
      FROM "CameraPin"
     WHERE "userId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    SELECT COUNT(*)
      INTO orphan_prefs
      FROM "CameraNotificationPref"
     WHERE "userId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    IF orphan_pins > 0 THEN
        RAISE NOTICE 'WARP-488: % CameraPin row(s) have non-UUID userId with no matching User.nextcloudUsername — operator review needed (rows NOT deleted).', orphan_pins;
    END IF;

    IF orphan_prefs > 0 THEN
        RAISE NOTICE 'WARP-488: % CameraNotificationPref row(s) have non-UUID userId with no matching User.nextcloudUsername — operator review needed (rows NOT deleted).', orphan_prefs;
    END IF;
END $$;

COMMIT;
