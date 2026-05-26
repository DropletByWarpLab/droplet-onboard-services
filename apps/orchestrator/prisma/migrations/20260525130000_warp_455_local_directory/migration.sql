-- WARP-455: A1 local user directory.
--
-- Adds the User + Group + GroupMembership tables. Additive on top of the
-- Nextcloud-OCS auth fallback in middleware/auth.ts — does NOT replace
-- OCS-validated sessions. Today every row in User is local (isLocal=true);
-- future Nextcloud-mirroring will populate rows with isLocal=false and
-- the delete handler refuses to mutate the OCS-owned identity.
--
-- `role` references the WARP-171 `Role` enum (created in
-- 20260525000000_warp_171_role_enum/migration.sql). No new role enum is
-- introduced — that was the contract from ADR-004 §1.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so re-running the migration
-- on a converged DB is a no-op. Same posture as the WARP-446 ApDevice
-- migration.

-- ── User ──

CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "role" "Role" NOT NULL DEFAULT 'family',
    "isLocal" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
CREATE INDEX IF NOT EXISTS "User_role_idx" ON "User"("role");

-- ── Group ──

CREATE TABLE IF NOT EXISTS "Group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Group_name_key" ON "Group"("name");

-- ── GroupMembership (explicit join table) ──

CREATE TABLE IF NOT EXISTS "GroupMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GroupMembership_userId_groupId_key"
    ON "GroupMembership"("userId", "groupId");
CREATE INDEX IF NOT EXISTS "GroupMembership_userId_idx"
    ON "GroupMembership"("userId");
CREATE INDEX IF NOT EXISTS "GroupMembership_groupId_idx"
    ON "GroupMembership"("groupId");

-- ── Foreign keys ──
-- Wrapped in DO blocks so re-running the migration on a converged DB
-- doesn't fail with "constraint already exists".

DO $$ BEGIN
    ALTER TABLE "GroupMembership"
        ADD CONSTRAINT "GroupMembership_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "GroupMembership"
        ADD CONSTRAINT "GroupMembership_groupId_fkey"
        FOREIGN KEY ("groupId") REFERENCES "Group"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
