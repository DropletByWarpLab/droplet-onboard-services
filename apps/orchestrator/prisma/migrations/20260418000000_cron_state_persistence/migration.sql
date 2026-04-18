-- Critical fix #2: persist the schedule ticker's last-applied firewall state
-- to the database so it survives orchestrator restart. Previously the ticker
-- kept a closure-local Map<mac, boolean>; on restart that Map was empty and
-- the first tick re-dispatched every device.
--
-- Nullable with no default: existing rows get NULL, which the ticker treats
-- as "I have never dispatched this device" (bootstrap path). First tick post
-- migration will re-dispatch every device exactly once — accepted one-time
-- cost, matches pre-fix behavior on restart.

-- AlterTable
ALTER TABLE "NetworkDevice" ADD COLUMN "lastAppliedBlocked" BOOLEAN;
