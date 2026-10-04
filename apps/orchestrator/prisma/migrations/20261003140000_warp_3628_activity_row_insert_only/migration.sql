-- WARP-3628: ActivityRow is insert-only at the database level, except for the
-- retention purge's explicit path.
--
-- ActivityRow is the signed, hash-chained activity log. Nothing in the schema
-- stopped a buggy or injected statement from UPDATE-ing or DELETE-ing a row;
-- the chain would show it afterwards, but the row would already be gone. This
-- migration makes the database refuse it. Prisma can't model triggers, so the
-- guard lives here and is "managed at DB level only" (same posture as
-- 20260711000001_warp_113_scheduleevent_append_only).
--
-- Design notes:
--   * UPDATE is rejected unconditionally.
--   * DELETE and TRUNCATE are rejected unless the transaction has set
--     `droplet.activity_purge = 'on'`. The only code that sets it is
--     droplet_purge_activity_rows() below, which the nightly retention purge
--     (audit-retention-purge.service.ts) calls, and which clears the flag
--     before it returns. The purge records an "Audit log purged" row in the
--     chain after each run that deleted anything, so the path is audited.
--   * The error is `insufficient_privilege` (42501), the SQLSTATE a REVOKE
--     would have produced.
--   * LIMIT, stated plainly: today every service connects as the Postgres
--     superuser, and the flag is an ordinary session setting, so a superuser
--     (or anything running arbitrary SQL as the application) can set the flag,
--     disable the trigger or drop it. This guard stops mistakes and simple
--     injected statements; it does not stop an actor with the database
--     credentials. Real immutability needs a separate application role without
--     DELETE/UPDATE/TRUNCATE on the table and a purge function owned by
--     another role: that is the least-privilege database roles work (WARP-3590)
--     and is not done here. Off-box anchoring of the chain head (see
--     scripts/audit-chain-head.sh) is what makes a rewrite detectable.
--   * Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.
--   * Existing rows are untouched. Restores that load rows with INSERT or COPY
--     are unaffected; pg_restore --clean drops the table, which the guard does
--     not cover.

CREATE OR REPLACE FUNCTION droplet_activity_row_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE')
     AND current_setting('droplet.activity_purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NULL;
  END IF;

  RAISE EXCEPTION
    'ActivityRow is insert-only (WARP-3628): % is not permitted; retention runs through droplet_purge_activity_rows()', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMENT ON FUNCTION droplet_activity_row_guard() IS
  'WARP-3628: rejects UPDATE, and DELETE/TRUNCATE unless droplet.activity_purge is on (set only by droplet_purge_activity_rows). Not tamper-proof against a superuser; see WARP-3590.';

DROP TRIGGER IF EXISTS "ActivityRow_insert_only" ON "ActivityRow";
CREATE TRIGGER "ActivityRow_insert_only"
  BEFORE UPDATE OR DELETE ON "ActivityRow"
  FOR EACH ROW
  EXECUTE FUNCTION droplet_activity_row_guard();

DROP TRIGGER IF EXISTS "ActivityRow_insert_only_truncate" ON "ActivityRow";
CREATE TRIGGER "ActivityRow_insert_only_truncate"
  BEFORE TRUNCATE ON "ActivityRow"
  FOR EACH STATEMENT
  EXECUTE FUNCTION droplet_activity_row_guard();

-- The retention purge's one explicit path. Deletes exactly the ids it is
-- handed (the service picks a contiguous oldest-id prefix, see
-- audit-retention-purge.service.ts) and returns how many rows went. The flag is
-- transaction-local and is cleared again before the function returns, so a
-- caller that wraps this in a larger transaction does not leave it open.
CREATE OR REPLACE FUNCTION droplet_purge_activity_rows(ids bigint[])
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  n bigint;
BEGIN
  PERFORM set_config('droplet.activity_purge', 'on', true);
  DELETE FROM "ActivityRow" WHERE "id" = ANY(ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('droplet.activity_purge', 'off', true);
  RETURN n;
END;
$$;

COMMENT ON FUNCTION droplet_purge_activity_rows(bigint[]) IS
  'WARP-3628: the only sanctioned DELETE path for ActivityRow (nightly retention purge). Opens the guard for the duration of the call.';
