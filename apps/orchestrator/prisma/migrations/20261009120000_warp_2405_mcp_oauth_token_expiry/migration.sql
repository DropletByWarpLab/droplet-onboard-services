-- WARP-2405: when the held MCP access token stops working, for the proactive refresh (WARP-2416).
ALTER TABLE "McpOAuthConnection" ADD COLUMN "tokenExpiresAt" TIMESTAMP(3);
CREATE INDEX "McpOAuthConnection_state_tokenExpiresAt_idx" ON "McpOAuthConnection"("state", "tokenExpiresAt");
