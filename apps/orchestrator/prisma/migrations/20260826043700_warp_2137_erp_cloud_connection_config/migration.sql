-- WARP-2137 / ADR-041 — connection material for the cloud ERP tracks
-- (quickbooks-online, dentrix-ascend), which the Eaglesoft-shaped columns on
-- IntegrationConnection cannot express.
--
-- The existing columns describe a box on the practice LAN: host, port,
-- databaseName, plus the REST track's route map and CA. A cloud track has no
-- LAN host to reach. What it needs instead is the vendor's own identifier for
-- the account -- Intuit's realmId, Dentrix Ascend's organizationId -- and a
-- place to keep rotating OAuth tokens.
--
-- Both columns are nullable and untouched by every LAN track, so this migration
-- is additive and no existing row changes meaning.

-- Provider-specific connection facts, validated structurally per provider when
-- read (parseProviderConfig) rather than cast. Deliberately NOT overloading
-- `databaseName` or `host`: borrowing a LAN column would collide with its
-- "PattersonPM"/hostname default and make a misconfigured cloud row look
-- exactly like a mistyped LAN one.
ALTER TABLE "IntegrationConnection" ADD COLUMN "providerConfig" JSONB;

-- The cloud track's OAuth tokens, encrypted with column-crypto's
-- deriveErpCloudTokenKey() and AAD-bound to the row id so a blob copied onto
-- another connection fails closed rather than authenticating as the wrong
-- company. Kept separate from apiCredentialsEnc, which holds Eaglesoft's static
-- credential triple under the older encryptSecret primitive: these rotate, and
-- Intuit issues a NEW refresh token on every use.
ALTER TABLE "IntegrationConnection" ADD COLUMN "providerTokensEnc" TEXT;
