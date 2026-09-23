#!/bin/sh
# =============================================================================
# WARP-2995 — OTA host-side .env reconcile (additive, idempotent)
# =============================================================================
#
# WHY THIS LIVES UNDER docker/: a release's configs.tar.gz is
# `git archive HEAD docker`, so docker/ is the only part of the tree an OTA
# delivers to a box. scripts/lib/secrets.sh (migrate_env) never reaches an
# OTA-only box, so every key or COMPOSE_PROFILES token a newer setup.sh adds
# stayed missing there. This file travels with each release, and the release
# that needs a key carries the code that adds it.
#
# HOW IT RUNS: docker/ota/apply-update.sh `reconcile-env` runs it on the HOST
# (the helper itself runs there, WARP-3007), after stage-configs and BEFORE
# any container swap. The orchestrator itself cannot read .env.
#
# CONTRACT (never broken, pinned by scripts/test/ota-env-reconcile.test.sh):
#   * ADDITIVE: a key is written only when no `KEY=` line exists. An existing
#     value, even an empty one, is never touched. A profile token is appended
#     to an existing COMPOSE_PROFILES only when it is not already a list
#     element.
#   * IDEMPOTENT: a second run changes nothing and writes no backup.
#   * ATOMIC: stage beside the REAL target (.env may be a symlink onto the
#     encrypted /data, WARP-232), then rename. A backup .env.bak.ota-<id>
#     lands beside the target only when something changed.
#   * CONTENT-FREE REPORT: stdout is ONE JSON line of key NAMES, profile
#     tokens and paths, never a value.
#
# It also re-renders the boot unit's `--profile` flags from the merged
# COMPOSE_PROFILES (render_systemd_unit bakes them in at setup time). No
# daemon-reload from here: systemd reads the file fresh at the next boot,
# and that boot is the only time the unit's ExecStart runs.
#
# Usage: env-reconcile.sh <repo-root> [update-id]
#   DROPLET_OTA_UNIT_FILE overrides the unit path (tests).
# =============================================================================
set -eu

ROOT="${1:?usage: env-reconcile.sh <repo-root> [update-id]}"
TAG="${2:-$(date +%s)}"
UNIT="${DROPLET_OTA_UNIT_FILE:-/etc/systemd/system/droplet.service}"

die() { printf '[env-reconcile] ERROR: %s\n' "$*" >&2; exit 1; }

# Keys OTA may add: bearer tokens both ends read from .env (no file for setup
# to materialize) and fixed defaults. Mirrors migrate_env's backfills; the
# drift test fails when migrate_env gains a key that is in neither list below.
#   hex32/hex64 = fresh random hex; =VALUE = that literal (may be empty).
# DEVICE_SECRET (WARP-2985): added only when ABSENT, like every key here.
#   migrate_env also replaces an empty or publicly-known value; OTA does not
#   (existing values are never touched). Every setup.sh-written .env has had a
#   generated one since the first release, so that case is hand-authored only.
ENSURE_KEYS='
ROUTING_SERVICE_TOKEN hex32
DOC_RENDER_SERVICE_TOKEN hex32
SANDBOX_SERVICE_TOKEN hex32
MCP_BRIDGE_SERVICE_TOKEN hex32
SERVICE_TOKEN_VOICE hex32
SERVICE_TOKEN_DISPLAY hex32
SERVICE_TOKEN_SWITCH hex32
INFERENCE_AUTH_TOKEN hex32
SERVICE_TOKEN_AI_GATEWAY hex32
OPS_TOKEN hex32
SERVICE_TOKEN_EMAIL hex32
ORCHESTRATOR_SAMPLER_TOKEN hex32
AI_GATEWAY_SAMPLER_TOKEN hex32
SERVICE_TOKEN_EGRESS_AUDIT hex32
SERVICE_TOKEN_ERP_BRIDGE hex32
SERVICE_TOKEN_RAG_EVAL hex32
SERVICE_TOKEN_MCP hex32
DROPLET_MATTER_SERVICE_TOKEN hex32
ONLYOFFICE_JWT_SECRET hex32
JWT_SECRET hex64
DEVICE_SECRET hex32
NVR_MEDIA_SOURCE =nvrdata
INFERENCE_RUNTIME =ollama
HQ_ISSUANCE_URL =https://droplet-fleet-hq.rjouffret.workers.dev
TUNNEL_TOKEN =
DROPLET_PROVISION_TOKEN =
OVERLAY_CONNECT_ENABLED =true
OVERLAY_CONNECT_POLL_SECONDS =15
OVERLAY_PEER_IDLE_EXPIRY_HOURS =720
RAGAS_EVAL_USER =eval-fixtures
DROPLET_TPM_BACKEND =mock
DROPLET_FIPS_MODE =0
DROPLET_ENV =production
DROPLET_INTERNAL_TLS =0
'
# migrate_env keys OTA must NOT add. setup.sh owns them:
#   ROUTING_MODE, SMB_ENABLED, COMPOSE_PROFILES - platform-shaped defaults
#     (macOS vs Linux) that setup decides. Tokens ARE merged into an existing
#     COMPOSE_PROFILES below.
#   SMB_PASSWORD - paired with the platform-gated SMB_ENABLED.
#   OPENWRT_PASSWORD, REDIS_PASSWORD_* - materialized into secret / ACL files
#     by setup. A key with no matching file breaks the service.
#   DROPLET_DEVICE_ID - derived from hardware, bound to an HQ registration.
# shellcheck disable=SC2034  # read by the drift test, not here
SETUP_ONLY_KEYS='ROUTING_MODE SMB_ENABLED COMPOSE_PROFILES SMB_PASSWORD OPENWRT_PASSWORD REDIS_PASSWORD_ORCHESTRATOR REDIS_PASSWORD_AI_GATEWAY REDIS_PASSWORD_MCP DROPLET_DEVICE_ID'
# Tokens migrate_env appends to an existing COMPOSE_PROFILES.
ENSURE_PROFILES='email'

