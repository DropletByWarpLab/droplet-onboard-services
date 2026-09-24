-- WARP-2704 + WARP-2705 (ADR-041, ADR-042) — Microsoft 365 signs in through
-- the customer's own Entra app, by authorization code + PKCE.
--
-- Additive only; every new column is nullable and no existing row changes.
--
-- appClientId / appTenantId (WARP-2705): the customer-registered, single-tenant
-- app a link signs in through. Replaces the box-wide M365_CLIENT_ID and the
-- hardcoded `/organizations` authority. Non-secret, and they survive a
-- disconnect so reconnecting does not mean re-pasting them.
--
-- pendingStateHash / pendingFlowEnc (WARP-2704): the in-flight
-- authorization-code sign-in. The callback finds the row by the SHA-256 of its
-- OAuth `state` (hence the unique index; Postgres allows many NULLs) and
-- clears both in the same statement that claims the flow, so a callback is
-- single-use. pendingFlowEnc is a dcv1: blob holding the PKCE verifier, the
-- nonce and the redirect URI; it is never returned by a route.

-- AlterTable
ALTER TABLE "M365Connection" ADD COLUMN     "appClientId" TEXT,
ADD COLUMN     "appTenantId" TEXT,
ADD COLUMN     "pendingFlowEnc" TEXT,
ADD COLUMN     "pendingStateHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "M365Connection_pendingStateHash_key" ON "M365Connection"("pendingStateHash");
