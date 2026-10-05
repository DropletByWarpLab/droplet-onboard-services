-- WARP-3631 — remember each SCIM group's members so that dropping a person from
-- a push can lower the role the group had granted. Additive and re-runnable.

-- AlterTable
ALTER TABLE "ScimGroup" ADD COLUMN IF NOT EXISTS "memberUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
