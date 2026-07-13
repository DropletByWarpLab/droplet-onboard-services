#!/usr/bin/env bash
# =============================================================================
# WARP-1061 — internal-mTLS end-to-end wiring guards (no Docker, < 2 s).
#
# The WARP-236 plumbing is only enableable if EVERY piece stays wired:
# setup.sh writes the knob, compose mounts each mesh service's bundle +
# passes the knob where env_file is absent, the images consume the shared
# TLS-aware launcher/healthcheck, and the host installers deliver client
# certs. These greps + a functional migrate_env run pin all of that so a
# future refactor can't silently re-strand the flag.
# =============================================================================
set -uo pipefail  # NOT -e: assertions report + continue (flat harness convention)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE="$REPO_ROOT_REAL/docker/docker-compose.yml"
TESTS=0
FAILURES=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-1061 internal-mTLS wiring guards"
echo "  ================================================"
echo ""

# --- 1) setup.sh writes the knob (fresh install + upgrade backfill) ----------
if grep -qE '^DROPLET_INTERNAL_TLS=0$' <(sed -n '/cat >> "\$env_tmp"/,/^EOF$/p' "$REPO_ROOT_REAL/scripts/lib/secrets.sh"); then
  pass "generate_env heredoc writes DROPLET_INTERNAL_TLS=0"
else
  fail "generate_env heredoc does not write DROPLET_INTERNAL_TLS"
fi
if grep -qE '_migrate_ensure_key DROPLET_INTERNAL_TLS 0' "$REPO_ROOT_REAL/scripts/lib/secrets.sh"; then
  pass "migrate_env backfills DROPLET_INTERNAL_TLS on upgrades"
else
  fail "migrate_env does not backfill DROPLET_INTERNAL_TLS"
fi

# Functional: migrate_env on a pre-1061 .env appends the knob; a flipped
# value survives a re-run (append-if-missing, never clobber).
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/.data"
export REPO_ROOT="$TMP_ROOT"
LOG_FILE="$TMP_ROOT/.data/setup.log"
export LOG_FILE
# shellcheck source=../scripts/lib/logging.sh
source "$REPO_ROOT_REAL/scripts/lib/logging.sh"
# shellcheck source=../scripts/lib/secrets.sh
source "$REPO_ROOT_REAL/scripts/lib/secrets.sh"
printf 'POSTGRES_PASSWORD=x\n' > "$TMP_ROOT/.env"
chmod 600 "$TMP_ROOT/.env"
migrate_env >/dev/null 2>&1
if grep -qE '^DROPLET_INTERNAL_TLS=0$' "$TMP_ROOT/.env"; then
  pass "migrate_env (functional): pre-1061 .env gains DROPLET_INTERNAL_TLS=0"
else
  fail "migrate_env (functional): knob not appended"
fi
sed -i.bak 's/^DROPLET_INTERNAL_TLS=0$/DROPLET_INTERNAL_TLS=1/' "$TMP_ROOT/.env" && rm -f "$TMP_ROOT/.env.bak"
migrate_env >/dev/null 2>&1
if grep -qE '^DROPLET_INTERNAL_TLS=1$' "$TMP_ROOT/.env"; then
  pass "migrate_env (functional): operator's =1 survives a setup re-run"
else
  fail "migrate_env (functional): re-run clobbered the operator's flag"
fi
unset REPO_ROOT

# --- 2) host client identities are issued -------------------------------------
for ident in egress-audit device-bridge host-admin gateway; do
  if grep -qE "(^|[[:space:]])$ident([[:space:]]|\$)" <(sed -n '/^INTERNAL_CA_SERVICES=(/,/^)/p' "$REPO_ROOT_REAL/scripts/lib/internal-ca.sh" | grep -v '^[[:space:]]*#'); then
    pass "INTERNAL_CA_SERVICES issues '$ident'"
  else
    fail "INTERNAL_CA_SERVICES is missing '$ident'"
  fi
done

# --- 3) compose: bundle mounts + explicit knob for env_file-less services ----
for svc_mount in orchestrator mcp-server ai-gateway file-indexer email-indexer \
                 camera-discovery routing switch oled-display matter-controller \
                 voice-io rag-eval ops-console; do
  if grep -q "service-tls/$svc_mount:/data/service-tls:ro" "$COMPOSE"; then
    pass "compose mounts $svc_mount's /data/service-tls bundle"
  else
    fail "compose is missing $svc_mount's /data/service-tls bundle mount"
  fi
