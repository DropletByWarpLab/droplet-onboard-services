-- WARP-2416: the OAuth client a box uses for a remote MCP provider, stored ONCE per
-- (provider, issuer) instead of copied onto every sign-in row.
CREATE TYPE "McpOAuthClientSource" AS ENUM ('PASTED', 'DCR');

CREATE TABLE "McpOAuthClient" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientSecretEnc" TEXT,
  "source" "McpOAuthClientSource" NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedBy" TEXT
);

CREATE UNIQUE INDEX "McpOAuthClient_provider_issuer_key" ON "McpOAuthClient"("provider", "issuer");
