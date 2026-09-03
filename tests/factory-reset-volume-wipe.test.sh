#!/usr/bin/env bash
# =============================================================================
# Regression guard — factory-reset.sh must REALLY wipe the DB volume, fatally.
#
# A reflash of the single-box silently left a stale Postgres DB and then
# stranded the box: factory-reset reported success while droplet_pgdata
# survived, so the new db container re-mounted the OLD PGDATA, kept the OLD role
# password, and crash-looped the orchestrator (migrate_boot "could not establish
# migration lock session") + file-indexer against the freshly-rotated
# POSTGRES_PASSWORD in .env.
#
# Two root causes, both guarded here:
#   1. The project name was guessed as `basename $(dirname compose.yml)` =
#      "docker", so the remove + verify loops targeted nonexistent "docker_*"
#      volumes and trivially "passed" while the real droplet_pgdata survived.
#      The fix DERIVES the live project from the compose `name:` (droplet).
#   2. The destructive `down -v` and the `docker volume rm` loop were all
#      wrapped in `|| true` / `2>/dev/null`, so a failure (volume still in use
#      during a brick-safe reflash) was swallowed as success. The fix VERIFIES
#      via `docker volume ls` that no `*_pgdata` survives and ABORTS if it does.
#
# It must also stay SAFE: the bare `docker` compose project belongs to the
# sibling droplet-local-LLM repo (Ollama) — sweeping docker_* would nuke the
# model cache. Only droplet_* (live) and droplet-pi-platform_* (retired
# pre-WARP-605 name) are ours to remove.
#
# This is a STATIC source-assertion test (same idiom as
# tests/factory-reset-purge-scope.test.sh): it greps the executable lines of
# factory-reset.sh. It does NOT run Docker or factory-reset.sh — the live
# reset->provision->login path is covered by tests/factory-reset.test.sh.
#
# Runtime: < 1 second.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESET="$REPO_ROOT/scripts/factory-reset.sh"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  factory-reset.sh volume-wipe robustness guard"
echo "  ================================================"
echo ""

# --- Preconditions -----------------------------------------------------------
if [ -f "$RESET" ]; then
  pass "factory-reset.sh exists"
else
  fail "factory-reset.sh missing at $RESET"
  echo "FAILURES=$FAILURES"; exit 1
fi

# Strip comments + blank lines so assertions see only executable shell. Several
# fixes mention the bug in comments (e.g. why we don't sweep docker_*), so a
# naive whole-file grep would be a false positive.
CODE="$(grep -vE '^[[:space:]]*#' "$RESET" | grep -vE '^[[:space:]]*$')"

# --- Root cause 1: correct project name, not the basename guess --------------
echo "--- Project name is derived, not guessed from the directory basename ---"

# The old bug: COMPOSE_PROJECT=$(basename "$(dirname "$COMPOSE_FILE")") = "docker".
if printf '%s\n' "$CODE" | grep -qE 'basename[[:space:]]+"?\$\(dirname[[:space:]]+"?\$COMPOSE_FILE'; then
  fail "project name is still derived via basename \$(dirname compose.yml) = 'docker' (the bug)"
else
  pass "no basename \$(dirname compose.yml) project derivation (the 'docker' bug is gone)"
fi

# The fix derives the live project from the compose file's `name:` field.
if printf '%s\n' "$CODE" | grep -qE "grep[[:space:]].*'?\^name:.*\"?\\\$COMPOSE_FILE"; then
  pass "project name is derived from the compose 'name:' field"
else
  fail "project name is not derived from the compose 'name:' field"
fi

# --- Root cause 2: an authoritative, fatal verify gate -----------------------
echo "--- Surviving volumes are verified via docker volume ls and fatal ---"

# The verify must enumerate live volumes with `docker volume ls`, not re-inspect
# a hardcoded (possibly wrong-prefixed) name list.
if printf '%s\n' "$CODE" | grep -qE 'docker[[:space:]]+volume[[:space:]]+ls'; then
  pass "post-removal verify enumerates live volumes (docker volume ls)"
else
  fail "no 'docker volume ls' verify — a surviving volume can't be detected"
fi

# A pgdata match in the verify regex — *_pgdata is the headline failure.
if printf '%s\n' "$CODE" | grep -qE 'pgdata'; then
  pass "verify accounts for the *_pgdata DB volume"
else
  fail "verify does not reference pgdata (the stale-DB volume this fix exists for)"
fi

# The non-force failure path must ABORT (exit 1), not warn-and-continue.
if printf '%s\n' "$CODE" | grep -qE 'could not be removed' \
   && printf '%s\n' "$CODE" | grep -qE '^[[:space:]]*exit[[:space:]]+1'; then
  pass "a surviving volume is FATAL (exit 1), not swallowed as success"
else
  fail "a surviving volume does not abort the reset (exit 1 path missing)"
fi

# The primary destructive `down` no longer swallows its stderr to /dev/null on
# the same line (the original `down ... --remove-orphans 2>/dev/null || true`).
if printf '%s\n' "$CODE" | grep -qE 'remove-orphans[[:space:]]+2>/dev/null'; then
  fail "the primary 'down --remove-orphans' still swallows stderr to /dev/null"
else
  pass "the primary 'down --remove-orphans' no longer swallows stderr inline"
fi

# --- Legacy cleanup + sibling safety -----------------------------------------
echo "--- Legacy droplet-pi-platform swept; sibling docker_* left alone ---"

# The retired pre-WARP-605 project's orphaned volumes are swept.
if printf '%s\n' "$CODE" | grep -qE 'droplet-pi-platform'; then
  pass "retired droplet-pi-platform project volumes are swept (pre-WARP-605 orphans)"
