-- WARP-1962: per-camera access.
--
-- Role tiers (WARP-1961) answer "may this person watch recordings at all".
-- They cannot answer "may this person watch THE BEDROOM" — a `family`
-- member who should see the front door otherwise sees every camera in the
-- house.
--
-- A GRANT table, not a deny-list: access is an explicit row rather than
-- something inferred from a null. The default for a camera with no grants
-- is owner/admin only, so adding a camera never silently exposes it.
--
-- No backfill on purpose. Granting every existing user every existing
-- camera would preserve today's behaviour and defeat the entire ticket;
-- an owner assigns access deliberately. Owners and admins are unaffected —
-- their access does not come from this table.
CREATE TABLE "CameraAccessGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT,

    CONSTRAINT "CameraAccessGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CameraAccessGrant_userId_cameraId_key"
    ON "CameraAccessGrant"("userId", "cameraId");
CREATE INDEX "CameraAccessGrant_userId_idx" ON "CameraAccessGrant"("userId");
CREATE INDEX "CameraAccessGrant_cameraId_idx" ON "CameraAccessGrant"("cameraId");

-- Deleting a camera drops its grants; nothing should outlive the thing it
-- refers to and become a stale permission on a re-used name.
ALTER TABLE "CameraAccessGrant" ADD CONSTRAINT "CameraAccessGrant_cameraId_fkey"
    FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;
