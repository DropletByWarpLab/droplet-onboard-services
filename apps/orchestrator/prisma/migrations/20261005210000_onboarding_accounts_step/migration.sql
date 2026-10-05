-- Additive membership change. Wizard ordering is enforced by SETUP_STEPS,
-- rather than PostgreSQL's enum declaration order.
ALTER TYPE "SetupStep" ADD VALUE IF NOT EXISTS 'accounts';
