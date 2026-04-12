-- Phase 3b: per-user device client registry + pairing code table
--
-- DeviceClient is the per-user counterpart to the existing Device table
-- (which tracks the Droplet hardware itself). Each row is a laptop or phone
-- that has been paired via the QR-code onboarding flow. ncAppPassword holds
-- an aes-256-gcm-encrypted copy of the Nextcloud app password minted for
-- that device, so we can revoke it later without ever logging the plaintext.
--
-- PairingCode is a short-lived one-shot token that the dashboard generates
-- and a native client consumes to complete pairing. 10-minute TTL.

CREATE TABLE "DeviceClient" (
    "id"            TEXT         NOT NULL,
    "userId"        TEXT         NOT NULL,
    "deviceName"    TEXT         NOT NULL,
    "deviceType"    TEXT         NOT NULL,
    "platform"      TEXT         NOT NULL,
    "appVersion"    TEXT,
    "ncAppPassword" TEXT         NOT NULL,
    "lastSeen"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status"        TEXT         NOT NULL DEFAULT 'active',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceClient_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeviceClient_userId_idx" ON "DeviceClient"("userId");
CREATE INDEX "DeviceClient_status_idx" ON "DeviceClient"("status");

CREATE TABLE "PairingCode" (
    "id"         TEXT         NOT NULL,
    "code"       TEXT         NOT NULL,
    "userId"     TEXT         NOT NULL,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "used"       BOOLEAN      NOT NULL DEFAULT false,
    "claimedBy"  TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairingCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PairingCode_code_key" ON "PairingCode"("code");
CREATE INDEX "PairingCode_code_idx" ON "PairingCode"("code");
CREATE INDEX "PairingCode_expiresAt_idx" ON "PairingCode"("expiresAt");
