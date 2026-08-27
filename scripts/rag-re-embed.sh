#!/usr/bin/env bash
# WARP-2196 — rebuild the RAG corpus with the currently-configured embedding
# model. See docs/RAG_RE_EMBED_RUNBOOK.md for the full procedure.
#
# WHY THIS IS A SCRIPT AND NOT A MIGRATION
# ----------------------------------------
# It deletes every vector on the box and the corpus rebuilds over minutes to
# hours of CPU-bound embedding work. That is a maintenance window, and an
# operator picks maintenance windows — not `prisma migrate deploy` at whatever
# moment the appliance happens to reboot.
#
# Skipping it does NOT silently corrupt anything: the file-indexer's startup
# guard (services/file-indexer/corpus_state.py) compares the model recorded
# for the corpus against EMBEDDING_MODEL and refuses to write new chunks when
# they disagree. A box that never runs this keeps serving its existing corpus
# and stops indexing, loudly. It does not mix two vector spaces.
#
# WHAT IT DOES
#   1. DELETE FROM "FileContentChunk"   — every vector; all were built by the
#      previous model and are not comparable to the new one's.
#   2. DELETE FROM "FileIndexStatus"    — the watcher's "already indexed,
#      unchanged" memory. Without this the reconcile sees `ready` rows with
#      unchanged mtimes and refuses to refill the corpus it just emptied.
#
# It does NOT restart the file-indexer and it does NOT replay brain uploads.
# Both are printed as explicit next steps; see the runbook for why the brain
# half cannot be automated from here.
#
# SAFE TO RE-RUN. Both statements are idempotent (a second run deletes zero
# rows). Re-running AFTER a completed rebuild wipes it again and costs another
# rebuild — it never leaves the corpus in a mixed or partial state, which is
# the property that matters.
set -euo pipefail

log()  { echo "[rag-re-embed] $*"; }
warn() { echo "[rag-re-embed] WARN: $*" >&2; }
die()  { echo "[rag-re-embed] ERROR: $*" >&2; exit 1; }

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_ROOT/docker/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-$SCRIPT_ROOT/.env}"
PROJECT="${COMPOSE_PROJECT_NAME:-droplet}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_USER="${POSTGRES_USER:-droplet}"
DB_NAME="${POSTGRES_DB:-droplet}"

assume_yes=0
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)   assume_yes=1; shift ;;
    -n|--dry-run) dry_run=1; shift ;;
    -h|--help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      echo
      echo "usage: $0 [-y|--yes] [-n|--dry-run]"
      exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# Test seam, same shape as REPO_ROOT_OVERRIDE in rotate-internal-certs.sh and
# MIGRATE_SCRIPT_TEST in migrate-and-start.sh: lets a harness substitute a
# stand-in for the docker CLI so the DESTRUCTIVE path can be exercised without
# a daemon. Never set in production.
DOCKER_BIN="${DOCKER_BIN:-docker}"

command -v "$DOCKER_BIN" >/dev/null 2>&1 || die "$DOCKER_BIN not found on PATH"
[ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE"

DC=("$DOCKER_BIN" compose -p "$PROJECT" -f "$COMPOSE_FILE")
# NOT `[ -f ... ] && DC+=(...)`: under `set -e` a false test makes that the
# script's failing last command and exits 1 on any box without a .env.
if [ -f "$ENV_FILE" ]; then
  DC+=(--env-file "$ENV_FILE")
fi

dc() { "${DC[@]}" "$@"; }

# Preflight probes get a hard time bound. An unreachable Docker daemon makes
# the client block on its socket indefinitely rather than erroring, so without
# this the operator's first experience of the script is a silent hang with no
# output and no way to tell it apart from slow work.
PROBE_TIMEOUT="${PROBE_TIMEOUT:-20}"
if command -v timeout >/dev/null 2>&1; then
  dc_probe() { timeout "$PROBE_TIMEOUT" "${DC[@]}" "$@"; }
else
  warn "coreutils 'timeout' not found — preflight probes are unbounded"
  dc_probe() { "${DC[@]}" "$@"; }
fi

psql_q() {
  # -tA: tuples only, unaligned — parseable. ON_ERROR_STOP so a failed
  # statement aborts instead of being reported as success.
  dc_probe exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -tAc "$1"
}

log "checking the stack is reachable (timeout ${PROBE_TIMEOUT}s)"
# Capture the status explicitly: `$?` read inside `if ! cmd; then` is the
# INVERTED status, so the 124 branch would never fire.
probe_rc=0
dc_probe ps >/dev/null 2>&1 || probe_rc=$?
if [ "$probe_rc" != 0 ]; then
  if [ "$probe_rc" = 124 ]; then
    die "timed out talking to Docker after ${PROBE_TIMEOUT}s — is the daemon running?"
  fi
  die "compose project '$PROJECT' is not reachable (is the stack up?)"
fi
psql_q 'SELECT 1' >/dev/null 2>&1 || die "cannot reach Postgres via the '$DB_SERVICE' service"

# The model the corpus will be rebuilt with. Unset in .env means the
# config.py default, which is the shipped model.
configured="$(grep -E '^EMBEDDING_MODEL=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' " || true)"
[ -n "$configured" ] || configured="(unset in .env — file-indexer will use its built-in default)"

