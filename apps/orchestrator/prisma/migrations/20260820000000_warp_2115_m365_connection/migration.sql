-- WARP-2115 / ADR-041 — Microsoft 365 cloud connector: per-user delegated
-- account link plus its encrypted token cache.
--
-- One row per Droplet user. ADR-041 mandates delegated authorization rather
-- than application permissions, so the box reads Microsoft *as that person*
-- and can never see what they cannot.
--
-- `state` is an explicit enum, never inferred from whether a token is present:
-- DISCONNECTED and NEEDS_RECONNECT are indistinguishable by "is there a usable
-- token" but mean opposite things to the person reading the dashboard.

-- CreateEnum
CREATE TYPE "M365ConnectionState" AS ENUM (
  'DISCONNECTED',
  'PENDING_CONSENT',
  'CONNECTED',
  'NEEDS_RECONNECT',
  'ERROR'
);

-- CreateTable
CREATE TABLE "M365Connection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" "M365ConnectionState" NOT NULL DEFAULT 'DISCONNECTED',
    "homeAccountId" TEXT,
    "tenantId" TEXT,
    "accountUpn" TEXT,
    -- dcv1: blob (column-crypto.service) of the MSAL token cache. Contains the
    -- refresh token; AAD-bound to userId. Never logged or returned by a route.
    "tokenCacheEnc" TEXT,
    "grantedScopes" TEXT,
    "pendingFlowExpiresAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "lastRefreshOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "M365Connection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "M365Connection_userId_key" ON "M365Connection"("userId");

-- CreateIndex
CREATE INDEX "M365Connection_state_idx" ON "M365Connection"("state");
