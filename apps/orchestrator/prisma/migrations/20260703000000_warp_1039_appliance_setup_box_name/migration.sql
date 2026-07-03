-- WARP-1039: persist the owner-chosen box name on the ApplianceSetup
-- singleton so the wizard can read it back in-session.
--
-- POST /setup/box-name already writes DROPLET_BOX_NAME to the host .env via
-- the device-bridge, but the orchestrator's `config` is a boot-time snapshot —
-- nothing in-process ever sees the new value until the next container
-- recreate. This column is the in-session source of truth for
-- GET /setup/box-name (AddressStep rehydration + VpnStep's honest
-- "address is being set up" blocked view).
--
-- ADDITIVE + NULLABLE on purpose: the 20260531150000 seed migration raw-INSERTs
-- the singleton row with an explicit column list, so adding a nullable column
-- keeps that migration valid on a fresh database. IF NOT EXISTS keeps a re-run
-- on a converged DB a no-op (same idempotency posture as the seed's
-- ON CONFLICT DO NOTHING).

ALTER TABLE "ApplianceSetup" ADD COLUMN IF NOT EXISTS "boxName" TEXT;
