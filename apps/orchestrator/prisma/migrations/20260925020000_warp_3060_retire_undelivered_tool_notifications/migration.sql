-- WARP-3060 — retire the NotificationLog rows the LLM tool `send_notification`
-- wrote and nothing ever delivered.
--
-- Until WARP-3060 the tool inserted its row straight through Prisma — kind
-- 'ai', channels '', deliveredAt NULL, error NULL, pushOutcome NULL — and
-- nothing picked it up: no toast, no push. Every other writer holds a row in
-- that shape only until WARP-2804's delivery claim or stamp lands, and those
-- set `error` or `deliveredAt`; migrations run before the orchestrator serves.
--
-- RETIRED, NOT DELIVERED LATE. WARP-2804's deliverNotification could send
-- them by id now; it is not used, because:
--   * the tool only ever addressed the person it acted for, and its text is
--     already where they can read it: the conversation or run trace that
--     called it, and their notification list, where the row stays;
--   * it promised an IMMEDIATE toast. Sent now, weeks-old items arrive as a
--     burst of pushes at whatever hour the box updates, each looking new.
--
-- Retired means: `error` says why it never arrived. That also takes the row
-- out of "queued" (deliveredAt NULL AND error NULL, the test WARP-2804's
-- delivery claim uses), so no later sweep can send it. An `unacked` row — one
-- written after WARP-2804 — becomes `untracked`: never counted as unread,
-- still listed, still ackable. Rows written before WARP-2804 are `untracked`
-- already (its backfill); `acked` is left alone. No row is deleted.
--
-- Data only (no DDL), so the drift gate has nothing to compare. Re-runnable:
-- the predicate requires error IS NULL, which the UPDATE sets.
UPDATE "NotificationLog"
   SET "error" = 'delivery: never_sent (WARP-3060)',
       "ackState" = CASE WHEN "ackState" = 'unacked'
                         THEN 'untracked'::"NotificationAckState"
                         ELSE "ackState" END
 WHERE "kind" = 'ai'
   AND "channels" = ''
   AND "deliveredAt" IS NULL
   AND "error" IS NULL
   AND "pushOutcome" IS NULL;
