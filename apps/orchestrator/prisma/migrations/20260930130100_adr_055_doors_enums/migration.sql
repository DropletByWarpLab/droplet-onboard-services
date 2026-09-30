-- ADR-055 (P4a) — the doors enums, in their own migration, before the tables
-- that use them (20260930130200_adr_055_doors_tables).
--
-- Every state the doors surface has is an explicit enum, never the absence of
-- another column (CLAUDE.md "no guessing"): `DoorPositionSource.none` is a
-- value, and so is `AccessPointStatus.retired`.
--
-- RE-RUNNABLE. Each type is created in a DO block that swallows
-- duplicate_object, so a box that applied this folder under an earlier stamp
-- (branch migrations are re-stamped before merge) runs it again as a no-op.

DO $$
BEGIN
  CREATE TYPE "DoorPositionSource" AS ENUM ('lock', 'dp1', 'none');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "AccessPointStatus" AS ENUM ('active', 'retired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Brief §11.3, verbatim.
DO $$
BEGIN
  CREATE TYPE "AccessEventKind" AS ENUM ('door_open', 'door_closed', 'latch_retracted', 'latch_extended', 'bolt_thrown', 'bolt_withdrawn', 'rex', 'key_override', 'unlock_granted', 'unlock_denied', 'forced_door', 'held_open', 'tamper', 'trouble');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "AccessForcedClaim" AS ENUM ('latch_witnessed', 'unwitnessed_open');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "AccessTroubleCode" AS ENUM ('position_unknown');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
