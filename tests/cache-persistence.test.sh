#!/usr/bin/env bash
# shellcheck disable=SC2034  # RESET/BACKUP/TOPVOLS/mm/ml are read inside check()'s eval
# WARP-1401 — the `cache` Redis must persist across recreate/reboot, and the
# persisted file must be wiped by factory reset and never backed up.
#
# Static, Docker-free (runs on setup-tests.yml). The live half (a session key
# and its TTL survive `docker rm -f` + a fresh container on the same volume)
# is scripts/test/redis-tls.test.sh, which reads its flags from this same
# compose block so the two cannot drift.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$REPO_ROOT/docker/docker-compose.yml"
RESET="$REPO_ROOT/scripts/factory-reset.sh"
BACKUP="$REPO_ROOT/scripts/host/device-backup.sh"
FAILURES=0
pass() { printf "  PASS  %s\n" "$1"; }
fail() { FAILURES=$((FAILURES + 1)); printf "  FAIL  %s\n" "$1"; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

# The `cache:` service block, comments stripped.
CACHE="$(awk '/^  cache:/{f=1;print;next} f&&/^  [a-z0-9-]+:/{exit} f' "$COMPOSE" | grep -vE '^[[:space:]]*#')"
TOPVOLS="$(awk '/^volumes:/{f=1;next} f&&/^[a-z]/{exit} f&&/^  [a-z0-9-]+:/{sub(/:.*/,"");sub(/^  /,"");print}' "$COMPOSE")"
arr() { awk -v n="$2" '$0 ~ "^"n"=\\(" {f=1;next} f&&/^\)/{exit} f' "$1" | sed 's/#.*//'; }

check "cache: AOF on"                         'grep -q -- "--appendonly yes" <<<"$CACHE"'
check "cache: fsync everysec"                  'grep -q -- "--appendfsync everysec" <<<"$CACHE"'
check "cache: default RDB snapshots off"       'grep -q -- "--save \"\"" <<<"$CACHE"'
check "cache: noeviction (sessions never evicted before caches)" \
                                               'grep -q -- "--maxmemory-policy noeviction" <<<"$CACHE"'
check "cache: data on the named cache-data volume at /data" \
                                               'grep -qE -- "- cache-data:/data$" <<<"$CACHE"'
check "cache-data declared as a top-level volume" 'grep -qx cache-data <<<"$TOPVOLS"'

# maxmemory must leave AOF-rewrite headroom under the container limit, or a
# persisted dataset OOM-kills → replays → OOM-kills.
mm="$(grep -oE -- '--maxmemory \$\{CACHE_MAXMEMORY:-[0-9]+mb\}' <<<"$CACHE" | grep -oE '[0-9]+')"
ml="$(grep -oE 'CACHE_MEM_LIMIT:-[0-9]+m' <<<"$CACHE" | grep -oE '[0-9]+')"
check "maxmemory (${mm:-?}mb) is <= 80% of mem_limit (${ml:-?}m)" \
  '[ -n "$mm" ] && [ -n "$ml" ] && [ $((mm * 100)) -le $((ml * 80)) ]'

check "factory reset wipes cache-data (no sessions/tokens on a reset box)" \
  'arr "$RESET" VOLUMES | grep -q "\"cache-data\""'
check "device-backup excludes cache-data (a restore must not resurrect sessions)" \
  'arr "$BACKUP" EXCLUDED_VOLUMES | grep -qw cache-data'
check "device-backup does not capture cache-data" \
  '! arr "$BACKUP" DATA_VOLUMES | grep -qw cache-data'

# Nothing may undo persistence on boot: no FLUSHALL/FLUSHDB in shipped code.
flush="$(grep -rniE --include='*.ts' --include='*.py' --include='*.sh' --include='*.php' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=test --exclude-dir=tests \
  --exclude='*.test.*' -E '\bflush(all|db)\b' \
  "$REPO_ROOT/apps" "$REPO_ROOT/services" "$REPO_ROOT/scripts" "$REPO_ROOT/docker" 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(#|//|\*)' | grep -v '/scripts/test/' || true)"
check "no FLUSHALL/FLUSHDB in shipped code" '[ -z "$flush" ]'
[ -n "$flush" ] && printf '%s\n' "$flush"

echo
[ "$FAILURES" -eq 0 ] && { echo "cache-persistence: all passed"; exit 0; }
echo "cache-persistence: $FAILURES failed"; exit 1
