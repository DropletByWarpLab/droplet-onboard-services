#!/usr/bin/env bash
# =============================================================================
# Integration test: factory-reset.sh → setup.sh → setup wizard → login
#
# Verifies the complete reset→provision→onboard cycle produces a working
# system where the custom setup wizard appears and account creation works.
#
# Prerequisites: Docker running, no other services on ports 80/8080.
# Runtime: ~3–5 minutes (builds images + waits for services).
#
# ci: developer-only — builds the whole image set and binds host ports 80/8080
# for 3–5 minutes per run. A runner can do it, but not on every PR under the
# $100/month Actions cap (docs/ci-cost-budget.md); setup-e2e.yml already owns
# the from-scratch build lane. The reset's own invariants are covered without
# Docker by tests/factory-reset-{storage,volume}-wipe and -purge-scope, all
# three of which DO run at PR time (WARP-2647).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
FAILURES=0
TESTS=0

# --- Helpers ---
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }
skip() { printf "  \033[33m○\033[0m %s (skipped)\n" "$1"; }

# Detect docker compose command
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "Docker Compose not found"; exit 1
fi

echo ""
echo "  ================================================"
echo "  Factory Reset + Setup Integration Test"
echo "  ================================================"
echo ""

# =============================================================================
# Phase 1: Factory reset
# =============================================================================
echo "--- Phase 1: Factory reset ---"

if "$REPO_ROOT/scripts/factory-reset.sh" --yes >/dev/null 2>&1; then
  pass "Factory reset completed successfully"
else
  fail "Factory reset exited with error"
fi

# =============================================================================
# Phase 2: Verify clean state
# =============================================================================
echo "--- Phase 2: Verify clean state ---"

# Check volumes are gone. Derive the REAL compose project name from the compose
# file's `name:` (it is `droplet`, NOT the `docker` dir-basename — see the
# factory-reset.sh Phase 1 comment). The old basename guess checked nonexistent
# `docker_*` volumes and trivially passed even when the real `droplet_*` volumes
# survived — the exact silent-success this whole fix targets.
COMPOSE_PROJECT=$(grep -E '^name:[[:space:]]' "$COMPOSE_FILE" | head -1 | awk '{print $2}' || true)
COMPOSE_PROJECT="${COMPOSE_PROJECT:-droplet}"
# brain-memory-data + ops-audit are the customer-data volumes the wipe list used
# to omit (they survived a reset); assert they are gone. `filedata` was a dead
# legacy name that no compose volume ever created, so it always vacuously passed.
for vol in pgdata brain-memory-data ops-audit nextcloud-data aikeys nvrdata; do
  full_name="${COMPOSE_PROJECT}_${vol}"
  if docker volume inspect "$full_name" >/dev/null 2>&1; then
    fail "Volume ${full_name} still exists"
  else
    pass "Volume ${vol} removed"
  fi
done

# Authoritative gate (mirrors factory-reset.sh's own verify): NO *_pgdata volume
# may survive a reset. A stale PGDATA is what makes the new db container keep the
# OLD role password and crash-loop the orchestrator against the rotated .env.
if docker volume ls --format '{{.Name}}' | grep -qE '_pgdata$'; then
  survivors=$(docker volume ls --format '{{.Name}}' | grep -E '_pgdata$' | tr '\n' ' ')
  fail "a *_pgdata volume survived factory-reset: ${survivors}"
else
  pass "no *_pgdata volume survives factory-reset (docker volume ls clean)"
fi

# Check .env is gone
if [ ! -f "$REPO_ROOT/.env" ]; then
  pass ".env removed"
else
  fail ".env still exists after reset"
fi

# Check certs are gone
if [ ! -d "$REPO_ROOT/docker/certs" ]; then
  pass "TLS certs removed"
else
  fail "docker/certs/ still exists"
fi

# =============================================================================
# Phase 3: Run setup
# =============================================================================
echo "--- Phase 3: Run setup ---"

if "$REPO_ROOT/scripts/setup.sh" --skip-docker 2>&1 | tail -3; then
  pass "Setup completed"