done
knob_count=$(grep -cE 'DROPLET_INTERNAL_TLS=\$\{DROPLET_INTERNAL_TLS:-0\}' "$COMPOSE")
# gateway, routing, switch, oled-display, matter-controller, email-indexer,
# ops-console — the services without env_file (or with the deliberate
# no-env_file posture) need the explicit passthrough.
if [ "$knob_count" -ge 7 ]; then
  pass "compose passes the knob explicitly to the env_file-less services ($knob_count sites)"
else
  fail "compose knob passthrough count $knob_count < 7 — an env_file-less service lost the flag"
fi

# --- 4) orchestrator healthcheck is the cert-presenting client ---------------
if grep -qE '"CMD", "node", "dist/healthcheck.js"' "$COMPOSE"; then
  pass "orchestrator compose healthcheck runs dist/healthcheck.js"
else
  fail "orchestrator compose healthcheck is not the cert-presenting client"
fi
if ! grep -q "fetch('http://localhost:3000/api/orchestrator/health')" "$COMPOSE"; then
  pass "the old inline plain-HTTP orchestrator healthcheck is gone"
else
  fail "the inline plain-HTTP orchestrator healthcheck is still in compose"
fi

# --- 5) images: TLS-aware launcher + healthcheck client ----------------------
for svc in ai-gateway routing switch oled-display camera-discovery email-indexer voice-io; do
  if grep -qE '"_shared.serve"' "$REPO_ROOT_REAL/services/$svc/Dockerfile"; then
    pass "$svc image CMD uses the _shared.serve TLS-aware launcher"
  else
    fail "$svc image CMD does not use _shared.serve"
  fi
done
# ops-console inbound is a documented exemption — plain uvicorn CLI stays.
if grep -qE '^CMD \["uvicorn", "main:app"' "$REPO_ROOT_REAL/services/ops-console/Dockerfile"; then
  pass "ops-console CMD stays plain uvicorn (inbound exemption)"
else
  fail "ops-console CMD changed — its inbound is a documented plaintext exemption"
fi
for svc in voice-io rag-eval; do
  if grep -qE 'python -m _shared\.healthcheck' "$REPO_ROOT_REAL/services/$svc/Dockerfile"; then
    pass "$svc image HEALTHCHECK uses the cert-presenting client"
  else
    fail "$svc image HEALTHCHECK would break under mTLS"
  fi
done

# --- 6) host-caller delivery --------------------------------------------------
if grep -q 'service-tls/egress-audit' "$REPO_ROOT_REAL/scripts/host/usr-local-sbin/droplet-egress-audit" \
   && grep -qE 'DROPLET_INTERNAL_TLS' "$REPO_ROOT_REAL/scripts/host/usr-local-sbin/droplet-egress-audit"; then
  pass "egress-audit launcher exports the knob + the egress-audit bundle paths"
else
  fail "egress-audit launcher does not deliver the client cert contract"
fi
if grep -q 'service-tls/device-bridge' "$REPO_ROOT_REAL/scripts/install-device-bridge.sh" \
   && grep -qE '_set_env_kv "\$ENV_FILE" "DROPLET_INTERNAL_TLS"' "$REPO_ROOT_REAL/scripts/install-device-bridge.sh"; then
  pass "install-device-bridge.sh mirrors the knob + seeds the device-bridge bundle paths"
else
  fail "install-device-bridge.sh does not deliver the bridge client cert contract"
fi
if grep -q 'service-tls/host-admin' "$REPO_ROOT_REAL/scripts/lib/device-identity.sh" \
   && grep -q 'service-tls/host-admin' "$REPO_ROOT_REAL/scripts/verify.sh"; then
  pass "operator CLIs (device-identity.sh, verify.sh) use the host-admin bundle"
else
  fail "an operator CLI lost its host-admin client cert wiring"
fi

# --- 7) .env.example documents the knob ---------------------------------------
if grep -qE '^DROPLET_INTERNAL_TLS=0$' "$REPO_ROOT_REAL/.env.example"; then
  pass ".env.example documents DROPLET_INTERNAL_TLS=0"
else
  fail ".env.example is missing the DROPLET_INTERNAL_TLS knob"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "PASS tests/internal-mtls-wiring.test.sh ($TESTS checks)"
  exit 0
fi
echo "FAIL tests/internal-mtls-wiring.test.sh ($FAILURES/$TESTS failed)"
exit 1
