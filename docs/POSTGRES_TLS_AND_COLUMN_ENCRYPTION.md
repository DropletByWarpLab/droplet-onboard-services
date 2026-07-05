# Postgres TLS 1.3 + SCRAM + PHI/PII column encryption (WARP-233)

Operator + reviewer guide for the WARP-233 hardening of the `db` service and
the first at-rest PHI/PII column. Verification evidence:
`scripts/host/droplet-verify-encryption.sh` checks `transit.pg.*` (WARP-966).

## 1. Transport: TLS 1.3 + SCRAM-SHA-256, hostssl-only

- The compose `db` service (pgvector/pgvector:pg16) launches with
  `ssl=on`, `ssl_min_protocol_version=TLSv1.3`,
  `password_encryption=scram-sha-256` and a custom
  `hba_file` (`docker/postgres/pg_hba.conf`) — enforced via server flags in
  `docker/docker-compose.yml`, the stock image config untouched.
- `pg_hba.conf` has **no plaintext `host` auth lines**: TCP is
  `hostssl … scram-sha-256` only, with a terminal `host all all all reject`.
  Unix-socket `local` lines stay `trust` for the container healthcheck and
  initdb scripts (reaching the socket already requires `docker exec`).
- The server certificate is the **WARP-236 internal-CA `db` bundle**
  (`data/secrets/service-tls/db/{cert.pem,key.pem}`, issued by
  `scripts/lib/internal-ca.sh`; `db` is in `INTERNAL_CA_SERVICES`). One trust
  root, one rotation path: `scripts/rotate-internal-certs.sh --service db`.
- Every first-party `DATABASE_URL` producer pins `?sslmode=require`
  (`.env` heredoc, `migrate_env` upgrade for existing installs, compose
  inline URLs). Nextcloud needs no param — libpq `sslmode=prefer`
  auto-upgrades to TLS.
- Regression guards: `scripts/test-security.sh` Test 17 (static) and
  `scripts/test/postgres-tls.test.sh` (dockerized: plaintext rejected, TLS 1.3
  negotiated, SCRAM verifier present, FIPS-variant boot).

## 2. FIPS-mode interaction (P1011, decision A)

Under `DROPLET_FIPS_MODE=1` the FIPS openssl config breaks Prisma/libpq's TLS
handshake entirely (`P1011: library has no ciphers`). `setup.sh --fips`
therefore flips the **intra-compose hop only** to plaintext+SCRAM, all derived
from the one knob by `apply_fips_mode`:

| Key | default (`--no-fips`) | FIPS (`--fips`) |
|---|---|---|
| `PG_SSLMODE` | `require` | `disable` |
| `PG_HBA` | `pg_hba.conf` | `pg_hba.fips.conf` |
| `DATABASE_URL` `sslmode` param | `require` | `disable` |

`pg_hba.fips.conf` still SCRAM-authenticates every TCP connection and keeps
the terminal reject; plaintext is tolerated only from RFC1918 bridge ranges +
container loopback (`db` publishes no host ports). The verification harness
records `transit.pg.plaintext-rejected` as SKIP with the P1011-exception
reason on a FIPS box instead of FAIL.

## 3. At rest: User.email (PII) — dcv1 blob + blind index

- **Wire format** `dcv1:` = base64(iv(12) ‖ ciphertext ‖ tag(16)),
  AES-256-GCM — deliberately tag-LAST (Python `cryptography` AESGCM layout)
  and distinct from `encryption.service.ts`'s iv‖tag‖ct so the two formats
  can never be confused. Cross-language twins:
  `apps/orchestrator/src/services/column-crypto.service.ts`,
  `services/mcp-server/src/column-crypto.service.ts`,
  `services/file-indexer/column_crypto.py` — locked by a golden-vector
  interop test.
- **Keys**: HKDF-SHA256 of `DEVICE_SECRET_KEY`
  (salt `droplet-column-crypto-v1`): `user-email-column` (email at rest),
  `email-blind-index` (HMAC key), `doc-kek` (wraps per-document DEKs).
  TPM-sealing the root is WARP-1033.
- **Lookups**: equality + uniqueness moved to `User.emailLookupHash`
  (HMAC-SHA256 over trim+lowercase(email), `@unique`); `email` lost its
  `@unique` because GCM ciphertext is non-deterministic. All four equality
  sites (`/auth/login`, SSO linking, SCIM ×2) go through
  `findUserByEmail` (`user-directory.service.ts`).
- **pg_tde was rejected** (deviation D1): not installable on
  `pgvector/pgvector:pg16`, and cluster-level TDE cannot express
  per-document keys or crypto-shred. App-layer AES-256-GCM instead.

### Backfill (run once per box after upgrade)

Pre-existing rows hold plaintext email + NULL blind index. Readers accept
both forms (explicit `dcv1:` marker) and `findUserByEmail` falls back to a
plaintext probe, so nothing breaks before the backfill — but blind-index
uniqueness only covers backfilled + new rows until it runs:

```bash
docker compose -p droplet -f docker/docker-compose.yml exec orchestrator \
  npx tsx scripts/encrypt-existing-phi-columns.ts        # --dry to preview
```

Idempotent (dcv1 rows are skipped). Duplicate emails that normalize to the
same address are reported and left untouched for manual resolution.

## 4. Per-document DEKs + chunk sensitivity (plumbing for WARP-242)

`DocumentEncryptionKey` (keyId `brain:<brainItemId>`, wrapped under the
doc-KEK, AAD = keyId; **crypto-shred = delete the row**) and
`FileContentChunk.sensitivity` (`standard`/`sensitive`, default `standard` —
today's behavior unchanged) ship here as the custody + schema layer.
`document-key.service.ts` (`getOrCreateDek`/`getDek`/`getDeksByIds`/
`shredDocumentKey`) and the Python/TS crypto twins are the integration
surface for the WARP-242 per-document crypto-shred workstream, which owns
tagging chunks sensitive and the encrypt-at-ingest / decrypt-at-search paths.