else
  fail "Setup exited with error"
  echo "  Cannot continue — setup failed"
  exit 1
fi

# Verify .env was regenerated
if [ -f "$REPO_ROOT/.env" ]; then
  pass ".env generated with new secrets"
else
  fail ".env not generated — setup incomplete"
  exit 1
fi

# =============================================================================
# Phase 4: Wait for services and verify health
# =============================================================================
echo "--- Phase 4: Verify services ---"

# Wait for API health
echo "  Waiting for API..."
retries=30
while [ $retries -gt 0 ]; do
  HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost/api/health 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    break
  fi
  retries=$((retries - 1))
  sleep 2
done

if [ "$HTTP_CODE" = "200" ]; then
  pass "API health check (HTTP 200)"
else
  fail "API health check (HTTP $HTTP_CODE)"
fi

# Check setup wizard is available (setupRequired=true)
SETUP_JSON=$(curl -sf http://localhost/api/auth/setup 2>/dev/null || echo "{}")
SETUP_REQUIRED=$(echo "$SETUP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('setupRequired','error'))" 2>/dev/null || echo "error")
if [ "$SETUP_REQUIRED" = "True" ]; then
  pass "Setup wizard available (setupRequired=true)"
else
  fail "Setup status unexpected: $SETUP_REQUIRED (expected True)"
fi

# Check Nextcloud is installed
NC_JSON=$(curl -sf http://localhost:8080/status.php 2>/dev/null || echo "{}")
NC_INSTALLED=$(echo "$NC_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('installed','error'))" 2>/dev/null || echo "error")
if [ "$NC_INSTALLED" = "True" ]; then
  pass "Nextcloud backend is installed"
else
  fail "Nextcloud not installed: $NC_INSTALLED"
fi

# Check dashboard loads (should redirect to /setup for unauthenticated users)
DASH_CODE=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost 2>/dev/null || echo "000")
if [ "$DASH_CODE" = "200" ]; then
  pass "Dashboard loads (HTTP 200)"
else
  fail "Dashboard failed (HTTP $DASH_CODE)"
fi

# =============================================================================
# Phase 5: Test the setup wizard API
# =============================================================================
echo "--- Phase 5: Setup wizard ---"

# Create admin account via the setup wizard endpoint
SETUP_RESP=$(curl -sf -X POST http://localhost/api/auth/setup \
  -H "Content-Type: application/json" \
  -d '{"username":"testadmin","password":"testpassword123","displayName":"Test Admin"}' 2>/dev/null || echo '{"error":"request failed"}')

SETUP_OK=$(echo "$SETUP_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('status')=='ok' else d.get('error','unknown'))" 2>/dev/null || echo "parse_error")
if [ "$SETUP_OK" = "ok" ]; then
  pass "Admin account created via setup wizard"
else
  fail "Setup wizard failed: $SETUP_OK"
fi

# =============================================================================
# Phase 6: Test login with the new account
# =============================================================================
echo "--- Phase 6: Login ---"

LOGIN_RESP=$(curl -sf -X POST http://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -c /tmp/droplet-test-cookies \
  -d '{"username":"testadmin","password":"testpassword123"}' 2>/dev/null || echo '{"error":"request failed"}')

LOGIN_USER=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user',{}).get('username','error'))" 2>/dev/null || echo "parse_error")
if [ "$LOGIN_USER" = "testadmin" ]; then
  pass "Login successful (user: testadmin)"
else
  fail "Login failed: $LOGIN_USER"
fi

# Verify setup is no longer required
SETUP_JSON2=$(curl -sf http://localhost/api/auth/setup 2>/dev/null || echo "{}")
SETUP_REQUIRED2=$(echo "$SETUP_JSON2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('setupRequired','error'))" 2>/dev/null || echo "error")
if [ "$SETUP_REQUIRED2" = "False" ]; then
  pass "Setup no longer required after account creation"
else
  fail "Setup still required after account creation: $SETUP_REQUIRED2"
fi

# Verify /api/auth/me works with the session cookie
ME_RESP=$(curl -sf http://localhost/api/auth/me -b /tmp/droplet-test-cookies 2>/dev/null || echo '{"error":"no session"}')
ME_USER=$(echo "$ME_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('username','error'))" 2>/dev/null || echo "parse_error")
if [ "$ME_USER" = "testadmin" ]; then
  pass "Session cookie works (/api/auth/me returns testadmin)"
else
  fail "Session cookie failed: $ME_USER"
fi

# Cleanup temp cookie file
rm -f /tmp/droplet-test-cookies

# =============================================================================
# Phase 7: WARP-484 audit-key era boundary
# =============================================================================
# Factory-reset must delete the WARP-456 audit signing key. Preserving it
# across reset would silently fork the activity-log chain: same HMAC key
# signing two distinct genesis rows in two unrelated histories.
#
# Test: capture sha256 of the current key, run factory-reset --yes (without
# --reinstall — we only need the reset half), confirm the key is gone, then
# re-run setup.sh and confirm the regenerated key has a different sha256.
# =============================================================================
echo "--- Phase 7: WARP-484 audit-key era boundary ---"

AUDIT_KEY_PATH="$REPO_ROOT/data/secrets/audit.key"

if [ ! -f "$AUDIT_KEY_PATH" ]; then
  # Phase 3's setup.sh should have generated this. If it didn't, every
  # Phase 7 assertion below is meaningless — skip with a fail.
  fail "audit.key not present after setup.sh — Phase 7 cannot run"
else
  pass "audit.key present after setup.sh"

  KEY_SHA_BEFORE=$(sha256sum "$AUDIT_KEY_PATH" | awk '{print $1}')

  # Run factory-reset again. We swallow the output because Phase 1's
  # `factory-reset.sh --yes` already validated the happy path; here we only
  # care about the audit-key side-effect.
  if "$REPO_ROOT/scripts/factory-reset.sh" --yes >/dev/null 2>&1; then
    pass "factory-reset re-run succeeded"
  else
    fail "factory-reset re-run failed"
  fi

  if [ ! -f "$AUDIT_KEY_PATH" ] && [ ! -d "$REPO_ROOT/data/secrets" ]; then
    pass "audit.key deleted by factory-reset (data/secrets/ gone)"
  elif [ ! -f "$AUDIT_KEY_PATH" ]; then
    pass "audit.key deleted by factory-reset"
  else
    fail "audit.key still exists after factory-reset — era boundary not enforced"
  fi

  # Re-provision so subsequent CI steps (if any) still have a working stack.
  # We only need setup.sh to regenerate the key; --skip-start short-circuits
  # the full container boot since we already proved that path in Phase 3.
  if "$REPO_ROOT/scripts/setup.sh" --skip-docker --skip-start 2>&1 | tail -3; then
    pass "setup.sh --skip-start regenerated secrets including audit.key"
  else
    fail "setup.sh failed to regenerate after second factory-reset"
  fi

  if [ -f "$AUDIT_KEY_PATH" ]; then
    KEY_SHA_AFTER=$(sha256sum "$AUDIT_KEY_PATH" | awk '{print $1}')
    if [ "$KEY_SHA_BEFORE" != "$KEY_SHA_AFTER" ]; then
      pass "audit.key regenerated with a new sha256 (chain era boundary enforced)"
    else
      # If the two sha256s match, sync_audit_signing_key found a non-empty
      # file and preserved it — i.e. factory-reset didn't actually delete it.
      fail "audit.key sha256 unchanged after reset+setup — old key was preserved"
    fi
  else
    fail "audit.key not regenerated by setup.sh"
  fi
fi

# =============================================================================
# Results
# =============================================================================
echo ""
echo "  ================================================"
printf "  Results: %d/%d passed" "$((TESTS - FAILURES))" "$TESTS"
if [ $FAILURES -gt 0 ]; then
  printf " (\033[31m%d failed\033[0m)" "$FAILURES"
fi
printf "\n"
echo "  ================================================"
echo ""

exit $FAILURES
