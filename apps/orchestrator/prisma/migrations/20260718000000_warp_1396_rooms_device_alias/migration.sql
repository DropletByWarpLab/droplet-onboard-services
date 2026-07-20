-- WARP-1396 — device rooms + aliases (the household map).
--
-- Rooms are a Droplet-LOCAL concept (never Matter fabric state); a DeviceAlias
-- carries a device's speakable name + room, keyed by the Matter nodeId. The
-- alias is deliberately NOT the Matter nodeLabel (bridged ecosystems fight over
-- it) and survives re-commissioning. Deleting a room nulls the link — devices
-- are never deleted with a room.

CREATE TABLE "Room" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "icon"      TEXT NOT NULL DEFAULT 'home',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceAlias" (
    "nodeId"    TEXT NOT NULL,
    "name"      TEXT,
    "roomId"    TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeviceAlias_pkey" PRIMARY KEY ("nodeId")
);

CREATE INDEX "DeviceAlias_roomId_idx" ON "DeviceAlias"("roomId");

ALTER TABLE "DeviceAlias"
    ADD CONSTRAINT "DeviceAlias_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
