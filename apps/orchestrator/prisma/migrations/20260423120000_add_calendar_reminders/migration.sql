-- Calendar / Reminders / Notifications (PR #2)
--
-- See schema.prisma for model docs. Notes on shape:
--  * `userId` is the Nextcloud username (string). Matches the rest of the
--    codebase — there is no separate User table.
--  * `CalendarEvent.externalUid` is the iCalendar UID. Combined with
--    `sourceId` it forms an idempotency key so re-syncs upsert in place.
--  * `CalendarSource.passwordEnc` is encrypted with the same aes-256-gcm key
--    used by `DeviceClient.ncAppPassword` (apps/orchestrator/src/services/encryption.service.ts).

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "title"        TEXT NOT NULL,
    "description"  TEXT,
    "location"     TEXT,
    "startsAt"     TIMESTAMP(3) NOT NULL,
    "endsAt"       TIMESTAMP(3) NOT NULL,
    "allDay"       BOOLEAN NOT NULL DEFAULT false,
    "source"       TEXT NOT NULL DEFAULT 'local',
    "sourceId"     TEXT,
    "externalUid"  TEXT,
    "externalEtag" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CalendarEvent_sourceId_externalUid_key" ON "CalendarEvent"("sourceId", "externalUid");
CREATE INDEX "CalendarEvent_userId_startsAt_idx" ON "CalendarEvent"("userId", "startsAt");
CREATE INDEX "CalendarEvent_userId_source_idx" ON "CalendarEvent"("userId", "source");

-- CreateTable
CREATE TABLE "CalendarSource" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "url"             TEXT NOT NULL,
    "authMode"        TEXT NOT NULL DEFAULT 'basic',
    "username"        TEXT,
    "passwordEnc"     TEXT,
    "syncIntervalSec" INTEGER NOT NULL DEFAULT 900,
    "lastSyncAt"      TIMESTAMP(3),
    "lastSyncError"   TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarSource_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CalendarSource_userId_idx" ON "CalendarSource"("userId");

-- CreateTable
CREATE TABLE "Reminder" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "body"            TEXT,
    "dueAt"           TIMESTAMP(3) NOT NULL,
    "completedAt"     TIMESTAMP(3),
    "calendarEventId" TEXT,
    "notifiedAt"      TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Reminder_userId_dueAt_idx" ON "Reminder"("userId", "dueAt");
CREATE INDEX "Reminder_completedAt_idx" ON "Reminder"("completedAt");

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "kind"        TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "body"        TEXT,
    "channels"    TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "error"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationLog_userId_createdAt_idx" ON "NotificationLog"("userId", "createdAt");
