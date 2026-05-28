-- WARP-465 — Phase D1. Email backbone schema.
--
-- EmailAccount, EmailThread, EmailMessage, EmailDraft + three closed
-- enums (EmailImapStatus, EmailTriageStatus, EmailDraftStatus).
--
-- Idempotent: enums in DO/EXCEPTION blocks, tables + indexes with
-- IF NOT EXISTS, FK constraints in DO/EXCEPTION blocks. Same posture
-- as the WARP-456/457/460/461/467/468/470/473/474/475/462 migrations.

-- ── Enums ──

DO $$ BEGIN
    CREATE TYPE "EmailImapStatus" AS ENUM ('idle', 'reconnecting', 'error', 'paused');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "EmailTriageStatus" AS ENUM ('inbox', 'triaged', 'archived');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "EmailDraftStatus" AS ENUM ('draft', 'queued', 'sent', 'failed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Tables ──

CREATE TABLE IF NOT EXISTS "EmailAccount" (
    "id"            TEXT              NOT NULL,
    "userId"        TEXT,
    "displayName"   TEXT              NOT NULL,
    "address"       TEXT              NOT NULL,
    "imapHost"      TEXT              NOT NULL,
    "imapPort"      INTEGER           NOT NULL DEFAULT 993,
    "imapTls"       BOOLEAN           NOT NULL DEFAULT true,
    "smtpHost"      TEXT              NOT NULL,
    "smtpPort"      INTEGER           NOT NULL DEFAULT 465,
    "smtpTls"       BOOLEAN           NOT NULL DEFAULT true,
    "username"      TEXT              NOT NULL,
    "passwordEnc"   TEXT              NOT NULL,
    "imapStatus"    "EmailImapStatus" NOT NULL DEFAULT 'paused',
    "lastIdleAt"    TIMESTAMP(3),
    "lastErrorAt"   TIMESTAMP(3),
    "lastError"     TEXT,
    "createdAt"     TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)      NOT NULL,

    CONSTRAINT "EmailAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EmailAccount_address_key"
    ON "EmailAccount"("address");

CREATE INDEX IF NOT EXISTS "EmailAccount_userId_address_idx"
    ON "EmailAccount"("userId", "address");

CREATE TABLE IF NOT EXISTS "EmailThread" (
    "id"               TEXT                NOT NULL,
    "accountId"        TEXT                NOT NULL,
    "threadKey"        TEXT                NOT NULL,
    "subject"          TEXT                NOT NULL,
    "lastSender"       TEXT,
    "snippet"          TEXT,
    "messageCount"     INTEGER             NOT NULL DEFAULT 0,
    "triageStatus"     "EmailTriageStatus" NOT NULL DEFAULT 'inbox',
    "draftedByDroplet" BOOLEAN             NOT NULL DEFAULT false,
    "lastMessageAt"    TIMESTAMP(3)        NOT NULL,
    "createdAt"        TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3)        NOT NULL,

    CONSTRAINT "EmailThread_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EmailThread_accountId_threadKey_key"
    ON "EmailThread"("accountId", "threadKey");

CREATE INDEX IF NOT EXISTS "EmailThread_accountId_triageStatus_lastMessageAt_idx"
    ON "EmailThread"("accountId", "triageStatus", "lastMessageAt" DESC);

CREATE INDEX IF NOT EXISTS "EmailThread_accountId_lastMessageAt_idx"
    ON "EmailThread"("accountId", "lastMessageAt" DESC);

CREATE TABLE IF NOT EXISTS "EmailMessage" (
    "id"         TEXT         NOT NULL,
    "accountId"  TEXT         NOT NULL,
    "threadId"   TEXT         NOT NULL,
    "messageId"  TEXT         NOT NULL,
    "inReplyTo"  TEXT,
    "fromAddr"   TEXT         NOT NULL,
    "fromName"   TEXT,
    "toAddrs"    JSONB        NOT NULL,
    "ccAddrs"    JSONB,
    "subject"    TEXT         NOT NULL,
    "bodyText"   TEXT,
    "bodyHtml"   TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EmailMessage_accountId_messageId_key"
    ON "EmailMessage"("accountId", "messageId");

CREATE INDEX IF NOT EXISTS "EmailMessage_threadId_receivedAt_idx"
    ON "EmailMessage"("threadId", "receivedAt" DESC);

CREATE TABLE IF NOT EXISTS "EmailDraft" (
    "id"               TEXT               NOT NULL,
    "accountId"        TEXT               NOT NULL,
    "threadId"         TEXT,
    "toAddrs"          JSONB              NOT NULL,
    "ccAddrs"          JSONB,
    "bccAddrs"         JSONB,
    "subject"          TEXT               NOT NULL,
    "body"             TEXT               NOT NULL DEFAULT '',
    "draftedByDroplet" BOOLEAN            NOT NULL DEFAULT false,
    "status"           "EmailDraftStatus" NOT NULL DEFAULT 'draft',
    "sentAt"           TIMESTAMP(3),
    "error"            TEXT,
    "createdAt"        TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3)       NOT NULL,

    CONSTRAINT "EmailDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EmailDraft_accountId_status_updatedAt_idx"
    ON "EmailDraft"("accountId", "status", "updatedAt" DESC);

-- ── Foreign keys ──

DO $$ BEGIN
    ALTER TABLE "EmailThread"
        ADD CONSTRAINT "EmailThread_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "EmailMessage"
        ADD CONSTRAINT "EmailMessage_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "EmailMessage"
        ADD CONSTRAINT "EmailMessage_threadId_fkey"
        FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "EmailDraft"
        ADD CONSTRAINT "EmailDraft_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
