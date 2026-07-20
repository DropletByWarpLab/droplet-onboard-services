#!/bin/bash
# WARP-1407 — seed the WARP-224 eval fixture corpus on an appliance under a
# dedicated Nextcloud user, so rag-eval's RAGAS runs (WARP-1406) score
# against tests/retrieval-eval/ragas/goldens.yaml instead of a real user's
# corpus. Idempotent: safe to re-run after a factory reset or volume wipe.
#
# Run ON the appliance host (needs docker + the compose stack up):
#   ./scripts/seed-eval-fixtures.sh
# Then point the eval at the corpus and recreate rag-eval (env_file gotcha —
# recreate, NOT `docker restart`):
#   RAGAS_EVAL_USER=eval-fixtures in .env
#   docker compose -p droplet -f docker/docker-compose.yml --env-file .env \
#     up -d --force-recreate --no-deps rag-eval
#
# What it does (mirrors tests/retrieval-eval/run.integration.test.ts's
# beforeAll, adapted to the appliance's NC-sync pipeline):
#   1. Creates NC user $EVAL_USER via occ (random password, never printed —
#      the user never logs in anywhere; occ simply requires one).
#   2. Copies the four fixture files into the user's files/ tree under
#      test-rag-end-to-end/ (queries.yaml's q18 matches that folder name;
#      the PNG/EML take their brain-fixture names so path_contains matching
#      still lands).
#   3. `occ files:scan` so oc_filecache knows them — the file-indexer keys
#      synced rows off the NC file id (WARP-1394).
#   4. Polls FileContentChunk until the indexer + embedder have done their
#      work (restarts file-indexer once at the 2-min mark to force its
#      startup rescan if the watch path missed the copies).
#
# Audio/video fixtures (warp224-audio, frame-OCR, video-clip queries) are
# NOT seeded here — they need the transcribe-now pipeline (WARP-218); the
# eval tolerates the partial set, those queries just score low.
set -euo pipefail

EVAL_USER="${EVAL_USER:-eval-fixtures}"
FOLDER="test-rag-end-to-end"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$REPO_ROOT/services/file-indexer/tests/fixtures"

NC=$(docker ps --format '{{.Names}}' | grep -m1 nextcloud) || {
  echo "ERROR: no running nextcloud container" >&2; exit 1; }
DB=$(docker ps --format '{{.Names}}' | grep -m1 -- '-db-') || {
  echo "ERROR: no running db container" >&2; exit 1; }

echo "NC container: $NC | DB container: $DB | eval user: $EVAL_USER"

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
# src-name → dest-name pairs; PNG/EML keep their WARP-206/224 brain names.
for pair in \
  "sample.pdf:sample.pdf" \
  "simple.zip:simple.zip" \
  "sample.png:warp206-image.png" \
  "with-pdf-attachment.eml:warp224-email.eml"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  docker cp "$FIXTURES/$src" \
    "$NC:/var/www/html/data/$EVAL_USER/files/$FOLDER/$dst"
done
docker exec "$NC" chown -R www-data:www-data "/var/www/html/data/$EVAL_USER"
echo "FILES: copied 4 fixtures into $FOLDER/"

docker exec -u www-data "$NC" php occ files:scan "$EVAL_USER" | tail -3

kicked=0
chunks=0
for i in $(seq 1 36); do
  chunks=$(docker exec "$DB" sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
     "SELECT count(*) FROM \"FileContentChunk\" WHERE \"userId\" = '"'"''"$EVAL_USER"''"'"'"')
  echo "poll $i: chunks=$chunks"
  # A couple of extra polls after first chunks land lets stragglers finish.
  if [ "$chunks" -gt 0 ] && [ "$i" -gt 3 ]; then break; fi
  if [ "$i" -eq 12 ] && [ "$chunks" -eq 0 ] && [ "$kicked" -eq 0 ]; then
    echo "KICK: restarting file-indexer to force its startup rescan"
    docker restart \
      "$(docker ps --format '{{.Names}}' | grep -m1 file-indexer)" >/dev/null
    kicked=1
  fi
  sleep 10
done

echo "=== FileIndexStatus rows for $EVAL_USER ==="
docker exec "$DB" sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
   "SELECT path, status, coalesce(reason, '"'"''"'"') FROM \"FileIndexStatus\" WHERE \"userId\" = '"'"''"$EVAL_USER"''"'"'"'
if [ "$chunks" -eq 0 ]; then
  echo "ERROR: no chunks indexed for $EVAL_USER after 6 min — check file-indexer logs" >&2
  exit 1
fi
echo "OK: $chunks chunks indexed for $EVAL_USER"
