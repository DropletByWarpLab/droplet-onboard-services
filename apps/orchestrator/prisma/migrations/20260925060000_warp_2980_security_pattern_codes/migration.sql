-- WARP-2980 (ADR-059 P5 PR-B, brief §4.3) — append the three pattern codes to
-- SecurityReasonCode: out_of_place, unusual_volume, long_dwell.
--
-- In PR-B they are written to SecurityPatternFlag, SecuritySuppression.codes
-- and SecurityIncident.verdictCodes only (20260925060100). Every P5 code ships
-- `trial`, and SecurityIncidentReason_code_severity (20260925030000) is NOT
-- widened, so Postgres itself refuses a P5 code on a reason until P5 PR-D
-- makes one count.
--
-- Its OWN folder, stamped before 20260925060100, because PostgreSQL will not
-- let a transaction use an enum value that the same transaction added, and
-- Prisma runs each folder as one transaction (20260925030000's header). ADD
-- VALUE IF NOT EXISTS, so a re-run is a no-op. Nothing else goes in this
-- folder.

ALTER TYPE "SecurityReasonCode" ADD VALUE IF NOT EXISTS 'out_of_place';
ALTER TYPE "SecurityReasonCode" ADD VALUE IF NOT EXISTS 'unusual_volume';
ALTER TYPE "SecurityReasonCode" ADD VALUE IF NOT EXISTS 'long_dwell';
