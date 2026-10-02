-- WARP-2904: NotificationLog records what the web-push leg did as an explicit
-- enum, so a refused dial (off-LAN gate off) is distinguishable in a query
-- from "no subscribers" and from "push service failed". Nullable: rows
-- written before this migration have no recorded outcome.

-- CreateEnum
CREATE TYPE "PushOutcome" AS ENUM ('sent', 'no_subscribers', 'refused_gate', 'failed');

-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN "pushOutcome" "PushOutcome";
