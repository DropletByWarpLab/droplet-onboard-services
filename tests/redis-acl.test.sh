#!/usr/bin/env bash
# WARP-234 — unit test for _generate_redis_acl (scripts/lib/secrets.sh).
#
# The per-service Redis ACL file is materialized at setup time from the
# .env passwords, mirroring the mosquitto passwd pattern. Invariants:
#   1. data/secrets/redis/users.acl exists, 0644, and contains ONLY sha256
#      password hashes (never a plaintext password byte).
#   2. default user is PING-only (the WARP-966 harness identity) — no data
#      command grants, no plaintext AUTH bypass.
#   3. per-service users exist with their least-privilege shapes:
#      orchestrator (~* with scripting, no @dangerous), ai-gateway (scoped to
#      session:*/sessions:index/ratelimit:*), mcp-server (rerank:* get/setex
#      only), nextcloud (~* with +keys carve-out for cache clear()).
#   4. idempotent: same inputs → byte-identical file; a password change
#      regenerates the matching hash.
#   5. WARP-3605: no two ACL users may share a password hash (the generator
#      refuses), generate_env writes a REDIS_HOST_PASSWORD distinct from
#      REDIS_PASSWORD, and migrate_env rotates a box that still shares them
#      while leaving a distinct value alone.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

export REPO_ROOT="$WORK"
LOG_FILE="$WORK/setup.log"; export LOG_FILE
# shellcheck disable=SC1091
source "$REPO_ROOT_REAL/scripts/lib/logging.sh"
# shellcheck disable=SC1091
source "$REPO_ROOT_REAL/scripts/lib/secrets.sh"

ACL="$WORK/data/secrets/redis/users.acl"
_sha() { printf '%s' "$1" | openssl dgst -sha256 -hex 2>/dev/null | sed 's/^.*= //'; }

export REDIS_PASSWORD="default-pw-1"
export REDIS_HOST_PASSWORD="nextcloud-pw-1"
export REDIS_PASSWORD_ORCHESTRATOR="orch-pw-1"
export REDIS_PASSWORD_AI_GATEWAY="aigw-pw-1"
export REDIS_PASSWORD_MCP="mcp-pw-1"

# 1. Generation + permissions + hashed-only content
_generate_redis_acl || fail "_generate_redis_acl exited non-zero"
[ -s "$ACL" ] || fail "users.acl missing"
# GNU first, BSD fallback — see tests/internal-ca.test.sh for why the inverse
# order silently never matches on Linux (WARP-2647).
mode="$(stat -c %a "$ACL" 2>/dev/null || stat -f %Lp "$ACL" 2>/dev/null)"
[ "$mode" = "644" ] || fail "users.acl mode $mode != 644 (redis uid 999 must read it; contents are hashes)"
for pw in "$REDIS_PASSWORD" "$REDIS_HOST_PASSWORD" "$REDIS_PASSWORD_ORCHESTRATOR" \
          "$REDIS_PASSWORD_AI_GATEWAY" "$REDIS_PASSWORD_MCP"; do
  grep -qF "$pw" "$ACL" && fail "plaintext password leaked into users.acl"
done
grep -q "#$(_sha "$REDIS_PASSWORD_ORCHESTRATOR")" "$ACL" || fail "orchestrator sha256 hash missing"

# 2. default = harness ping identity only
def_line="$(grep '^user default ' "$ACL")" || fail "no default user line"
echo "$def_line" | grep -q -- "-@all" || fail "default not -@all"
echo "$def_line" | grep -q "+ping" || fail "default lost +ping (harness probe identity)"
echo "$def_line" | grep -qE "\+@(read|write|all)" && fail "default has data-command grants"

# 3. per-service shapes
orch="$(grep '^user orchestrator ' "$ACL")" || fail "no orchestrator user"
echo "$orch" | grep -q -- "~\*" || fail "orchestrator key pattern"
echo "$orch" | grep -q -- "+@scripting" || fail "orchestrator needs +@scripting (session eval)"
echo "$orch" | grep -q -- "-@dangerous" || fail "orchestrator must strip @dangerous"
echo "$orch" | grep -q -- "+info" || fail "orchestrator needs +info (ioredis ready check)"

aigw="$(grep '^user ai-gateway ' "$ACL")" || fail "no ai-gateway user"
echo "$aigw" | grep -q -- "~session:\*" || fail "ai-gateway session:* pattern"
echo "$aigw" | grep -q -- "~sessions:index" || fail "ai-gateway sessions:index pattern"
echo "$aigw" | grep -q -- "~ratelimit:\*" || fail "ai-gateway ratelimit:* pattern"
echo "$aigw" | grep -q -- "~\* " && fail "ai-gateway must NOT be keyspace-wide"
echo "$aigw" | grep -q -- "+@scripting" || fail "ai-gateway needs +@scripting (rate-limit Lua)"

mcp="$(grep '^user mcp-server ' "$ACL")" || fail "no mcp-server user"
echo "$mcp" | grep -q -- "~rerank:\*" || fail "mcp-server rerank:* pattern"
echo "$mcp" | grep -q -- "+get" || fail "mcp-server +get"
echo "$mcp" | grep -q -- "+setex" || fail "mcp-server +setex"
echo "$mcp" | grep -qE "\+@(write|all)" && fail "mcp-server must not hold broad write"

