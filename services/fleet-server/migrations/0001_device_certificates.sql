-- ADR-023 C1 — fleet HQ device registry + per-device certificate state.
--
-- Applied IDEMPOTENTLY at startup (db.run_migrations). There is no
-- alembic/SQLAlchemy in this codebase — raw numbered .sql files, every
-- statement guarded with IF NOT EXISTS so re-runs are no-ops.
--
-- This file lives on HQ only. It carries NO secrets and NO seed device
-- rows — devices are seeded out-of-band at provisioning with their TPM
-- key fingerprint.

-- A migration ledger so re-runs skip already-applied files.
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Device registry. A device is pre-registered with its TPM public key +
-- fingerprint, seeded out-of-band at provisioning (ADR-023 §Decision 7).
CREATE TABLE IF NOT EXISTS devices (
    device_id        TEXT PRIMARY KEY,
    public_key_pem   TEXT NOT NULL,
    key_fingerprint  TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-device certificate state. status is an EXPLICIT enum via CHECK —
-- never derived from IS NULL (droplet-architecture-guard rule).
CREATE TABLE IF NOT EXISTS device_certificates (
    device_id        TEXT PRIMARY KEY
                       REFERENCES devices(device_id) ON DELETE CASCADE,
    public_label     TEXT NOT NULL UNIQUE,
    fqdn             TEXT NOT NULL UNIQUE,
    status           TEXT NOT NULL
                       CHECK (status IN ('pending','active','renewing','revoked','failed')),
    order_id         TEXT,
    fullchain_pem    TEXT,
    cert_serial      TEXT,
    not_before       TIMESTAMPTZ,
    not_after        TIMESTAMPTZ,
    last_renewed_at  TIMESTAMPTZ,
    csr_fingerprint  TEXT,
    last_error       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Renewal job scans active rows by expiry; index the predicate columns.
CREATE INDEX IF NOT EXISTS idx_device_certificates_status_not_after
    ON device_certificates (status, not_after);

-- Single-use, short-lived issuance nonces (challenge -> order binding).
-- consumed_at NULL == unconsumed; this is a lifecycle timestamp on a
-- transient row, NOT application state derived from IS NULL.
CREATE TABLE IF NOT EXISTS challenges (
    nonce        TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rate-limiting + expiry sweep want device_id / expires_at lookups.
CREATE INDEX IF NOT EXISTS idx_challenges_device_created
    ON challenges (device_id, created_at);
CREATE INDEX IF NOT EXISTS idx_challenges_expires_at
    ON challenges (expires_at);
