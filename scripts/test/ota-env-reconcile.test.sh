#!/usr/bin/env bash
# =============================================================================
# WARP-2995 — docker/ota/env-reconcile.sh (the OTA host-side .env reconcile)
# =============================================================================
# Pins the contract an OTA apply relies on before any container swap:
#   * a box missing keys / a profile token gets them;
#   * existing values (even empty ones) are never touched;
#   * a second run changes nothing and writes no second backup;
#   * writes go THROUGH a .env symlink (WARP-232 /data relocation);
#   * the boot unit's --profile flags follow the merged COMPOSE_PROFILES;
#   * the JSON report names keys, never values;
#   * DRIFT: every key migrate_env backfills is either reconciled here or
#     named as setup-only (a new migrate_env key fails this suite).
# Pure POSIX sh under test, run with /bin/sh (dash on the box). No Docker.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RECONCILE="$REPO_ROOT/docker/ota/env-reconcile.sh"
SECRETS_SH="$REPO_ROOT/scripts/lib/secrets.sh"

FAILURES=0
TESTS=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# A stable-399-era box: an old .env missing the newer keys and the `email`
# profile, with one key deliberately set to an empty value, and the unit
# render_systemd_unit wrote for its old profile set.
make_box() {
  local box="$1"
  mkdir -p "$box/docker"
  cat > "$box/.env" <<'EOF'
POSTGRES_PASSWORD=keep-me
SERVICE_TOKEN_VOICE=existing-voice-token
TUNNEL_TOKEN=
COMPOSE_PROFILES=linux,display,eval
EOF
  chmod 600 "$box/.env"
  cat > "$box/droplet.service" <<EOF
[Service]
EnvironmentFile=$box/.env
ExecStartPre=/usr/bin/docker compose --env-file $box/.env -f $box/docker/docker-compose.yml config -q
ExecStart=/usr/bin/docker compose --env-file $box/.env -f $box/docker/docker-compose.yml --profile linux --profile display --profile eval up -d --remove-orphans
ExecStop=/usr/bin/docker compose --env-file $box/.env -f $box/docker/docker-compose.yml down
ExecReload=/usr/bin/docker compose --env-file $box/.env -f $box/docker/docker-compose.yml --profile linux --profile display --profile eval up -d --remove-orphans --force-recreate
EOF
}

reconcile() { DROPLET_OTA_UNIT_FILE="$1/droplet.service" /bin/sh "$RECONCILE" "$1" "$2"; }

echo "env-reconcile: first run on an old box"
BOX="$TMP/box"
make_box "$BOX"
OUT="$(reconcile "$BOX" upd1 2>"$TMP/err")"; RC=$?
[ "$RC" -eq 0 ] && pass "exits 0" || fail "exit $RC ($(cat "$TMP/err"))"

grep -q '^SANDBOX_SERVICE_TOKEN=[0-9a-f]\{64\}$' "$BOX/.env" \
  && pass "missing token key added (64 hex)" || fail "SANDBOX_SERVICE_TOKEN not added"
grep -q '^JWT_SECRET=[0-9a-f]\{128\}$' "$BOX/.env" \
  && pass "hex64 key added (128 hex)" || fail "JWT_SECRET not added as hex64"
grep -q '^NVR_MEDIA_SOURCE=nvrdata$' "$BOX/.env" \
  && pass "missing literal-default key added" || fail "NVR_MEDIA_SOURCE literal missing"
grep -q '^COMPOSE_PROFILES=linux,display,eval,email$' "$BOX/.env" \
  && pass "missing profile token appended to COMPOSE_PROFILES" || fail "email token not appended ($(grep COMPOSE_PROFILES "$BOX/.env"))"
[ "$(grep -c '^COMPOSE_PROFILES=' "$BOX/.env")" -eq 1 ] \
  && pass "COMPOSE_PROFILES rewritten in place, not duplicated" || fail "COMPOSE_PROFILES duplicated"

grep -q '^POSTGRES_PASSWORD=keep-me$' "$BOX/.env" \
  && grep -q '^SERVICE_TOKEN_VOICE=existing-voice-token$' "$BOX/.env" \
  && pass "existing values untouched" || fail "an existing value was rewritten"
grep -q '^TUNNEL_TOKEN=$' "$BOX/.env" && [ "$(grep -c '^TUNNEL_TOKEN=' "$BOX/.env")" -eq 1 ] \
  && pass "an existing EMPTY value is kept, not filled" || fail "empty TUNNEL_TOKEN was touched"
grep -q '^ROUTING_MODE=\|^OPENWRT_PASSWORD=\|^REDIS_PASSWORD_\|^DROPLET_DEVICE_ID=' "$BOX/.env" \
  && fail "a setup-only key was added" || pass "setup-only keys are left to setup.sh"

[ -f "$BOX/.env.bak.ota-upd1" ] && grep -q '^COMPOSE_PROFILES=linux,display,eval$' "$BOX/.env.bak.ota-upd1" \
  && pass "pre-reconcile backup written beside .env" || fail "no backup of the pre-reconcile .env"
[ "$(stat -c %a "$BOX/.env" 2>/dev/null || stat -f %Lp "$BOX/.env")" = "600" ] \
  && pass ".env stays 0600" || fail ".env mode changed"
ls "$BOX"/.env.ota-reconcile.* >/dev/null 2>&1 && fail "stage file left behind" || pass "no stage file left behind"