else
  fail "no droplet-pi-platform sweep — pre-rename orphaned volumes linger"
fi

# Safety: must NOT blanket-remove the sibling repo's `docker_*` volumes. A
# `^docker_` anchor in a volume-ls filter, or a `-p docker` teardown, would.
if printf '%s\n' "$CODE" | grep -qE "'\^docker_'|\"\^docker_\"|-p[[:space:]]+docker[[:space:]]"; then
  fail "executable code targets the sibling 'docker' project (would nuke Ollama's model cache)"
else
  pass "sibling 'docker' project (droplet-local-LLM/Ollama) is never swept"
fi

# --- Wipe-list completeness: customer-data volumes must be in the fallback ----
echo "--- Wipe list mirrors compose; customer-data volumes are not omitted ---"

# brain-memory-data (assistant memory: embeddings of personal files) + ops-audit
# (the audit trail) are customer/operator data device-backup.sh captures. Both
# were once missing from the explicit wipe list, so a swallowed `down -v` left
# them on the box after a "factory reset" — data remanence. Guard against it.
for v in brain-memory-data ops-audit; do
  if printf '%s\n' "$CODE" | grep -qE "\"$v\""; then
    pass "wipe list includes customer-data volume $v"
  else
    fail "wipe list OMITS customer-data volume $v (data remanence after reset)"
  fi
done

# `filedata` is a dead legacy name no compose volume creates — its presence was
# always a no-op soft-fail. Keep it out so the list stays honest.
if printf '%s\n' "$CODE" | grep -qE '"filedata"'; then
  fail "wipe list still contains the dead 'filedata' entry (no such compose volume)"
else
  pass "no dead 'filedata' entry in the wipe list"
fi

# --- WARP-2638: the data-root is /data/docker on the appliance ---------------
echo ""
echo "--- The Docker data-root is derived, and container logs are swept ---"

# scripts/host/droplet-luks-provision.sh:370 writes {"data-root": "/data/docker"},
# so on a provisioned box NOTHING lives under /var/lib/docker. The WARP-234
# stale-submount sweep hardcoded that path and therefore never matched a single
# mount on exactly the boxes it exists for. (The bare `/var/lib/docker` FALLBACK
# default below is fine and asserted separately; what must not come back is a
# hardcoded path INTO the store.)
#
# `tr -d '\\'` first: the original was an awk REGEX, where every slash is
# backslash-escaped (`\/var\/lib\/docker\/`). A plain -F grep for the path does
# not match that form, so re-introducing the exact old line slipped through —
# caught in mutation testing, which is the only reason this normalisation is here.
#
# And `$(... | grep -F ...)` captured into a variable rather than the `grep -qF`
# this file uses everywhere else: `-q` exits on the FIRST match, `tr` then dies
# of SIGPIPE (141), and `set -o pipefail` at the top of this file turns the
# whole pipeline non-zero — so the assertion reads "no match" precisely when
# there IS one. Only pipelines with an external command before the grep are
# affected, which is why the other assertions here are fine.
if [ -n "$(printf '%s\n' "$CODE" | tr -d '\\' | grep -F '/var/lib/docker/' || true)" ]; then
  fail "a path into /var/lib/docker is still hardcoded — the appliance data-root is /data/docker"
else
  pass "no hardcoded path into /var/lib/docker (the data-root is derived)"
fi

if printf '%s\n' "$CODE" | grep -qE 'DOCKER_DATA_ROOT=.*DockerRootDir'; then
  pass "the data-root is read from 'docker info --format {{.DockerRootDir}}'"
else
  fail "the data-root is not derived from the daemon"
fi

if printf '%s\n' "$CODE" | grep -qF 'DOCKER_DATA_ROOT:-/var/lib/docker'; then
  pass "the data-root falls back to /var/lib/docker when the daemon cannot answer"
else
  fail "no fallback data-root — the sweep would build a path starting with '/volumes/'"
fi

# A container's stdout lives at <data-root>/containers/<id>/<id>-json.log, and
# docker/docker-compose.yml's x-logging anchor RETAINS 3 x 10 MB of it per
# service. `down --remove-orphans` normally takes it with the container, but
# that `down` is `|| true` and nothing re-checked. Volumes get a verify gate;
# containers now do too.
if printf '%s\n' "$CODE" | grep -qF 'com.docker.compose.project='; then
  pass "leftover containers are swept by compose-project label"
else
  fail "nothing sweeps containers the compose teardown left behind (their retained stdout survives)"
fi

if printf '%s\n' "$CODE" | grep -qF '_remaining_owned_containers'; then
  pass "a verify gate re-enumerates surviving containers (same shape as the volume gate)"
else
  fail "there is no container verify gate — a swallowed 'down' is invisible again"
fi

# The scope guard that makes the sweep safe: the sibling droplet-local-LLM
# project is literally named `docker`, so the label filter must only ever be fed
# OWNED_PREFIXES — never a literal project name.
if printf '%s\n' "$CODE" | grep -F 'com.docker.compose.project=' | grep -qF '$prefix'; then
  pass "the container sweep is scoped to OWNED_PREFIXES (the sibling 'docker' project is safe)"
else
  fail "the container sweep is not scoped through OWNED_PREFIXES"
fi

# =============================================================================
# Results
# =============================================================================
echo ""
echo "  ================================================"
printf "  Results: %d/%d passed" "$((TESTS - FAILURES))" "$TESTS"
if [ "$FAILURES" -gt 0 ]; then
  printf " (\033[31m%d failed\033[0m)" "$FAILURES"
fi
printf "\n"
echo "  ================================================"
echo ""

exit "$FAILURES"
