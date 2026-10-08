-- WARP-2434: per-server positive tool allowlist. Explicit boolean, default
-- false: an existing row (and every newly discovered tool) is NOT admitted
-- until an owner/admin allowlists it.
ALTER TABLE "RemoteToolClassification" ADD COLUMN "allowlisted" BOOLEAN NOT NULL DEFAULT false;