grep -q -- "-f $BOX/docker/docker-compose.yml --profile linux --profile display --profile eval --profile email up -d --remove-orphans$" "$BOX/droplet.service" \
  && grep -q -- "--profile email up -d --remove-orphans --force-recreate$" "$BOX/droplet.service" \
  && pass "boot unit ExecStart/ExecReload re-rendered with the new profile" \
  || fail "unit flags not re-rendered ($(grep ExecStart= "$BOX/droplet.service"))"
grep -q "^ExecStop=/usr/bin/docker compose --env-file $BOX/.env -f $BOX/docker/docker-compose.yml down$" "$BOX/droplet.service" \
  && pass "non-up unit lines untouched" || fail "ExecStop changed"

echo "$OUT" | grep -q '"addedProfiles":\["email"\]' \
  && echo "$OUT" | grep -q '"unitUpdated":true' \
  && echo "$OUT" | grep -q '"profiles":"linux,display,eval,email"' \
  && echo "$OUT" | grep -q '"SANDBOX_SERVICE_TOKEN"' \
  && pass "report lists added keys, profiles and the unit change" || fail "report wrong: $OUT"
echo "$OUT" | grep -q "$(grep '^SANDBOX_SERVICE_TOKEN=' "$BOX/.env" | cut -d= -f2)" \
  && fail "report leaks a secret value" || pass "report carries no values"
echo "$OUT" | grep -q '"SERVICE_TOKEN_VOICE"' && fail "report lists an existing key" || pass "report omits existing keys"
python3 -c 'import json,sys; json.loads(sys.argv[1])' "$OUT" 2>/dev/null \
  && pass "report is valid JSON" || fail "report is not JSON: $OUT"

echo "env-reconcile: second run is a no-op"
cp "$BOX/.env" "$TMP/env.after1"; cp "$BOX/droplet.service" "$TMP/unit.after1"
OUT2="$(reconcile "$BOX" upd2 2>"$TMP/err")"; RC=$?
[ "$RC" -eq 0 ] && cmp -s "$BOX/.env" "$TMP/env.after1" && cmp -s "$BOX/droplet.service" "$TMP/unit.after1" \
  && pass "second run leaves .env and the unit byte-identical" || fail "second run changed something (rc=$RC)"
[ ! -e "$BOX/.env.bak.ota-upd2" ] && pass "second run writes no backup" || fail "second run wrote a backup"
[ "$OUT2" = '{"addedKeys":[],"addedProfiles":[],"profiles":"linux,display,eval,email","unitUpdated":false,"backup":null}' ] \
  && pass "second-run report is empty" || fail "second-run report: $OUT2"

echo "env-reconcile: .env symlinked onto /data (WARP-232)"
BOX2="$TMP/box2"; make_box "$BOX2"
mkdir -p "$TMP/data"; mv "$BOX2/.env" "$TMP/data/env"; ln -s "$TMP/data/env" "$BOX2/.env"
reconcile "$BOX2" upd3 >/dev/null 2>&1
[ -L "$BOX2/.env" ] && grep -q '^SANDBOX_SERVICE_TOKEN=' "$TMP/data/env" && [ -f "$TMP/data/env.bak.ota-upd3" ] \
  && pass "writes through the symlink; link and backup stay on /data" || fail "symlinked .env mishandled"

echo "env-reconcile: refusals"
BOX3="$TMP/box3"; make_box "$BOX3"
sed -i.b 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=linux;rm -rf/' "$BOX3/.env"; rm -f "$BOX3/.env.b"
cp "$BOX3/.env" "$TMP/env3"
if reconcile "$BOX3" upd4 >/dev/null 2>&1; then fail "odd COMPOSE_PROFILES accepted"
else cmp -s "$BOX3/.env" "$TMP/env3" && pass "unexpected profile chars refused, .env untouched" || fail "refusal still wrote .env"; fi
reconcile "$TMP/nobox" upd5 >/dev/null 2>&1 && fail "missing .env accepted" || pass "missing .env fails loudly"

echo "env-reconcile: drift vs migrate_env"
MIGRATE_KEYS="$(awk '/^migrate_env\(\)/,/^}/' "$SECRETS_SH" | grep -o '_migrate_ensure_key [A-Z0-9_]*' | awk '{print $2}' | sort -u)"
KNOWN="$(sed -n "/^ENSURE_KEYS='/,/^'/p" "$RECONCILE" | awk 'NF==2{print $1}';
  sed -n "s/^SETUP_ONLY_KEYS='\(.*\)'/\1/p" "$RECONCILE" | tr ' ' '\n')"
MISSING=""
for k in $MIGRATE_KEYS; do printf '%s\n' "$KNOWN" | grep -qx "$k" || MISSING="$MISSING $k"; done
[ -n "$MIGRATE_KEYS" ] && [ -z "$MISSING" ] \
  && pass "every migrate_env key ($(echo "$MIGRATE_KEYS" | wc -l | tr -d ' ')) is reconciled or setup-only" \
  || fail "migrate_env keys unknown to docker/ota/env-reconcile.sh:$MISSING — add each to ENSURE_KEYS (OTA-safe) or SETUP_ONLY_KEYS (with a reason)"

echo ""
echo "$TESTS tests, $FAILURES failures"
[ "$FAILURES" -eq 0 ]
