-- WARP-2767 — the calendar ICS feed link becomes a stored, revocable credential.
--
-- Before: the feed token was HMAC(DEVICE_SECRET, "calendar:"+username) — no
-- server-side record, so it could not expire, rotate or be revoked, and it
-- was bound to a username string rather than an account. Every link issued
-- under that scheme stops working when this ships; users mint a new one from
-- Calendar → "Subscribe phones".
--
-- Only sha256 of the secret half of the token is stored. Rows cascade with
-- the owning User so a reused username can never inherit an old link.

-- CreateEnum
CREATE TYPE "CalendarFeedTokenState" AS ENUM ('active', 'rotated', 'revoked', 'expired');

-- CreateTable
CREATE TABLE "CalendarFeedToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "state" "CalendarFeedTokenState" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "CalendarFeedToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarFeedToken_userId_state_idx" ON "CalendarFeedToken"("userId", "state");

-- AddForeignKey
ALTER TABLE "CalendarFeedToken" ADD CONSTRAINT "CalendarFeedToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