rand_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }

json_list() {
  # $* = words -> ["a","b"]  (callers pass [A-Za-z0-9_-] words only)
  out=""
  for w in "$@"; do out="${out:+$out,}\"$w\""; done
  printf '[%s]' "$out"
}

# --- .env ---------------------------------------------------------------------
ENV_FILE="$ROOT/.env"
[ -f "$ENV_FILE" ] || die "no .env at $ENV_FILE (box never ran setup.sh?)"
TARGET="$ENV_FILE"
[ -L "$ENV_FILE" ] && TARGET="$(readlink -f "$ENV_FILE")"
[ -f "$TARGET" ] || die ".env symlink target missing: $TARGET"

STAGE="$TARGET.ota-reconcile.$$"
rm -f "$TARGET".ota-reconcile.* 2>/dev/null || true
trap 'rm -f "$STAGE" "$STAGE.tmp" "$STAGE.keys" "$STAGE.unit"' EXIT
cp -p "$TARGET" "$STAGE"
chmod 600 "$STAGE"
# A missing trailing newline would glue the first appended key onto the last line.
if [ -s "$STAGE" ] && [ -n "$(tail -c 1 "$STAGE")" ]; then printf '\n' >> "$STAGE"; fi

added_keys=""
echo "$ENSURE_KEYS" | while read -r key gen; do
  [ -n "$key" ] || continue
  grep -q "^${key}=" "$STAGE" && continue
  case "$gen" in
    hex32) val="$(rand_hex 32)" ;;
    hex64) val="$(rand_hex 64)" ;;
    =*) val="${gen#=}" ;;
    *) die "bad generator for $key: $gen" ;;
  esac
  printf '%s=%s\n' "$key" "$val" >> "$STAGE"
  printf '%s\n' "$key" >> "$STAGE.keys"
done
if [ -f "$STAGE.keys" ]; then
  added_keys="$(tr '\n' ' ' < "$STAGE.keys")"
  rm -f "$STAGE.keys"
fi

# Last assignment wins (how compose reads .env). Strip spaces and quotes.
current_profiles() {
  sed -n 's/^COMPOSE_PROFILES=//p' "$1" | tail -n 1 | tr -d ' "'"'"
}
added_profiles=""
if grep -q '^COMPOSE_PROFILES=' "$STAGE"; then
  profiles="$(current_profiles "$STAGE")"
  for tok in $ENSURE_PROFILES; do
    case ",$profiles," in *",$tok,"*) continue ;; esac
    profiles="${profiles:+$profiles,}$tok"
    added_profiles="$added_profiles $tok"
  done
  if [ -n "$added_profiles" ]; then
    awk -v v="$profiles" '/^COMPOSE_PROFILES=/ { print "COMPOSE_PROFILES=" v; next } { print }' \
      "$STAGE" > "$STAGE.tmp"
    cat "$STAGE.tmp" > "$STAGE"
  fi
else
  profiles=""
fi
case "$profiles" in
  *[!a-z0-9,_-]*) die "COMPOSE_PROFILES has unexpected characters; refusing to touch the boot unit" ;;
esac

backup="null"
if [ -n "$added_keys$added_profiles" ]; then
  cp -p "$TARGET" "$TARGET.bak.ota-$TAG"
  backup="\"$TARGET.bak.ota-$TAG\""
  mv "$STAGE" "$TARGET"
fi

# --- boot unit ----------------------------------------------------------------
# Same shape render_systemd_unit writes: one `--profile X` per token right
# after `-f <compose>` on the ExecStart/ExecReload `up` lines.
unit_updated=false
if [ -f "$UNIT" ]; then
  flags=""
  for tok in $(echo "$profiles" | tr ',' ' '); do flags="$flags --profile $tok"; done
  awk -v flags="$flags" '
    /^Exec(Start|Reload)=/ && / up / {
      line = ""; skip = 0; after_f = 0
      n = split($0, w, " ")
      for (i = 1; i <= n; i++) {
        if (skip) { skip = 0; continue }
        if (w[i] == "--profile") { skip = 1; continue }
        line = line (line == "" ? "" : " ") w[i]
        if (after_f) { line = line flags; after_f = 0 }
        if (w[i] == "-f") after_f = 1
      }
      print line; next
    }
    { print }' "$UNIT" > "$STAGE.unit"
  if ! cmp -s "$UNIT" "$STAGE.unit"; then
    cat "$STAGE.unit" > "$UNIT"
    unit_updated=true
  fi
  rm -f "$STAGE.unit"
fi

# shellcheck disable=SC2086  # word lists on purpose
printf '{"addedKeys":%s,"addedProfiles":%s,"profiles":"%s","unitUpdated":%s,"backup":%s}\n' \
  "$(json_list $added_keys)" "$(json_list $added_profiles)" "$profiles" "$unit_updated" "$backup"