nc="$(grep '^user nextcloud ' "$ACL")" || fail "no nextcloud user"
echo "$nc" | grep -q -- "+keys" || fail "nextcloud needs +keys (phpredis cache clear)"
echo "$nc" | grep -q -- "-@dangerous" || fail "nextcloud must strip @dangerous"

# every user disables pub/sub channels it doesn't use
[ "$(grep -c "resetchannels" "$ACL")" -ge 5 ] || fail "resetchannels missing on some user"

# 4. idempotency + rotation
before="$(cksum < "$ACL")"
_generate_redis_acl || fail "second run failed"
[ "$(cksum < "$ACL")" = "$before" ] || fail "regenerated with identical inputs (not idempotent)"
REDIS_PASSWORD_MCP="mcp-pw-2" _generate_redis_acl || fail "rotation run failed"
grep -q "#$(_sha "mcp-pw-2")" "$ACL" || fail "rotated mcp hash not applied"
grep -q "#$(_sha "mcp-pw-1")" "$ACL" && fail "stale mcp hash left behind"

# 5a. WARP-3605: two users sharing a password => the generator refuses and
# leaves the previous file untouched (a shared hash lets either password AUTH
# as either user).
before="$(cksum < "$ACL")"
REDIS_HOST_PASSWORD="$REDIS_PASSWORD" _generate_redis_acl >/dev/null 2>&1 \
  && fail "nextcloud sharing the default password was accepted"
[ "$(cksum < "$ACL")" = "$before" ] || fail "users.acl changed despite a shared-hash refusal"
REDIS_PASSWORD_MCP="$REDIS_PASSWORD_ORCHESTRATOR" _generate_redis_acl >/dev/null 2>&1 \
  && fail "two per-service users sharing a password were accepted"
REDIS_HOST_PASSWORD="" _generate_redis_acl >/dev/null 2>&1 \
  || fail "a missing REDIS_HOST_PASSWORD must skip (warn), not fail or fall back to the default password"
[ "$(cksum < "$ACL")" = "$before" ] || fail "users.acl changed when REDIS_HOST_PASSWORD was empty"

# 5b. generate_env: distinct nextcloud password. 5c. migrate_env: rotate a shared one.
GEN="$WORK/gen"; mkdir -p "$GEN/.data"
cp "$REPO_ROOT_REAL/.env.example" "$GEN/.env.example"
ENVF="$GEN/.env"
envval() { grep -E "^$1=" "$ENVF" | tail -1 | cut -d= -f2-; }
(
  REPO_ROOT="$GEN"; LOG_FILE="$GEN/.data/setup.log"
  generate_env >/dev/null 2>&1
) || true
[ -f "$ENVF" ] || fail "generate_env did not write .env"
rp="$(envval REDIS_PASSWORD)"; rhp="$(envval REDIS_HOST_PASSWORD)"
[ -n "$rp" ] && [ -n "$rhp" ] || fail "generate_env wrote no REDIS_PASSWORD/REDIS_HOST_PASSWORD"
[ "$rp" != "$rhp" ] || fail "generate_env wrote REDIS_HOST_PASSWORD equal to REDIS_PASSWORD"
case "$rhp" in *[!A-Za-z0-9]*) fail "REDIS_HOST_PASSWORD must be alphanumeric (PHP session.save_path)";; esac

# Old box: REDIS_HOST_PASSWORD == REDIS_PASSWORD.
{ grep -vE '^REDIS_HOST_PASSWORD=' "$ENVF"; printf 'REDIS_HOST_PASSWORD=%s\n' "$rp"; } > "$ENVF.t" && mv "$ENVF.t" "$ENVF"
(
  REPO_ROOT="$GEN"; LOG_FILE="$GEN/.data/setup.log"
  migrate_env >/dev/null 2>&1
)
[ "$(envval REDIS_PASSWORD)" = "$rp" ] || fail "migrate_env changed REDIS_PASSWORD"
new="$(envval REDIS_HOST_PASSWORD)"
[ -n "$new" ] && [ "$new" != "$rp" ] || fail "migrate_env did not rotate a shared REDIS_HOST_PASSWORD"
[ "$(grep -cE '^REDIS_HOST_PASSWORD=' "$ENVF")" = "1" ] || fail "REDIS_HOST_PASSWORD present on more than one line"
case "$new" in *[!A-Za-z0-9]*) fail "rotated REDIS_HOST_PASSWORD must be alphanumeric";; esac
cp "$ENVF" "$WORK/env.after"
(
  REPO_ROOT="$GEN"; LOG_FILE="$GEN/.data/setup.log"
  migrate_env >/dev/null 2>&1
)
cmp -s "$ENVF" "$WORK/env.after" || fail "second migrate_env changed a distinct REDIS_HOST_PASSWORD (not idempotent)"
# The migrated .env yields a valid ACL (no shared hash).
(
  set -a; . "$ENVF"; set +a
  REPO_ROOT="$GEN"; LOG_FILE="$GEN/.data/setup.log"
  _generate_redis_acl >/dev/null 2>&1
) || fail "ACL generation failed from a migrated .env"

echo "PASS tests/redis-acl.test.sh"
