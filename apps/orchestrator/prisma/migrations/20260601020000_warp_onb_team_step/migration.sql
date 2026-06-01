-- PR #381 (WARP onb team): onboarding TEAM step — the LAST onboarding step.
--
-- ONE additive change, ordered AFTER #380's 20260601010000 migration (which
-- added the 'org' SetupStep value + the Workspace org fields):
--   1. Extend the SetupStep enum with 'team' (the invite-people step that
--      slots near the END of the wizard: … → ai → team → done).
--
-- DECISION (team slots AFTER ai, BEFORE done in the wizard): the ENUM value is
-- appended at the END of the type here — Postgres orders enum members by their
-- physical declaration order and `ALTER TYPE … ADD VALUE` can only append
-- cheaply (inserting before an existing value requires a full type rewrite).
-- Nothing in the codebase reads the enum's declaration order; the WIZARD ORDER
-- (… → ai → team → done) lives in SETUP_STEPS (setup.service.ts) and the
-- dashboard STEPS array. So the enum is treated as an unordered membership set
-- and appending is correct — identical to how 'claim' (#373) and 'org' (#380)
-- were added.
--
-- ROLE MODEL: this PR uses the ALREADY-SHIPPED household Role enum
-- (owner / admin / family / guest / service) for invite roles — see the
-- onboarding-team-invite.service. No Role-enum migration is needed: the
-- household model is the live contract (UserInvite.role : Role, WARP-171), so
-- there is NOTHING to migrate here. The household-vs-business fork the scaffold
-- doc flagged is resolved in favor of household (ADR-002 home-first); see the
-- self-assessment + service docstring for the decision rationale.
--
-- IDEMPOTENCY (re-running this migration on a converged DB is a no-op, so the
-- enum-member count stays stable):
--   - The enum extension is guarded by a pg_enum catalog check inside a DO
--     block — `ALTER TYPE … ADD VALUE` has no `IF NOT EXISTS` that works inside
--     Prisma's migration transaction on every supported PG, and re-adding an
--     existing value errors, so we add it only when absent. Same guard #373 /
--     #380 used for 'claim' / 'org'.
-- This migration seeds NO rows (invites are created at runtime through
-- POST /api/people/invite, not by the schema), so there is no INSERT to make
-- idempotent.

-- ── 1 · Extend SetupStep with 'team' ──

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'SetupStep' AND e.enumlabel = 'team'
    ) THEN
        ALTER TYPE "SetupStep" ADD VALUE 'team';
    END IF;
END $$;
