#!/usr/bin/env bash
# =============================================================================
# WARP-2099 — NVR_MEDIA_SOURCE must have a WRITER and be documented (no Docker).
#
# One key decides whether 24/7 camera footage lands on a dedicated array or on
# the OS/boot disk: `${NVR_MEDIA_SOURCE:-nvrdata}:/media/frigate` in compose.
# Before this, NOTHING in scripts/ ever wrote it — `grep -rn NVR_MEDIA_SOURCE
# scripts/` returned zero — so the value could only exist because a human
# hand-edited .env over SSH. factory-reset.sh correctly deletes .env, so every
# reset or re-image silently reverted recordings to the boot disk with no
# error: `:-nvrdata` absorbs an unset variable by design.
#
# These guards pin the writer on BOTH provisioning paths and the documentation
# on both catalogues, so the key can never go silent again.
#
# NOTE: factory-reset.sh deleting .env is CORRECT and must not change — .env
# holds device secrets, and preserving it would carry the previous owner's disk
# layout onto a factory-new box. The fix is re-establishment at first run.
# =============================================================================
set -uo pipefail  # NOT -e: assertions report + continue (flat harness convention)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE="$REPO_ROOT_REAL/docker/docker-compose.yml"
SECRETS="$REPO_ROOT_REAL/scripts/lib/secrets.sh"
TESTS=0
FAILURES=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-2099 NVR_MEDIA_SOURCE wiring guards"
echo "  ================================================"
echo ""

# --- 1) the key still has a CONSUMER ----------------------------------------
# If this seam ever moves, every guard below is measuring nothing.
if grep -q '\${NVR_MEDIA_SOURCE:-nvrdata}:/media/frigate' "$COMPOSE"; then
  pass "compose still mounts \${NVR_MEDIA_SOURCE:-nvrdata} at /media/frigate"
else
  fail "compose no longer consumes NVR_MEDIA_SOURCE — the writer is now pointless"
fi

# --- 2) a WRITER exists (this is the defect: zero writers before) -----------
if grep -qE '^NVR_MEDIA_SOURCE=nvrdata$' \
     <(sed -n '/cat >> "\$env_tmp"/,/^EOF$/p' "$SECRETS"); then
  pass "generate_env heredoc writes NVR_MEDIA_SOURCE explicitly on a fresh .env"
else
  fail "generate_env does not write NVR_MEDIA_SOURCE — a fresh box has no record of it"
fi
if grep -qE '_migrate_ensure_key NVR_MEDIA_SOURCE nvrdata' "$SECRETS"; then
  pass "migrate_env backfills NVR_MEDIA_SOURCE on upgrades"
else
  fail "migrate_env does not backfill NVR_MEDIA_SOURCE — upgraded boxes stay silent"
fi

# --- 3) functional: the migrate path actually appends, and never clobbers ---
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/.data"
export REPO_ROOT="$TMP_ROOT"
LOG_FILE="$TMP_ROOT/.data/setup.log"
export LOG_FILE
# shellcheck source=../scripts/lib/logging.sh
source "$REPO_ROOT_REAL/scripts/lib/logging.sh"
# shellcheck source=../scripts/lib/secrets.sh
source "$SECRETS"

printf 'POSTGRES_PASSWORD=x\n' > "$TMP_ROOT/.env"
chmod 600 "$TMP_ROOT/.env"
migrate_env >/dev/null 2>&1
if grep -qE '^NVR_MEDIA_SOURCE=nvrdata$' "$TMP_ROOT/.env"; then
  pass "migrate_env (functional): a pre-2099 .env gains NVR_MEDIA_SOURCE=nvrdata"
else
  fail "migrate_env (functional): key not appended"
fi

# The whole point of the ticket is an owner pointing footage at a pool. A setup
# re-run must never quietly drag it back onto the boot disk.
sed -i.bak 's|^NVR_MEDIA_SOURCE=nvrdata$|NVR_MEDIA_SOURCE=/mnt/droplet/vault-cafef00d|' \
  "$TMP_ROOT/.env" && rm -f "$TMP_ROOT/.env.bak"
migrate_env >/dev/null 2>&1
if grep -qE '^NVR_MEDIA_SOURCE=/mnt/droplet/vault-cafef00d$' "$TMP_ROOT/.env"; then
  pass "migrate_env (functional): an owner's pool path survives a setup re-run"
else
  fail "migrate_env (functional): re-run clobbered the owner's recordings target"
fi
unset REPO_ROOT

# --- 4) documented in BOTH operator catalogues ------------------------------
if grep -qE '^NVR_MEDIA_SOURCE=' "$REPO_ROOT_REAL/.env.example"; then
  pass ".env.example documents NVR_MEDIA_SOURCE"
else
  fail ".env.example does not mention NVR_MEDIA_SOURCE"
fi
if grep -q 'NVR_MEDIA_SOURCE' "$REPO_ROOT_REAL/docs/ENVIRONMENT.md"; then
  pass "docs/ENVIRONMENT.md documents NVR_MEDIA_SOURCE"
else
  fail "docs/ENVIRONMENT.md does not mention NVR_MEDIA_SOURCE"
fi
# The sibling gap found in the same pass: FRIGATE_RENDER_NODE was in
# .env.example but missing from the canonical env catalogue.
if grep -q 'FRIGATE_RENDER_NODE' "$REPO_ROOT_REAL/docs/ENVIRONMENT.md"; then
  pass "docs/ENVIRONMENT.md documents FRIGATE_RENDER_NODE (sibling gap)"
else
  fail "docs/ENVIRONMENT.md is still missing FRIGATE_RENDER_NODE"
fi

# --- 5) the compose comment points somewhere real ---------------------------
# It used to say "See docs/STATUS.md", which has zero mentions of the key.
if grep -q 'docs/STATUS.md' "$COMPOSE"; then
  fail "compose still points at docs/STATUS.md, which never documented the key"
else
  pass "compose's dangling docs/STATUS.md pointer is gone"
fi

# --- 6) factory-reset must KEEP deleting .env -------------------------------
# Guarding the deliberate non-change: "fixing" this by preserving .env would
# carry the previous owner's disk layout onto a factory-new box.
if grep -qE 'rm -f "\$REPO_ROOT/\.env"|rm -f "\$\{REPO_ROOT\}/\.env"' \
     "$REPO_ROOT_REAL/scripts/factory-reset.sh"; then
  pass "factory-reset.sh still deletes .env (deliberate — re-establishment is the fix)"
else
  fail "factory-reset.sh no longer deletes .env — device secrets would survive a reset"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "PASS tests/nvr-media-source-wiring.test.sh ($TESTS checks)"
  exit 0
fi
echo "FAIL tests/nvr-media-source-wiring.test.sh ($FAILURES/$TESTS failed)"
exit 1
