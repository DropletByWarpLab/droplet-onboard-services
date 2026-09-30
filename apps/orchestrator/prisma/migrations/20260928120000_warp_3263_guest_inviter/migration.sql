-- WARP-3263: an external guest's Messages roster shows the person who invited
-- them. Store that link as an explicit id instead of inferring it from
-- UserInvite.username + acceptedAt + the inviter's username string.
--
-- Additive: two nullable columns, no backfill. An account that predates this
-- migration has no recorded inviter, so a guest among them sees only the
-- people in their conversations. That fails closed.
--
-- Predecessor: 20260926130100_warp_3193_chat_turn_unique.

ALTER TABLE "UserInvite" ADD COLUMN "createdById" TEXT;

ALTER TABLE "User" ADD COLUMN "invitedById" TEXT;

ALTER TABLE "User" ADD CONSTRAINT "User_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
