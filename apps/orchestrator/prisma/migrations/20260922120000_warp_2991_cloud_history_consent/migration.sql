-- WARP-2991 — consent to replay a conversation's on-box answers to a cloud
-- model. Explicit enum; the default `not_asked` behaves exactly like
-- `declined` (the server replays the user's own messages only), so every
-- existing conversation is fail-closed from the moment this lands.
CREATE TYPE "CloudHistoryConsent" AS ENUM ('not_asked', 'granted', 'declined');

ALTER TABLE "ChatSession"
    ADD COLUMN "cloudHistoryConsent" "CloudHistoryConsent" NOT NULL DEFAULT 'not_asked',
    ADD COLUMN "cloudHistoryConsentAt" TIMESTAMP(3),
    ADD COLUMN "cloudHistoryConsentBy" TEXT;

-- A decision names who made it and when; `not_asked` carries neither.
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_cloudHistoryConsent_has_actor" CHECK (
    ("cloudHistoryConsent" = 'not_asked' AND "cloudHistoryConsentAt" IS NULL AND "cloudHistoryConsentBy" IS NULL)
    OR ("cloudHistoryConsent" <> 'not_asked' AND "cloudHistoryConsentAt" IS NOT NULL AND "cloudHistoryConsentBy" IS NOT NULL)
);
