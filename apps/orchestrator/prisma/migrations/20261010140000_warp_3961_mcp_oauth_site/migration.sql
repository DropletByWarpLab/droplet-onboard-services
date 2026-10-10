-- WARP-3961: the site comes from the Atlassian sign-in, and the API-token form is gone.

-- The site a sign-in is pinned to (Atlassian cloud id, url, display name), and every
-- site the token reached (JSON array of {id,url,name}). Chosen right after the code
-- exchange; every session of this connection is forced onto "siteId".
ALTER TABLE "McpOAuthConnection" ADD COLUMN "siteId" TEXT;
ALTER TABLE "McpOAuthConnection" ADD COLUMN "siteUrl" TEXT;
ALTER TABLE "McpOAuthConnection" ADD COLUMN "siteName" TEXT;
ALTER TABLE "McpOAuthConnection" ADD COLUMN "sites" JSONB;

-- Upgrade: a sign-in made before this change used the site id an admin typed on the
-- API-token form (IntegrationConnection."providerConfig"."cloudId"). Keep those
-- sign-ins working by carrying that id over; siteUrl / siteName stay NULL until the
-- person signs in again. A sign-in with no id to carry stays CONNECTED but is refused
-- at call time with "sign in again" (the session cannot be pinned to a site).
UPDATE "McpOAuthConnection" m
SET "siteId" = btrim(c."providerConfig"->>'cloudId')
FROM "IntegrationConnection" c
WHERE m."provider" = 'atlassian'
  AND c."provider" = 'atlassian'
  AND m."siteId" IS NULL
  AND m."state" = 'CONNECTED'
  AND btrim(coalesce(c."providerConfig"->>'cloudId', '')) <> '';

-- Upgrade: the Basic / API-token credential path is deleted. A legacy CONNECTED row
-- that holds a sealed API token is retired: NOT_CONFIGURED with the sealed bundle and
-- its (non-secret) config cleared, so the hub says "Sign in with Atlassian to reconnect".
-- A DISABLED row is the owner's per-server off and is left exactly as it is.
UPDATE "IntegrationConnection"
SET "status" = 'NOT_CONFIGURED', "providerTokensEnc" = NULL, "providerConfig" = NULL, "updatedAt" = now()
WHERE "provider" = 'atlassian'
  AND "status" = 'CONNECTED'
  AND "providerTokensEnc" IS NOT NULL;
