-- DeviceClient.kind: which flow minted the row (app pairing vs personal drive).
--
-- Turning personal drives off (PUT /api/settings/workspace/personal-drive
-- enabled=false) must revoke the Finder / File Explorer logins that
-- POST /api/storage/network-drive/personal minted (WARP-3318) and leave the
-- native-app pairings alone. Both flows write a DeviceClient row
-- (deviceType "desktop"), so the row needs an EXPLICIT discriminator —
-- CLAUDE.md "no guessing": never derive it from `deviceName`, which the user
-- can set either way, nor from the absence of a PairingCode.claimedBy link,
-- which the daily 03:00 purge deletes.
--
-- Idempotent: CREATE TYPE is duplicate_object guarded, ADD COLUMN IF NOT
-- EXISTS. Every existing row takes the default (app_pairing).
--
-- NO BACKFILL, on purpose. Personal-drive rows written before this migration
-- cannot be told apart from pairing rows by any explicit signal (the name
-- prefix is free text; the pairing-code link is purged). They stay
-- app_pairing, so turning personal drives off does NOT bulk-revoke them; their
-- owners can still revoke each one from the devices list
-- (DELETE /api/devices/clients/:id). The feature ships OFF by default, so this
-- is bounded to boxes whose owner already turned it on.

DO $$ BEGIN
    CREATE TYPE "DeviceClientKind" AS ENUM ('app_pairing', 'personal_drive');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "DeviceClient"
    ADD COLUMN IF NOT EXISTS "kind" "DeviceClientKind" NOT NULL DEFAULT 'app_pairing';
