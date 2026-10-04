# Postgres: one least-privilege role per service (WARP-3590)

Status: design only, nothing implemented. Decision needed (see "Open decisions").

Today every database client connects as the single superuser-equivalent role
`droplet`. This note describes how to give Nextcloud and each indexer its own
role, rolled out and rolled back one service at a time. It must be rehearsed on
a box (or a restored copy of one) before any step ships: roles and grants are
data-plane changes that compose cannot validate.

## Current state

| Client | How it gets credentials | Database | Reference |
|---|---|---|---|
| orchestrator | `DATABASE_URL` from `../.env` (`env_file`) | `droplet` | `docker/docker-compose.yml`, service `orchestrator`, `env_file`; value written at `scripts/lib/secrets.sh` `generate_env` |
| mcp-server | `DATABASE_URL=${DATABASE_URL}` | `droplet` | `docker/docker-compose.yml`, service `mcp-server`, `environment` |
| file-indexer | inline `postgresql://droplet:${POSTGRES_PASSWORD}@db:5432/droplet?sslmode=${PG_SSLMODE:-require}` | `droplet` | `docker/docker-compose.yml`, service `file-indexer`, `environment` |
| email-indexer | `DATABASE_URL=${DATABASE_URL:-postgresql://droplet:droplet@db:...}` | `droplet` | `docker/docker-compose.yml`, service `email-indexer`, `environment` |
| rag-eval | `DATABASE_URL` from `../.env` (extraction canary only) | `droplet` | `docker/docker-compose.yml`, service `rag-eval`, `env_file`; read at `services/rag-eval/main.py` (extraction canary) |
| nextcloud | `POSTGRES_USER`/`POSTGRES_PASSWORD` from `../.env` (image entrypoint auto-install) | `nextcloud` | `docker/docker-compose.yml`, service `nextcloud`, `env_file` |
| db (server) | `POSTGRES_USER=droplet`, `POSTGRES_DB=droplet`, password from `../.env` | both | `docker/docker-compose.yml`, service `db`, `environment` |

Facts that constrain the design:

- The `droplet` role is the bootstrap superuser created by the image's initdb
  (`POSTGRES_USER`). The `nextcloud` database is created `OWNER droplet` by
  `docker/init-nextcloud-db.sh` (first volume creation only; existing boxes
  rely on `scripts/lib/compose.sh` to create it).
- `pg_hba.conf` is TLS-only and SCRAM for every TCP client (`docker/postgres/pg_hba.conf`);
  the FIPS variant adds plaintext SCRAM from private ranges
  (`docker/postgres/pg_hba.fips.conf:28-31`). Both match `all all`, so a new
  role needs no hba change. A per-role or per-database hba line is an optional
  extra (step 6).
- The orchestrator owns the schema. `apps/orchestrator/scripts/migrate-and-start.sh`
  runs `prisma migrate deploy`, takes `pg_dump` snapshots, and uses a session
  advisory lock; migrations use `CREATE EXTENSION` (`vector`, `pg_trgm`, see
  `apps/orchestrator/prisma/migrations/20260926120000_warp_3193_activity_feed_indexes/migration.sql:18`).
  This role must stay the owner of the `droplet` schema objects.
- Healthchecks and `docker exec ... psql -U droplet` rely on the unix-socket
  `trust` line (`docker/postgres/pg_hba.conf`). Those remain superuser and are
  out of scope here.
- Table access observed by grep (indicative, not proven complete; step 0 replaces it
  with measurement):
  - file-indexer: `BrainMemoryItem`, `FileContentChunk`, `FileIndexStatus`,
    `DocumentEncryptionKey`, `WorkspaceSetting`, `Department` (`services/file-indexer/*.py`).
  - email-indexer: `EmailAccount`, `EmailMessage`, `EmailAttachment`, `EmailDraft`
    (`services/email-indexer/*.py`).
  - rag-eval extraction canary: `Contact`, `CrmActivity`, `CrmCompany`, `EntityLink`,
    `FileIndexStatus`, `IngestProposal` (`tests/extraction-eval/extraction_runner.py`).
  - mcp-server: chunk and document-key reads (`services/mcp-server/src/file-search.service.ts`,
    `document-key.service.ts`, `chunk-owner.ts`).
