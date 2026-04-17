-- WARP-80: Device intelligence — NetworkDevice / DeviceGroup / DevicePresenceDay
--
-- Introduces the per-client-device registry that the reconciler (WARP-81) will
-- populate from routing-service leases/ARP snapshots. Also seeds five default
-- rooms idempotently so a fresh install lights up the dashboard with useful
-- grouping out of the box.

-- CreateTable
CREATE TABLE "NetworkDevice" (
    "mac" TEXT NOT NULL,
    "displayName" TEXT,
    "icon" TEXT,
    "notes" TEXT,
    "vendor" TEXT,
    "hostname" TEXT,
    "lastIp" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NetworkDevice_pkey" PRIMARY KEY ("mac")
);

-- CreateTable
CREATE TABLE "DeviceGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "icon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevicePresenceDay" (
    "mac" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "seenMinutes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DevicePresenceDay_pkey" PRIMARY KEY ("mac","date")
);

-- CreateTable
CREATE TABLE "_DeviceGroups" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "NetworkDevice_lastSeen_idx" ON "NetworkDevice"("lastSeen");

-- CreateIndex
CREATE INDEX "NetworkDevice_vendor_idx" ON "NetworkDevice"("vendor");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceGroup_name_key" ON "DeviceGroup"("name");

-- CreateIndex
CREATE INDEX "DevicePresenceDay_date_idx" ON "DevicePresenceDay"("date");

-- CreateIndex
CREATE UNIQUE INDEX "_DeviceGroups_AB_unique" ON "_DeviceGroups"("A", "B");

-- CreateIndex
CREATE INDEX "_DeviceGroups_B_index" ON "_DeviceGroups"("B");

-- AddForeignKey
ALTER TABLE "DevicePresenceDay" ADD CONSTRAINT "DevicePresenceDay_mac_fkey" FOREIGN KEY ("mac") REFERENCES "NetworkDevice"("mac") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DeviceGroups" ADD CONSTRAINT "_DeviceGroups_A_fkey" FOREIGN KEY ("A") REFERENCES "DeviceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DeviceGroups" ADD CONSTRAINT "_DeviceGroups_B_fkey" FOREIGN KEY ("B") REFERENCES "NetworkDevice"("mac") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed default rooms (idempotent — re-running the migration will not duplicate rows).
-- IDs are literal 25-char cuid-shape strings so they sort stable across DB recreation
-- and match the shape produced by Prisma's @default(cuid()) at runtime.
INSERT INTO "DeviceGroup" ("id", "name", "createdAt", "updatedAt")
VALUES
  ('cseed00000000000000livingrm', 'Living Room', NOW(), NOW()),
  ('cseed00000000000000bedroom0', 'Bedroom',     NOW(), NOW()),
  ('cseed00000000000000office00', 'Office',      NOW(), NOW()),
  ('cseed00000000000000kitchen0', 'Kitchen',     NOW(), NOW()),
  ('cseed00000000000000garage00', 'Garage',      NOW(), NOW())
ON CONFLICT ("name") DO NOTHING;
