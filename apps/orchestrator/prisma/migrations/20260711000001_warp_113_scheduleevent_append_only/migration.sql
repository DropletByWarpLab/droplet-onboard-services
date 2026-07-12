-- WARP-113: enforce ScheduleEvent append-only immutability at the DB level.
--
-- ScheduleEvent is the append-only audit log of every block/unblock
-- transition (schedule ticker + egress reconciler). It is append-only by
-- convention only — nothing in the schema or DB stopped a buggy query from
-- UPDATE-ing a row or inserting a future-dated event. Prisma can't model
-- triggers, so this guard lives here and is "managed at DB level only".
--
-- The 2026-04-18 review suggested `CHECK ("occurredAt" <= NOW())`, but a
-- CHECK constraint cannot reference the non-immutable now(), and a CHECK is
-- only evaluated at write time on the referenced columns — it cannot block a
-- no-op-column UPDATE. A BEFORE INSERT OR UPDATE trigger is the correct tool
-- and covers both requirements in one place.
--
-- Design notes:
--   * UPDATE is blocked unconditionally (true immutability).
--   * INSERT rejects only *genuinely* future-dated rows. Writers stamp
--     `occurredAt` from the APP clock (`occurredAt: now` in schedule-ticker
--     and egress-reconciler), not the DB default, so a strict `> now()`
--     would false-positive on normal app<->DB clock skew (multi-box /
--     containerised deploys) and break the ticker. A 5-minute grace window
--     absorbs skew while still catching the real bug (events dated hours or
--     days ahead).
--   * DELETE is intentionally NOT covered — schedule-purge.ts prunes rows
--     older than the retention window via deleteMany(); blocking DELETE
--     would break retention.
--   * Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.
--   * Backward-compatible: only fires on new INSERT/UPDATE; existing rows
--     are untouched (and all have occurredAt <= now() by construction).

CREATE OR REPLACE FUNCTION scheduleevent_enforce_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'ScheduleEvent is append-only (WARP-113): UPDATE is not permitted (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- INSERT: reject genuinely future-dated events (5-minute skew grace).
  IF NEW."occurredAt" > now() + interval '5 minutes' THEN
    RAISE EXCEPTION
      'ScheduleEvent.occurredAt cannot be in the future (WARP-113): % is past now()+5min', NEW."occurredAt"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION scheduleevent_enforce_append_only() IS
  'WARP-113: BEFORE INSERT OR UPDATE guard making ScheduleEvent append-only — blocks all UPDATEs and rejects future-dated inserts (5-min skew grace). DELETE stays allowed for retention purge.';

DROP TRIGGER IF EXISTS scheduleevent_append_only ON "ScheduleEvent";
CREATE TRIGGER scheduleevent_append_only
  BEFORE INSERT OR UPDATE ON "ScheduleEvent"
  FOR EACH ROW
  EXECUTE FUNCTION scheduleevent_enforce_append_only();
