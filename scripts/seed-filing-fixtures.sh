#!/bin/bash
# WARP-2732 (ADR-048) — seed the extraction-canary corpus on an appliance.
#
# Sibling of seed-eval-fixtures.sh, and deliberately a SEPARATE script rather
# than a flag on that one: this corpus contains PHI decoys. Three of the twelve
# fixtures are written to look exactly like patient records, because the whole
# point is to check that the pipeline refuses them — and a corpus like that
# must never be seeded by accident onto a box somebody is using for anything
# else. A separate script with its own user is the difference between "you ran
# the canary" and "three files that look like patient records appeared in your
# Nextcloud".
#
# Run ON the appliance host (needs docker + the compose stack up):
#   ./scripts/seed-filing-fixtures.sh
#
# Then run the canary:
#   docker exec droplet-rag-eval-1 python main.py run-once --suite extraction
#
# 🔴 The fixtures land under a folder the FOLDER ALLOW-LIST must include, or
# filing will correctly refuse the whole corpus as `out_of_scope` and the
# canary will report a zero-proposal breaker. That is the gate working; it is
# also the most likely reason a first run "fails" for no interesting reason, so
# the script says which folder it used at the end.
set -euo pipefail

EVAL_USER="${FILING_EVAL_USER:-eval-fixtures}"
FOLDER="${FILING_EVAL_FOLDER:-extraction-eval}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$REPO_ROOT/tests/extraction-eval/fixtures"

if [ ! -d "$FIXTURES" ]; then
  echo "ERROR: no fixtures at $FIXTURES" >&2
  exit 1
fi

NC=$(docker ps --format '{{.Names}}' | grep -m1 nextcloud) || {
  echo "ERROR: no running nextcloud container" >&2; exit 1; }
DB=$(docker ps --format '{{.Names}}' | grep -m1 -- '-db-') || {
  echo "ERROR: no running db container" >&2; exit 1; }

echo "NC container: $NC | DB container: $DB"
echo "user: $EVAL_USER | folder: $FOLDER"

if docker exec -u www-data "$NC" php occ user:list --output=json \
    | grep -q "\"$EVAL_USER\""; then
  echo "USER: $EVAL_USER already exists"
else
  OC_PASS=$(openssl rand -base64 24)
  docker exec -u www-data -e OC_PASS="$OC_PASS" "$NC" \
    php occ user:add --password-from-env --display-name "Eval Fixtures" \
    "$EVAL_USER" >/dev/null
  echo "USER: $EVAL_USER created"
fi

docker exec -u www-data "$NC" \
  mkdir -p "/var/www/html/data/$EVAL_USER/files/$FOLDER"

# The filenames carry the fixture id, because that is how extraction_runner.py
# joins a proposal back to its golden — `WHERE path LIKE '%<prefix>%<id>%'`.
# Renaming a fixture here without renaming its golden silently drops it from
# the scored corpus.
n=0
for src in "$FIXTURES"/*; do
  base=$(basename "$src")
  docker cp "$src" "$NC:/var/www/html/data/$EVAL_USER/files/$FOLDER/$base"
  n=$((n + 1))
done
docker exec "$NC" chown -R www-data:www-data "/var/www/html/data/$EVAL_USER"
echo "FILES: copied $n fixtures into $FOLDER/"

docker exec -u www-data "$NC" php occ files:scan "$EVAL_USER" | tail -3

# ── Wait for the INDEXER ────────────────────────────────────────────────────
kicked=0
chunks=0
for i in $(seq 1 36); do
  chunks=$(docker exec "$DB" sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
     "SELECT count(*) FROM \"FileContentChunk\" WHERE \"userId\" = '"'"''"$EVAL_USER"''"'"'"')
  echo "index poll $i: chunks=$chunks"
  if [ "$chunks" -gt 0 ] && [ "$i" -gt 3 ]; then break; fi
  if [ "$i" -eq 12 ] && [ "$chunks" -eq 0 ] && [ "$kicked" -eq 0 ]; then
    echo "KICK: restarting file-indexer to force its startup rescan"
    docker restart \
      "$(docker ps --format '{{.Names}}' | grep -m1 file-indexer)" >/dev/null
    kicked=1
  fi
  sleep 10
done

if [ "$chunks" -eq 0 ]; then
  echo "ERROR: no chunks indexed after 6 min." >&2
  echo "  Check ai.embedding.corpusModel first: a box upgraded without" >&2
  echo "  scripts/rag-re-embed.sh lands every new file failed AT THE INDEXER," >&2
  echo "  before filing ever sees it (WARP-2196)." >&2
  exit 1
fi
echo "OK: $chunks chunks indexed"

# ── Wait for FILING ─────────────────────────────────────────────────────────
#
# A second poll, on a different column, because the two stages fail
# differently: no chunks means the indexer or the corpus model; chunks but no
# extractStatus means the filing worker is off, paused, or pointed at a cloud
# model. Reporting "seeded" after only the first would hand the canary a corpus
# nothing has read.
done_rows=0
for i in $(seq 1 30); do
  done_rows=$(docker exec "$DB" sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
     "SELECT count(*) FROM \"FileIndexStatus\" WHERE \"userId\" = '"'"''"$EVAL_USER"''"'"' AND \"extractStatus\" NOT IN ('"'"'pending'"'"','"'"'running'"'"')"')
  echo "filing poll $i: finished=$done_rows / $n"
  if [ "$done_rows" -ge "$n" ]; then break; fi
  sleep 20
done

echo
echo "=== extract status for $EVAL_USER ==="
docker exec "$DB" sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
   "SELECT split_part(path, '"'"'/'"'"', -1) AS file, \"extractStatus\", coalesce(\"extractReason\"::text, '"'"''"'"') AS reason FROM \"FileIndexStatus\" WHERE \"userId\" = '"'"''"$EVAL_USER"''"'"' ORDER BY 1"'

echo
if [ "$done_rows" -lt "$n" ]; then
  echo "WARNING: only $done_rows of $n fixtures finished." >&2
  echo "  Filing may be off, paused by the canary, or pointed at a cloud model." >&2
  echo "  Check GET /api/crm/filing/summary — the health block says which." >&2
  exit 1
fi

echo "OK: all $n fixtures processed."
echo
echo "🔴 If everything reads out_of_scope, the folder allow-list does not"
echo "   include /$FOLDER. That is filing working correctly; widen the list"
echo "   (or clear it) before reading anything into the canary's verdict."
echo
echo "Now run:  docker exec \$(docker ps --format '{{.Names}}' | grep -m1 rag-eval) \\"
echo "            python main.py run-once --suite extraction"
