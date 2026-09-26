-- WARP-2978 PR-D (ADR-059 P3 spec §5, §6.12) — what a `detection_ongoing` row
-- may be: a Frigate row, with a camera, not ended (its end is the separate
-- `detection` row), keyed in the `frigate-ongoing:` namespace. Every other
-- kind is untouched.
--
-- Hand-written, so invisible to `prisma migrate diff` (check-schema-drift
-- cannot see it); src/services/security-event-ongoing.pg.test.ts pins it.
--
-- NULL discipline (p2b-spec §14.4): the nullable inputs ("camera",
-- "endedAt") are read with IS [NOT] NULL only; "source", "kind" and
-- "dedupeKey" are NOT NULL. So the expression never evaluates to NULL, and a
-- NULL can never slip a row past it.
--
-- RE-RUNNABLE (the repo idiom, WARP-2978 PR-B's): DROP IF EXISTS + ADD, so a
-- re-run replaces the definition rather than failing on the name. Re-adding
-- re-validates SecurityEvent (30 days of rows); every existing row passes,
-- because no row can hold the new kind before this folder's sibling added it.
--
-- Re-stamped 20260925030100 → 20260925030200 while unmerged, behind its
-- sibling (20260925030100_warp_2978_security_event_ongoing_value), which the
-- incidents backend's move to 20260925030000 pushed along. A dev box that
-- applied the old stamp runs this again under the new name: DROP IF EXISTS +
-- ADD makes that a no-op.

ALTER TABLE "SecurityEvent" DROP CONSTRAINT IF EXISTS "SecurityEvent_ongoing_shape";
ALTER TABLE "SecurityEvent"
  ADD CONSTRAINT "SecurityEvent_ongoing_shape"
  CHECK (
    "kind" <> 'detection_ongoing'
    OR (
      "source" = 'frigate'
      AND "camera" IS NOT NULL
      AND "endedAt" IS NULL
      AND "dedupeKey" LIKE 'frigate-ongoing:%'
    )
  );
