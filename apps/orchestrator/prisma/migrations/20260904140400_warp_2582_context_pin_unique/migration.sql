-- WARP-2582 - one pin per (sessionId, kind, ref).
--
-- WHY NOW: this slice puts "Ask AI about this customer" on the record drawer.
-- Clicking it twice on the same thread used to insert a second identical row,
-- and a duplicate pin is not cosmetic - it spends the pin block's char budget
-- twice on every subsequent turn, forever, on a block this slice is already
-- rationing.
--
-- All three columns are NOT NULL, and that is what makes this index safe to
-- use as a P2002 target at all: a compound unique containing a NULLABLE
-- column never matches in Postgres (NULL = NULL is false), so an upsert
-- against it silently inserts forever. `meta` is deliberately NOT part of the
-- key - partly because two pins of the same record with different camera
-- windows are still one record, and partly because including a nullable
-- column would reintroduce exactly that trap.
--
-- Pre-existing duplicates are collapsed FIRST, keeping the OLDEST row: its id
-- is the one any open dashboard tab currently holds and its `addedAt` is the
-- honest one. Without this, CREATE UNIQUE INDEX fails at apply time on any
-- box where somebody double-pinned a folder by hand.

DELETE FROM "ContextPin" a
    USING "ContextPin" b
    WHERE a."sessionId" = b."sessionId"
      AND a."kind"      = b."kind"
      AND a."ref"       = b."ref"
      AND (a."addedAt", a."id") > (b."addedAt", b."id");

CREATE UNIQUE INDEX IF NOT EXISTS "ContextPin_sessionId_kind_ref_key"
    ON "ContextPin"("sessionId", "kind", "ref");
