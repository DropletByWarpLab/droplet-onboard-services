-- WARP-2838 (ADR-051 §9) — the owner-facing on switch for the company brain.
--
-- `/brief` shipped in the sidebar of every box with an empty state reading
-- "Turn the brain on to start reading your business", and nothing in the
-- product could. `BRAIN_ENABLED` was read in exactly one place, written
-- nowhere, and present in no deployment file. This table is the mechanism the
-- call-to-action was missing; ADR-051 §9 is the policy it enforces.

CREATE TABLE "BrainSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledById" TEXT,
    "enabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrainSetting_pkey" PRIMARY KEY ("id")
);

-- One row, enforced. Mirrors `AutoFilingSetting_singleton`: the resolver reads
-- `WHERE id = 'singleton'`, so a second row would be consent nobody could see
-- and nothing would read.
ALTER TABLE "BrainSetting"
  ADD CONSTRAINT "BrainSetting_singleton"
  CHECK ("id" = 'singleton');

-- 🔴 Consent is never half-recorded.
--
-- A BICONDITIONAL, not an optional annotation. An enabled row must name who
-- turned it on and when; a disabled row must carry NEITHER. Writing the off
-- state while leaving the actor pair populated is `false = true` — a 23514
-- that rolls the statement back and leaves a row still saying the brain is on.
-- `AutoFilingSetting_enabled_has_actor` already paid for that lesson; the
-- route here clears both columns in the same statement that clears `enabled`.
ALTER TABLE "BrainSetting"
  ADD CONSTRAINT "BrainSetting_enabled_has_actor"
  CHECK (
    "enabled" = ("enabledById" IS NOT NULL AND "enabledAt" IS NOT NULL)
  );

-- No backfill. An absent row means nobody has consented, which is exactly what
-- every existing box means today: `BRAIN_ENABLED` defaults off and appears in
-- no deployment file, so no box has ever run the brain. Seeding a row here
-- would be a consent record written by a migration.
