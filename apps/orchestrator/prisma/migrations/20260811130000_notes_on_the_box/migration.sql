-- Notes move from browser localStorage onto the box.
--
-- Additive schema migration (idempotent, safe to re-run on a populated db).
-- Introduces the Note table: many notes per user, each independently
-- pinnable so pinned notes can surface on Home from any device.
--
-- `pinned` is a real column rather than a derived position: "the user
-- unpinned this note" and "this note was never pinned" must stay
-- distinguishable, and Home's query is a direct indexed predicate
-- (WHERE "userId" = $1 AND "pinned" = true) instead of a compound guess.
--
-- No data is migrated here. The old note lived in each browser's
-- localStorage, which the server has never seen; the dashboard performs a
-- one-time client-side upload of it on first load after this ships.

CREATE TABLE IF NOT EXISTS "Note" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Note_userId_pinned_updatedAt_idx"
    ON "Note"("userId", "pinned", "updatedAt");
