-- WARP-3529 (ADR-069 §4, WS-13) — the service desk's email channel.
--
-- ── what ships here ────────────────────────────────────────────────────────
--
--   1. PmSupportChannel — a desk's email front door: one mailbox, one desk, the
--      owner of the contacts intake creates, the auto-acknowledge template and
--      the reopen window.
--   2. PmTicketEmailLink — one row per email of a ticket's conversation, in
--      either direction: how a later message finds its ticket.
--   3. EmailMessage.headers (the Auto-Submitted / Precedence / References ...
--      facts the indexer records) and EmailMessage.deskIntake* — the desk's
--      idempotent ledger for the mail the box already stores. The ingest route
--      validates and persists the bounded headers shape before intake runs.
--   4. EmailDraft.messageId / autoSubmitted — the Message-ID the desk chose for a
--      reply (the indexer sends exactly that) and whether it is an automatic
--      acknowledgement.
--   5. PmComment.deliveryStatus / deliveryFailure — whether a public reply's
--      email reached the mail server.
--   6. PmState.onCustomerReply — what a customer's email does to a ticket in that
--      state (Solved and Closed are both a completed state; which takes a reply
--      back is the desk's rule, so it is a column rather than a name).
--   7. The invariants Prisma's schema language cannot express (below), each proven
--      against a real Postgres in support-email.pg.test.ts.
--
-- No enum is EXTENDED here — every enum below is a new type — so nothing needs the
-- separate ALTER TYPE ... ADD VALUE migration the reserved 20261004125900 slot
-- stands for (Postgres will not use a label added in the same transaction).
--
-- Additive only: no existing row is touched except the PmState backfill at the
-- bottom, no existing column changes meaning, and a box that never binds a mailbox
-- is unaffected. Every existing EmailMessage becomes PENDING for the desk, which is
-- inert: only a mailbox bound to a channel is ever read, and only mail received
-- after the channel was switched on.

-- ── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "PmSupportChannelKind" AS ENUM ('EMAIL');
CREATE TYPE "PmEmailDirection" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "PmDeliveryStatus" AS ENUM ('NONE', 'PENDING', 'SENT', 'FAILED');
CREATE TYPE "PmDeliveryFailure" AS ENUM ('OUTBOUND_BLOCKED', 'EMAIL_UNAVAILABLE', 'NO_RECIPIENT', 'SEND_FAILED');
CREATE TYPE "PmCustomerReplyEffect" AS ENUM ('NONE', 'REOPEN', 'FOLLOW_UP');
CREATE TYPE "PmEmailIntakeStatus" AS ENUM ('PENDING', 'DONE', 'IGNORED', 'FAILED');
CREATE TYPE "PmEmailIntakeReason" AS ENUM ('AUTO_SUBMITTED', 'PRECEDENCE_BULK', 'AUTO_REPLY_HEADER', 'BOUNCE', 'OWN_ADDRESS', 'OWN_MESSAGE', 'RATE_LIMITED', 'DESK_ARCHIVED', 'PROCESSING_ERROR', 'CONTACT_OWNER_UNAVAILABLE');

-- ── Columns on existing tables ──────────────────────────────────────────────
-- Every one is nullable or carries a constant default, so this is a catalog
-- change and not a table rewrite — and services/email-indexer, which READS
-- EmailDraft with its own SQL, is never handed a NOT NULL column it must fill.

ALTER TABLE "EmailDraft" ADD COLUMN     "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "messageId" TEXT;

ALTER TABLE "EmailMessage" ADD COLUMN     "deskIntakeAt" TIMESTAMP(3),
ADD COLUMN     "deskIntakeAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deskIntakeReason" "PmEmailIntakeReason",
ADD COLUMN     "deskIntakeStatus" "PmEmailIntakeStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "headers" JSONB;

ALTER TABLE "PmComment" ADD COLUMN     "deliveryFailure" "PmDeliveryFailure",
ADD COLUMN     "deliveryStatus" "PmDeliveryStatus" NOT NULL DEFAULT 'NONE';

ALTER TABLE "PmState" ADD COLUMN     "onCustomerReply" "PmCustomerReplyEffect" NOT NULL DEFAULT 'NONE';

-- ── PmSupportChannel ────────────────────────────────────────────────────────

CREATE TABLE "PmSupportChannel" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "PmSupportChannelKind" NOT NULL DEFAULT 'EMAIL',
    "emailAccountId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactOwnerUserId" TEXT NOT NULL,
    "autoAckEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoAckTemplate" TEXT NOT NULL,
    "reopenWindowDays" INTEGER NOT NULL DEFAULT 14,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmSupportChannel_pkey" PRIMARY KEY ("id")
);

