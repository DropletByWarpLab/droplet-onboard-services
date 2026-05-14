-- WARP-174: per-drive customer-chosen names + icons + notes.
-- The setup wizard's Storage step upserts here via
-- PATCH /api/storage/drives/:uuid. UUID is the filesystem UUID, stable
-- across reboots; same shape pattern as NetworkDevice.displayName.
CREATE TABLE "Drive" (
    "uuid" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "icon" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Drive_pkey" PRIMARY KEY ("uuid")
);