- Precedent for narrow roles already exists for an external system: `droplet_ro`
  and `droplet_rw` for the ERP bridge (`services/erp-connector/sql/provision.sql`).
  Same pattern: a role per consumer, grants listed in one tracked SQL file.

## Target state

Roles (names are proposals):

| Role | Database | Privileges |
|---|---|---|
| `droplet` | `droplet` | unchanged: schema owner, migrations, orchestrator |
| `droplet_nextcloud` | `nextcloud` | owner of the `nextcloud` database; no access to `droplet` (`REVOKE CONNECT ON DATABASE droplet FROM PUBLIC`, grant only to listed roles) |
| `droplet_indexer` | `droplet` | `SELECT/INSERT/UPDATE/DELETE` on the file-indexer table list above; `SELECT` on `Department`, `WorkspaceSetting`; sequences `USAGE`; no DDL, not `CREATEROLE`/`CREATEDB`, not superuser |
| `droplet_email` | `droplet` | DML on the four email tables only |
| `droplet_mcp` | `droplet` | `SELECT` on chunk and key-lookup tables only |
| `droplet_evalcanary` | `droplet` | `SELECT` on the canary table list; `INSERT` only where the canary writes |

The orchestrator keeps `droplet` (it runs migrations). The long-term question
of splitting migration owner from runtime role is a separate follow-up, not part of this note.

Grants are held in one tracked SQL file (for example `docker/postgres/roles.sql`)
applied idempotently by a single script, so a table added by a later Prisma migration
is covered by `ALTER DEFAULT PRIVILEGES` for the owning role plus an explicit
list test (step 0 output becomes the test fixture).

Passwords: one generated secret per role, written by `scripts/lib/secrets.sh`
using the existing `_migrate_ensure_key` helper, and delivered to its single consumer
only. This depends on the per-service environment work in WARP-3588; a role
password that lands in the shared `.env` file still reaches every container that
loads it, so each role step below should land after (or together with) its
consumer's move off `env_file`.

## Migration (one role at a time)

Every step: apply, verify on a box, then enable the consumer. Rollback for
every step is "point the consumer back at `droplet`'s URL and recreate it"; the
new role may stay in the database unused. No step drops data or changes
ownership of existing objects until step 5.

### Step 0. Measure (no behaviour change)

- On a box with representative data, set `log_statement = 'all'` temporarily
  (or use `pg_stat_statements`) for 24 h covering a reindex, an email sync, an
  eval run and a Nextcloud file operation. Extract tables and statement
  kinds per client application name.
- Test on box: the extracted table list per client equals the lists above, or the
  difference is recorded and added to the grants file.
- Breaks: nothing. Roll back: reset the logging setting.

### Step 1. email-indexer (smallest surface, profile-gated by credentials)

- Create `droplet_email` and its grants; set its password via `_migrate_ensure_key`.
  Change only email-indexer's `DATABASE_URL` (`docker/docker-compose.yml`, service `email-indexer`, `environment`).
- Test on box: `docker compose up -d --force-recreate email-indexer`; healthcheck
  passes; trigger a mailbox sync and confirm new `EmailMessage` rows; confirm
  `psql "postgresql://droplet_email:...@db/droplet?sslmode=require" -c 'select 1 from "User" limit 1'`
  fails with `permission denied`.
- Breaks if a table is missing from grants: sync loop logs `permission denied for table X`
  and mail ingest stalls (fail-closed, data safe). Roll back: restore the old URL, recreate.

### Step 2. file-indexer

- Same shape with `droplet_indexer` (`docker/docker-compose.yml`, service `file-indexer`, `environment`). The inline URL
  must keep its `sslmode=${PG_SSLMODE:-require}` parameter (FIPS boxes use `disable`).
- Test on box: `POST /reindex/<id>` through the orchestrator succeeds; the watcher indexes a newly
  uploaded file (row in `FileIndexStatus`, chunks in `FileContentChunk`); embedding
  column writes work (pgvector); per-document key mint works (`DocumentEncryptionKey`);
  FIPS box: repeat with `PG_SSLMODE=disable`.
- Breaks: chunk writes fail, files stay unindexed, search recall drops; the corpus
  state gate (`services/file-indexer/corpus_state.py`) may also block writes, which
  reads as a different symptom, so check logs for `permission denied` first.
  Roll back as above.

