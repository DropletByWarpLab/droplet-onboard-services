-- WARP-92: Phase 2 scheduling data model (parental controls / time-of-day)
--
-- Introduces the Schedule / ScheduleWindow / ScheduleOverride / ScheduleEvent
-- family of tables backing the Phase 2 scheduling feature. Schedules bind to
-- either a NetworkDevice (by MAC) or a DeviceGroup (by id); the ticker
-- (WARP-93) reads them every minute to compute the authoritative block state.
-- Adds NetworkDevice.manualBlock — the "always blocked until toggled off"
-- switch surfaced in the dashboard's device row — which composes with schedule
-- state at evaluation time.
--
-- All subject relations use ON DELETE CASCADE: deleting a device or group
-- cleans up its schedules, windows, and overrides. ScheduleEvent is an
-- append-only audit log and intentionally has no FK back to the subject so
-- history survives the subject's deletion.

-- AlterTable
ALTER TABLE "NetworkDevice" ADD COLUMN     "manualBlock" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "subjectType" TEXT NOT NULL,
    "deviceMac" TEXT,
    "groupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleWindow" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "daysOfWeek" INTEGER NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,

    CONSTRAINT "ScheduleWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleOverride" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "deviceMac" TEXT,
    "groupId" TEXT,
    "action" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleEvent" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT,
    "overrideId" TEXT,
    "subjectType" TEXT NOT NULL,
    "deviceMac" TEXT,
    "groupId" TEXT,
    "transition" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Schedule_enabled_idx" ON "Schedule"("enabled");

-- CreateIndex
CREATE INDEX "Schedule_deviceMac_idx" ON "Schedule"("deviceMac");

-- CreateIndex
CREATE INDEX "Schedule_groupId_idx" ON "Schedule"("groupId");

-- CreateIndex
CREATE INDEX "ScheduleWindow_scheduleId_idx" ON "ScheduleWindow"("scheduleId");

-- CreateIndex
CREATE INDEX "ScheduleOverride_endAt_idx" ON "ScheduleOverride"("endAt");

-- CreateIndex
CREATE INDEX "ScheduleOverride_deviceMac_idx" ON "ScheduleOverride"("deviceMac");

-- CreateIndex
CREATE INDEX "ScheduleOverride_groupId_idx" ON "ScheduleOverride"("groupId");

-- CreateIndex
CREATE INDEX "ScheduleEvent_occurredAt_idx" ON "ScheduleEvent"("occurredAt");

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_deviceMac_fkey" FOREIGN KEY ("deviceMac") REFERENCES "NetworkDevice"("mac") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DeviceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleWindow" ADD CONSTRAINT "ScheduleWindow_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleOverride" ADD CONSTRAINT "ScheduleOverride_deviceMac_fkey" FOREIGN KEY ("deviceMac") REFERENCES "NetworkDevice"("mac") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleOverride" ADD CONSTRAINT "ScheduleOverride_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DeviceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
