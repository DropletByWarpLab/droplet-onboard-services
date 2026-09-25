-- WARP-2978 PR-D (ADR-059 P3 spec §6.12, D35) — early presence: append
-- 'detection_ongoing' to SecurityEventKind.
--
-- A person who stays in view is written ONCE, about 30 s after Frigate starts
-- tracking them, as a NEW row (kind detection_ongoing, key
-- `frigate-ongoing:<frigate id>`), so an after-hours alert no longer waits for
-- Frigate's `end`. The `end` still writes its own `detection` row; nothing is
-- ever UPDATEd (SecurityEvent is append-only — the trigger from
-- 20260925030000_warp_2978_security_incidents).
--
-- Its OWN migration directory, stamped BEFORE the CHECK's
-- (20260925030200_warp_2978_security_event_ongoing_shape), because PostgreSQL
-- will not let a transaction use an enum value that the same transaction
-- added. Guarded on pg_enum so a re-run is a no-op — the idiom from
-- 20260924000000_warp_2977_security_mode_event_values. Nothing else goes in
-- this folder.
--
-- Re-stamped 20260925030000 → 20260925030100 while unmerged, after the
-- incidents backend moved to 20260925030000 (past #2357's 20260925020000). A
-- dev box that applied the old stamp runs this again under the new name: the
-- pg_enum guard makes that a no-op.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'SecurityEventKind' AND e.enumlabel = 'detection_ongoing'
    ) THEN
        ALTER TYPE "SecurityEventKind" ADD VALUE 'detection_ongoing';
    END IF;
END $$;