### Step 3. mcp-server and rag-eval

- `droplet_mcp` for mcp-server (`docker/docker-compose.yml`, service `mcp-server`, `environment`); `droplet_evalcanary`
  for rag-eval. rag-eval gets its own URL only after it has an explicit
  `environment:` list (WARP-3588), otherwise the shared file still overrides it.
- Test on box: a chat turn that calls the file search tool returns chunks; run
  `python main.py run-once --suite extraction` in the rag-eval container and
  confirm a verdict file is written.
- Breaks: tool returns empty or errors; extraction canary reports "cannot run".
  Roll back: restore URL, recreate.

### Step 4. Nextcloud

- Highest risk, last. The Nextcloud image reads `POSTGRES_USER` only for first-time
  auto-install; afterwards the connection settings live in
  `/var/www/html/config/config.php` (`dbuser`, `dbpassword`) on the `nextcloud-data` volume.
  Changing compose alone changes nothing on an installed box.
- Procedure: create `droplet_nextcloud`, `ALTER DATABASE nextcloud OWNER TO droplet_nextcloud`
  and reassign object ownership (`REASSIGN OWNED BY droplet IN DATABASE nextcloud ...`
  must be run connected to `nextcloud`, not `droplet`); update `dbuser`/`dbpassword` with
  `occ config:system:set`, keeping the secret off the command line (config import file,
  as already done in `docker/nextcloud-init.sh`); then drop `POSTGRES_USER`/`POSTGRES_PASSWORD`
  from the Nextcloud environment.
- Test on box: before the change take a `pg_dump -Fc nextcloud`; after, `occ status`
  reports installed, `occ files:scan --all` completes, a web upload and download works,
  Collabora open of a document works, `restic` backup job still dumps the database
  (it connects as superuser over the socket, unaffected).
- Breaks: Nextcloud shows maintenance mode or "can't connect to database" for every
  Workspace member, file sync and the orchestrator's files API stop. Roll back: restore the
  old `dbuser`/`dbpassword` with `occ` or by restoring `config.php`; ownership stays valid
  because `droplet` is a superuser.

### Step 5. Revoke broad access (only after steps 1-4 have soaked one release)

- `REVOKE CONNECT ON DATABASE nextcloud FROM PUBLIC` and from non-owner roles; same for
  `droplet`. Remove `droplet`'s password use by every container except the orchestrator.
- Test on box: all five consumers healthy after `docker compose up -d --force-recreate`;
  `psql` as each role to the other database is refused.
- Breaks: anything still using `droplet` for the other database (a forgotten script).
  Roll back: `GRANT CONNECT` again.

### Step 6. Optional: tighten `pg_hba`

- Replace `all all` TCP lines with `hostssl droplet droplet_indexer ...` per role/database.
  Leave the FIPS variant for last; its plaintext rules (`pg_hba.fips.conf:28-31`) and
  `sslmode=verify-full` belong to WARP-3625 and WARP-2565.

## New boxes versus existing boxes

- New boxes: `docker/init-nextcloud-db.sh` (runs only at first volume creation) can create
  the roles. Existing boxes never re-run it, so roles must also be created by an idempotent
  script run from `migrate_env` / the OTA host helper; do not rely on the init script alone.
- OTA-only boxes receive only `docker/`; a new role password must be added to the OTA
  `ENSURE_KEYS` list in `docker/ota/env-reconcile.sh` or the box starts with an empty password.

## Open decisions for Romain

1. Is it acceptable that the orchestrator keeps the owner role for now, or should the migration
   owner and runtime role be split in the same effort (larger, needs Prisma `directUrl`)?
2. Ship Nextcloud's role (step 4) at all, or defer it behind the Nextcloud environment allowlist
   work, given the on-volume `config.php` change?
3. One shared `droplet_indexer` role for file-indexer and rag-eval's canary, or separate roles (proposed)?

## Related

WARP-3590 (this), WARP-3588 (per-service environment, prerequisite for each step to pay off),
WARP-3625 (Postgres certificate verification, hba cleanup), WARP-2565 (internal TLS default),
WARP-3656 (container hardening baseline), WARP-1375 and WARP-3454 (network exposure context).