-- ── PmTicketEmailLink ───────────────────────────────────────────────────────

CREATE TABLE "PmTicketEmailLink" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "direction" "PmEmailDirection" NOT NULL,
    "messageIdHeader" TEXT NOT NULL,
    "emailThreadId" TEXT,
    "emailMessageId" TEXT,
    "emailDraftId" TEXT,
    "commentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmTicketEmailLink_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ─────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "PmSupportChannel_emailAccountId_key" ON "PmSupportChannel"("emailAccountId");
CREATE UNIQUE INDEX "PmSupportChannel_projectId_kind_key" ON "PmSupportChannel"("projectId", "kind");

CREATE UNIQUE INDEX "PmTicketEmailLink_emailMessageId_key" ON "PmTicketEmailLink"("emailMessageId");
CREATE UNIQUE INDEX "PmTicketEmailLink_emailDraftId_key" ON "PmTicketEmailLink"("emailDraftId");
CREATE INDEX "PmTicketEmailLink_messageIdHeader_idx" ON "PmTicketEmailLink"("messageIdHeader");
CREATE INDEX "PmTicketEmailLink_emailThreadId_createdAt_idx" ON "PmTicketEmailLink"("emailThreadId", "createdAt");
CREATE INDEX "PmTicketEmailLink_workItemId_createdAt_idx" ON "PmTicketEmailLink"("workItemId", "createdAt");
CREATE INDEX "PmTicketEmailLink_commentId_idx" ON "PmTicketEmailLink"("commentId");
CREATE UNIQUE INDEX "PmTicketEmailLink_workItemId_messageIdHeader_key" ON "PmTicketEmailLink"("workItemId", "messageIdHeader");

CREATE UNIQUE INDEX "EmailDraft_messageId_key" ON "EmailDraft"("messageId");

CREATE INDEX "EmailMessage_accountId_deskIntakeStatus_createdAt_idx" ON "EmailMessage"("accountId", "deskIntakeStatus", "createdAt");
CREATE INDEX "EmailMessage_accountId_createdAt_idx" ON "EmailMessage"("accountId", "createdAt");

CREATE INDEX "PmComment_deliveryStatus_createdAt_idx" ON "PmComment"("deliveryStatus", "createdAt");

-- ── Foreign keys ────────────────────────────────────────────────────────────
-- A channel cascades with its desk and with its mailbox. A link cascades with
-- its TICKET (so it can only exist for one — the ticket row only ever hangs off a
-- SERVICE_DESK item, see 20261004120000), and sets null on everything it merely
-- points at: an email, a thread, a draft or a comment going away must not take the
-- record that the conversation happened with it.

ALTER TABLE "PmSupportChannel" ADD CONSTRAINT "PmSupportChannel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PmSupportChannel" ADD CONSTRAINT "PmSupportChannel_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PmTicketEmailLink" ADD CONSTRAINT "PmTicketEmailLink_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmTicket"("workItemId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PmTicketEmailLink" ADD CONSTRAINT "PmTicketEmailLink_emailThreadId_fkey" FOREIGN KEY ("emailThreadId") REFERENCES "EmailThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PmTicketEmailLink" ADD CONSTRAINT "PmTicketEmailLink_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PmTicketEmailLink" ADD CONSTRAINT "PmTicketEmailLink_emailDraftId_fkey" FOREIGN KEY ("emailDraftId") REFERENCES "EmailDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PmTicketEmailLink" ADD CONSTRAINT "PmTicketEmailLink_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "PmComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Invariants Prisma's schema language cannot express ──────────────────────
-- None of the CHECKs below names a column that an ON DELETE SET NULL above can
-- null out in a way the CHECK forbids (the trap CrmCompany.proposalId documents):
-- the link's CHECK only forbids a draft on an inbound row and a message on an
-- outbound one, and setting either to NULL cannot violate that.

-- A mailbox is reopened for at most a year; 0 means "never reopen — a reply to a
-- solved ticket is always a new one".
ALTER TABLE "PmSupportChannel"
  ADD CONSTRAINT "PmSupportChannel_reopen_window_range"
  CHECK ("reopenWindowDays" BETWEEN 0 AND 365);

-- An acknowledgement is a short note, not a document. The service validates the
-- same bound; this holds it for the next writer.
ALTER TABLE "PmSupportChannel"
  ADD CONSTRAINT "PmSupportChannel_template_length"
  CHECK (char_length("autoAckTemplate") <= 4000);

-- A channel may only hang off a SERVICE_DESK project. A CHECK cannot look at
-- another table, and the service is not the only writer a future importer or
-- fix-up script will bring (the same reason as pmticket_item_in_service_desk).
CREATE OR REPLACE FUNCTION pmsupportchannel_enforce_service_desk()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "PmProject" p WHERE p."id" = NEW."projectId" AND p."kind" = 'SERVICE_DESK'
  ) THEN
    RAISE EXCEPTION
      'PmSupportChannel % must belong to a SERVICE_DESK project (WARP-3529).',
      NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION pmsupportchannel_enforce_service_desk() IS
  'WARP-3529: BEFORE INSERT OR UPDATE OF (projectId) guard — a PmSupportChannel only ever hangs off a SERVICE_DESK project.';

