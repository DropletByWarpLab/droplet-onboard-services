-- WARP-3193 PERF-9: one ChatMessage per (sessionId, turnId, role), held by the
-- database. The idempotency in chat-persistence.service.ts was check-then-
-- insert, so a double-submitted turn could insert its user and assistant rows
-- twice and start two agent loops. Partial: turnId NULL is every row written
-- without a client turn id (server-authored turns, seeds), which may repeat.
--
-- EXISTING DUPLICATES. The race this closes was live, so a box can already
-- hold duplicate keys, and the CREATE below would fail on them. They are
-- resolved first, without deleting anything: per key the EARLIEST row
-- (createdAt, then id) keeps the turnId — the row the old findFirst reader
-- would have returned for a retried turn — and every later one has its turnId
-- set to NULL. The rows, their content and anything that references them stay
-- exactly as they were; a later copy only stops answering to that turn id.
-- Re-runnable: the UPDATE matches nothing once the keys are unique, and the
-- index is IF NOT EXISTS.
UPDATE "ChatMessage" AS m
SET "turnId" = NULL
FROM (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "sessionId", "turnId", "role"
           ORDER BY "createdAt" ASC, "id" ASC
         ) AS rn
  FROM "ChatMessage"
  WHERE "turnId" IS NOT NULL
) AS d
WHERE m."id" = d."id" AND d.rn > 1;

-- Prisma has no datamodel syntax for a WHERE-filtered unique index, so this
-- lives in SQL only (precedent: AgentRun_workspaceId_active_key); the drift
-- gate does not report partial indexes. chat-persistence.service.ts maps the
-- P2002 it raises onto "return the existing turn".
CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessage_sessionId_turnId_role_key"
  ON "ChatMessage"("sessionId", "turnId", "role")
  WHERE "turnId" IS NOT NULL;
