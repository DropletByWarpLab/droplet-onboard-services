-- WARP-3172 — a leaver's overlay device revoked on the box while HQ was
-- unreachable. The router peer is removed and the row is revoked, but HQ may
-- still broker sessions for the key; this flag tells the connect tick to keep
-- refusing the device and retry the HQ revoke. Explicit column, default false,
-- so every existing row reads "nothing owed".
ALTER TABLE "VpnPeer" ADD COLUMN IF NOT EXISTS "hqRevokePending" BOOLEAN NOT NULL DEFAULT false;