# The summary reads run through plain `dc`, NOT `dc_probe`. `count(*)` on
# FileContentChunk is a sequential scan and a large corpus is exactly what this
# script targets, so borrowing the reachability probe's short timeout would
# abort the script on the boxes that most need it — and `set -e` kills a failed
# command substitution before any `die` can explain why.
psql_count() {
  dc exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -tAc "$1"
}

# Same discipline as the counts below: a FAILED marker lookup must not be
# reported as "never stamped". Those mean opposite things — one says the corpus
# predates the guard (so a re-embed is needed), the other says we do not know.
marker_rc=0
marker="$(psql_count "SELECT \"valueJson\" #>> '{}' FROM \"WorkspaceSetting\" WHERE \"key\" = 'ai.embedding.corpusModel'")" || marker_rc=$?
if [ "$marker_rc" != 0 ]; then
  marker="(LOOKUP FAILED — corpus provenance unknown)"
elif [ -z "$marker" ]; then
  marker="(never stamped — corpus predates the guard)"
fi

chunks="$(psql_count 'SELECT count(*) FROM "FileContentChunk"')"   || die "could not count FileContentChunk rows"
statuses="$(psql_count 'SELECT count(*) FROM "FileIndexStatus"')"   || die "could not count FileIndexStatus rows"

# NEVER let this one degrade to a number. The brain replay (runbook section 6)
# is the one step whose omission is silent AND unrecoverable: skip it and every
# chat attachment disappears from search while the file still shows in the UI,
# with no error and no badge. Runbook section 4 tells the operator to write this
# count down — a swallowed failure would have them write down a fabricated zero
# and then "confirm" the replay against it. A non-numeric sentinel makes the
# unknown impossible to mistake for "nothing to do".
BRAIN_COUNT_FAILED="(COUNT FAILED — see runbook section 6, do NOT assume zero)"
brain_ready="$(psql_count "SELECT count(*) FROM \"BrainMemoryItem\" WHERE status = 'ready'")"   || brain_ready="$BRAIN_COUNT_FAILED"
[ -n "$brain_ready" ] || brain_ready="$BRAIN_COUNT_FAILED"

cat <<EOF

  corpus currently embedded by : $marker
  EMBEDDING_MODEL in .env      : $configured

  FileContentChunk rows        : $chunks   (all will be DELETED)
  FileIndexStatus rows         : $statuses   (all will be DELETED)
  BrainMemoryItem 'ready' rows : $brain_ready   (need the manual replay, step 3 below)

EOF

if [ "$dry_run" = 1 ]; then
  log "dry run — nothing deleted"
  exit 0
fi

if [ "$assume_yes" != 1 ]; then
  warn "This deletes the entire search index. Rebuilding it is CPU-bound and"
  warn "can take hours on a large corpus. Search results will be incomplete"
  warn "until it finishes."
  printf '[rag-re-embed] Type REBUILD to continue: '
  # `read` returns non-zero at EOF, which under `set -e` would kill the script
  # before `die` could say why — a non-interactive invocation would then exit 1
  # with no output at all. It still aborts (correctly); we just want it to say
  # so. `|| reply=""` keeps the failure but hands it to the check below.
  reply=""
  read -r reply || reply=""
  [ "$reply" = "REBUILD" ] || die "aborted (expected REBUILD, got '$reply'). Use -y for unattended runs."
fi

# One transaction: never leave chunks deleted but statuses intact (the corpus
# would be empty and the reconcile would refuse to refill it), nor the inverse.
log "deleting corpus + index status (single transaction)"
dc exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DELETE FROM "FileContentChunk";
DELETE FROM "FileIndexStatus";
COMMIT;
SQL

log "done. Chunks now: $(psql_q 'SELECT count(*) FROM "FileContentChunk"')"

cat <<EOF

NEXT STEPS — the rebuild has NOT started yet.

  1. Recreate the file-indexer (NOT 'docker restart' — the service reads .env
     through env_file, and a plain restart keeps the old environment):

       docker compose -p $PROJECT -f docker/docker-compose.yml --env-file .env \\
         up -d --force-recreate --no-deps file-indexer

     On start it sees an empty corpus, stamps the configured model as the new
     corpus owner, and the reconcile re-indexes every watched file.

  2. Watch it drain:

       docker compose -p $PROJECT -f docker/docker-compose.yml logs -f file-indexer \\
         | grep -E 'reconcile|Indexed|corpus_state'

  3. >>> REPLAY THE BRAIN UPLOADS. Items to replay: $brain_ready <<<
     Step 1 does NOT cover them. Chunks with source='brain' come from
     BrainMemoryItem uploads, which are ingested from an MQTT event and have
     NO reconcile path whatsoever. If you stop after step 2, every chat
     attachment and uploaded memory is gone from search while the file still
     appears in the UI — and nothing will tell you.

     See docs/RAG_RE_EMBED_RUNBOOK.md section 6 for the replay loop.

EOF
