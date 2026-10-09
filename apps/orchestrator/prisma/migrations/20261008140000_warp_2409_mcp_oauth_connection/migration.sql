-- WARP-2409 / WARP-2412 / ADR-072: per-member (default) or Workspace MCP OAuth connections.
CREATE TYPE "McpOAuthScope" AS ENUM ('MEMBER', 'WORKSPACE');
CREATE TYPE "McpOAuthConnectionState" AS ENUM ('DISCONNECTED', 'PENDING_CONSENT', 'CONNECTED', 'NEEDS_RECONNECT', 'ERROR');

CREATE TABLE "McpOAuthConnection" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "scope" "McpOAuthScope" NOT NULL,
  "memberId" TEXT,
  "state" "McpOAuthConnectionState" NOT NULL DEFAULT 'DISCONNECTED',
  "issuer" TEXT NOT NULL,
  "tokenEndpointHost" TEXT NOT NULL,
  "clientId" TEXT,
  "clientSecretEnc" TEXT,
  "tokensEnc" TEXT,
  "workspaceAckAt" TIMESTAMP(3),
  "workspaceAckBy" TEXT,
  "connectedAt" TIMESTAMP(3),
  "lastRefreshOkAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "McpOAuthConnection_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "McpOAuthConnection_provider_memberId_key" ON "McpOAuthConnection"("provider", "memberId");
CREATE INDEX "McpOAuthConnection_memberId_idx" ON "McpOAuthConnection"("memberId");
-- NULL memberId is distinct to Postgres, so the unique above cannot cover WORKSPACE rows.
CREATE UNIQUE INDEX "McpOAuthConnection_workspace_provider_key" ON "McpOAuthConnection"("provider") WHERE "scope" = 'WORKSPACE';

-- Owner is explicit: MEMBER <=> memberId set. Never "null means Workspace".
ALTER TABLE "McpOAuthConnection" ADD CONSTRAINT "McpOAuthConnection_owner_check"
  CHECK (("scope" = 'MEMBER') = ("memberId" IS NOT NULL));
-- A Workspace connection exists only with the admin's acknowledgement.
ALTER TABLE "McpOAuthConnection" ADD CONSTRAINT "McpOAuthConnection_workspace_ack_check"
  CHECK ("scope" <> 'WORKSPACE' OR ("workspaceAckAt" IS NOT NULL AND "workspaceAckBy" IS NOT NULL));
-- CONNECTED without a token is a lie.
ALTER TABLE "McpOAuthConnection" ADD CONSTRAINT "McpOAuthConnection_connected_token_check"
  CHECK ("state" <> 'CONNECTED' OR "tokensEnc" IS NOT NULL);
