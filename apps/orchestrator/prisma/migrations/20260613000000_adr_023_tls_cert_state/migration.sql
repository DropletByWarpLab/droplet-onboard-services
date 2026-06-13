-- ADR-023 (C2): per-device TLS cert lifecycle state.
--
-- Adds the explicit `TlsCertState` enum + a `TlsCert` model keyed by the
-- opaque per-device FQDN. The tls-issuance cron reads `state` to decide
-- issue-vs-renew-vs-noop — it NEVER infers the state from a null/expired cert
-- file (handbook rule 10; canonical precedent BrainMemoryItemStatus,
-- PoolStatus, ClaimCodeState).
--
-- SEEDS NOTHING that depends on a per-device secret: a fresh box gets its
-- BOOTSTRAP_SELF_SIGNED row written by the orchestrator the first time the
-- tls-issuance cron runs with a known FQDN. The migration is greenfield.
--
-- Re-runnable: the enum CREATE is guarded by DO/EXCEPTION (duplicate_object)
-- and the table/index use IF NOT EXISTS, so re-running on a populated db is a
-- no-op and must not change row counts.

BEGIN;

-- ── Enum (guarded so a re-run is idempotent) ──

DO $$ BEGIN
    CREATE TYPE "TlsCertState" AS ENUM (
        'BOOTSTRAP_SELF_SIGNED',
        'LE_ISSUED',
        'LE_RENEWING',
        'LE_RENEW_FAILED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Table ──

CREATE TABLE IF NOT EXISTS "TlsCert" (
    "fqdn"      TEXT NOT NULL,
    "state"     "TlsCertState" NOT NULL DEFAULT 'BOOTSTRAP_SELF_SIGNED',
    "notAfter"  TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TlsCert_pkey" PRIMARY KEY ("fqdn")
);

COMMIT;
