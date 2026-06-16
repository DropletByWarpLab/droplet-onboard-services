-- 2026-06-09 sweep — DB-level double-fire guard for factory reset.
--
-- The application-level guard in reset.service.ts (count non-terminal rows,
-- then create) is a read-then-write race: two concurrent POST /system/reset
-- requests can both observe zero in-flight jobs and both dispatch. This
-- partial unique index makes the invariant "at most one non-terminal
-- ResetJob" a database guarantee — the second insert fails with a unique
-- violation (Prisma P2002), which reset.service.ts maps onto the existing
-- RESET_ALREADY_IN_PROGRESS 409 path.
--
-- Expression index on the constant (1) so EVERY row matching the WHERE
-- clause conflicts with every other; `requested` and `dispatched` are the
-- two non-terminal states (`failed` is terminal; a completed reset wipes
-- this database, so there is no `succeeded`).
--
-- NOTE: Prisma's schema language cannot express partial indexes, so this
-- lives only in SQL (mirrors the raw-SQL precedent of earlier data-shape
-- migrations). Re-runnable via IF NOT EXISTS.

BEGIN;

-- A box that already hit the race this index closes may hold MORE than one
-- non-terminal row, which would fail the index build. Keep the newest
-- non-terminal row as the gating one and mark older ones failed (honest:
-- they no longer gate anything and their dispatch outcome is unknown).
UPDATE "ResetJob" SET
    "status" = 'failed',
    "failureReason" = COALESCE(
        "failureReason",
        'Superseded by a newer reset request (de-duplicated by migration).'
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('requested', 'dispatched')
  AND "id" NOT IN (
      SELECT "id" FROM "ResetJob"
      WHERE "status" IN ('requested', 'dispatched')
      ORDER BY "createdAt" DESC
      LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS "ResetJob_at_most_one_nonterminal"
    ON "ResetJob" ((1))
    WHERE "status" IN ('requested', 'dispatched');

COMMIT;
