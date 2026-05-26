-- WARP-171: introduce the canonical `Role` enum and migrate the only
-- persistent role column (`UserInvite.role`) onto it.
--
-- Per ADR-004 (docs/ADR-004-rbac-per-route-guards.md) §1, the schema must
-- mirror the TS `Role` union in src/services/jwt.service.ts one-to-one:
--   owner | admin | family | guest | service
--
-- Pre-WARP-171 the `UserInvite.role` column was `text NOT NULL DEFAULT 'user'`
-- with a `// "admin" | "user"` comment — a free-form string the CLAUDE.md
-- no-guessing rule already forbids. Existing rows carry either 'admin' or
-- 'user' (and conceivably stale junk if anyone hand-edited). The backfill:
--
--   'admin' → admin     (preserves the admin-invitee path)
--   'user'  → family    (matches roleFromGroups() default in jwt.service.ts)
--   else    → guest     (least-privileged catch-all for any junk in the wild)
--
-- Re-runnable: enum creation is wrapped in DO/EXCEPTION (mirrors the
-- WARP-218 BrainMemoryItemStatus migration's pattern). The column-type
-- change uses `USING` to do the cast + backfill in a single statement;
-- running again on a converged DB is a no-op because the column is
-- already the enum type and the USING-with-CASE pattern just re-maps each
-- enum value to itself.

-- ── Enum ──

DO $$ BEGIN
    CREATE TYPE "Role" AS ENUM (
        'owner',
        'admin',
        'family',
        'guest',
        'service'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Backfill ──
-- Convert the existing TEXT column to the new enum, mapping legacy values.
-- The USING expression runs once per row at type-change time; idempotent
-- on re-run because rows are already typed as Role (and the CASE handles
-- every enum value identically to itself).

ALTER TABLE "UserInvite"
    ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "UserInvite"
    ALTER COLUMN "role" TYPE "Role"
    USING (
        CASE
            WHEN "role"::text = 'admin'   THEN 'admin'::"Role"
            WHEN "role"::text = 'user'    THEN 'family'::"Role"
            WHEN "role"::text = 'owner'   THEN 'owner'::"Role"
            WHEN "role"::text = 'family'  THEN 'family'::"Role"
            WHEN "role"::text = 'guest'   THEN 'guest'::"Role"
            WHEN "role"::text = 'service' THEN 'service'::"Role"
            ELSE 'guest'::"Role"
        END
    );

ALTER TABLE "UserInvite"
    ALTER COLUMN "role" SET DEFAULT 'family'::"Role";