DROP TRIGGER IF EXISTS pmsupportchannel_project_is_service_desk ON "PmSupportChannel";
CREATE TRIGGER pmsupportchannel_project_is_service_desk
  BEFORE INSERT OR UPDATE OF "projectId" ON "PmSupportChannel"
  FOR EACH ROW
  EXECUTE FUNCTION pmsupportchannel_enforce_service_desk();

-- The desk's ledger on a stored message. PENDING and DONE never carry a reason;
-- IGNORED and FAILED always do, and each from its own list — an ignored message
-- records WHICH rule ignored it, a failed one WHY it failed, and neither is ever
-- left without. `deskIntakeAt` is NULL exactly while the message is PENDING.
ALTER TABLE "EmailMessage"
  ADD CONSTRAINT "EmailMessage_desk_intake_state"
  CHECK (
    CASE "deskIntakeStatus"
      WHEN 'PENDING' THEN "deskIntakeReason" IS NULL AND "deskIntakeAt" IS NULL
      WHEN 'DONE'    THEN "deskIntakeReason" IS NULL AND "deskIntakeAt" IS NOT NULL
      WHEN 'IGNORED' THEN "deskIntakeAt" IS NOT NULL AND "deskIntakeReason" IN (
        'AUTO_SUBMITTED', 'PRECEDENCE_BULK', 'AUTO_REPLY_HEADER', 'BOUNCE',
        'OWN_ADDRESS', 'OWN_MESSAGE', 'RATE_LIMITED', 'DESK_ARCHIVED'
      )
      WHEN 'FAILED'  THEN "deskIntakeAt" IS NOT NULL AND "deskIntakeReason" IN (
        'PROCESSING_ERROR', 'CONTACT_OWNER_UNAVAILABLE'
      )
    END
  );

-- A comment that is an outgoing email is a PUBLIC one from staff or the system —
-- an internal note, or a customer's own message, never has a delivery state — and
-- a failure always says why (and only a failure does).
ALTER TABLE "PmComment"
  ADD CONSTRAINT "PmComment_delivery_state"
  CHECK (
    ("deliveryStatus" = 'FAILED') = ("deliveryFailure" IS NOT NULL)
    AND (
      "deliveryStatus" = 'NONE'
      OR ("visibility" = 'PUBLIC' AND "authorKind" IN ('USER', 'SYSTEM', 'AUTOMATION'))
    )
  );

-- An inbound row names the stored message it is and never a draft; an outbound
-- row names the draft it was sent as and never a stored message (a message the
-- box sent is not one it received).
ALTER TABLE "PmTicketEmailLink"
  ADD CONSTRAINT "PmTicketEmailLink_direction_matches_ref"
  CHECK (
    ("direction" = 'INBOUND' AND "emailDraftId" IS NULL)
    OR ("direction" = 'OUTBOUND' AND "emailMessageId" IS NULL)
  );

-- ── Seed: what a customer's email does in the states a desk was created with ─
-- 20261004120000 seeded the six states by name and group; this gives the three
-- that are not "leave it alone" their rule. Narrowed to SERVICE_DESK projects and
-- to the seeded group, and idempotent — a second run changes nothing. A desk
-- created from now on is seeded with the value (DESK_STATES), not by this.

UPDATE "PmState" s
SET "onCustomerReply" = CASE
    WHEN s."name" IN ('Pending', 'Solved') THEN 'REOPEN'::"PmCustomerReplyEffect"
    ELSE 'FOLLOW_UP'::"PmCustomerReplyEffect"
  END
FROM "PmProject" p
WHERE p."id" = s."projectId"
  AND p."kind" = 'SERVICE_DESK'
  AND (
    (s."name" = 'Pending' AND s."group" = 'started')
    OR (s."name" = 'Solved' AND s."group" = 'completed')
    OR (s."name" = 'Closed' AND s."group" = 'completed')
  );
