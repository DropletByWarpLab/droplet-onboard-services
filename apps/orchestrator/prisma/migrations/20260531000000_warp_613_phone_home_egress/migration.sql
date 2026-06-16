-- WARP-613: phone-home egress control.
--
-- Adds an explicit per-device applied-egress state and a per-group
-- "block phone home" flag. The master + camera toggles live in
-- WorkspaceSetting (section `hardware`) and need no schema change.
--
-- DeviceEgressState is explicit (handbook "state is explicit, never derive
-- from absence"); the egress reconciler diffs `lastAppliedEgress` to decide
-- whether to dispatch. Existing `lastAppliedBlocked` (schedule ticker) is
-- untouched.

BEGIN;

CREATE TYPE "DeviceEgressState" AS ENUM ('open', 'phone_home_blocked', 'full_blocked');

ALTER TABLE "NetworkDevice"
    ADD COLUMN "lastAppliedEgress" "DeviceEgressState" NOT NULL DEFAULT 'open';

ALTER TABLE "DeviceGroup"
    ADD COLUMN "blockPhoneHome" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
