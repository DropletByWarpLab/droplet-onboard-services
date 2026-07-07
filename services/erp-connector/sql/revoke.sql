-- =============================================================================
-- WARP-1094 — Eaglesoft teardown script (brief §8.1)
-- =============================================================================
--
-- Run by the office's SQL Anywhere DBA to fully remove Droplet's access to the
-- PattersonPM database (offboarding, or to re-provision from scratch). REVIEW
-- BEFORE RUNNING. Revokes every grant and drops both dedicated accounts. Safe
-- to run even if a capability was never enabled — dropping the user removes
-- any grants that were attached to it.
--
-- This affects ONLY the accounts Droplet created (droplet_ro / droplet_rw). It
-- never touches Eaglesoft's own accounts or the default credential (brief §4.3).

-- Revoke read grants, then drop the read-only account.
REVOKE SELECT ON dba.patient     FROM droplet_ro;
REVOKE SELECT ON dba.appointment FROM droplet_ro;
REVOKE SELECT ON dba.provider    FROM droplet_ro;
REVOKE SELECT ON dba.service     FROM droplet_ro;
REVOKE SELECT ON dba.serv_trans  FROM droplet_ro;
REVOKE SELECT ON dba.recall      FROM droplet_ro;
REVOKE SELECT ON dba.account     FROM droplet_ro;
DROP USER droplet_ro;

-- Drop the write account. Any per-capability UPDATE grants (e.g. the
-- reschedule_appointment column grant) are removed with the user.
DROP USER droplet_rw;
