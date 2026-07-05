#!/usr/bin/env bash
# =============================================================================
# WARP-317 — Docker-free logic checks for tests/integration/fips-stack.test.sh.
# =============================================================================
#
# The real full-stack FIPS activation smoke test boots the whole compose stack
# with DROPLET_FIPS_MODE=1 and needs Docker + image builds, so it runs in the
# Docker-gated CI leg (test-fips.yml → fips-stack job). This unit test keeps
# the *harness itself* honest on any box (no Docker), mirroring the WARP-316
# fips-sabotage-logic.test.sh pattern:
#   * the harness exists, is executable, and skips cleanly without Docker
#     (via its FIPS_STACK_ASSUME_NO_DOCKER env seam — a PATH restriction can't
#     hide docker on CI runners that ship it in /usr/bin);
#   * it encodes the load-bearing steps: real setup.sh --fips activation,
#     isolated compose project, health waits, per-service fips_self_test
#     assertions, edge-TLS probes, endpoint smoke checks, MD5-refusal execs,
#     non-provider crash-loop guards, and a down -v teardown trap;
#   * the compose file pins the FIPS boot gate OFF for every service whose
#     image does NOT ship the validated provider (the WARP-318 collateral
#     crash-loop fix this ticket carries);
#   * the CI wiring + operator docs the ticket promises actually exist.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HARNESS="$REPO_ROOT/tests/integration/fips-stack.test.sh"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
TESTS=0
FAILURES=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  WARP-317 fips-stack harness logic checks (no Docker)"
echo ""

# --- 1) Harness exists, is executable, and skips cleanly without Docker -----
if [ -x "$HARNESS" ]; then
  pass "tests/integration/fips-stack.test.sh exists and is executable"
else
  fail "tests/integration/fips-stack.test.sh missing or not executable"
fi

if [ -x "$HARNESS" ]; then
  out="$(FIPS_STACK_ASSUME_NO_DOCKER=1 bash "$HARNESS" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qi 'SKIP'; then
    pass "skips cleanly (exit 0 + SKIP) when docker is unavailable"
  else
    fail "did not skip cleanly without docker (rc=$rc, out='$out')"
  fi
fi

# --- 2) The harness encodes the real activation + assertions ----------------
if [ -f "$HARNESS" ]; then
  # Activation goes through the REAL customer path (setup.sh --fips), not a
  # hand-rolled .env write.
  if grep -qE 'setup\.sh.*--fips' "$HARNESS"; then
    pass "activates FIPS via the real scripts/setup.sh --fips path"
  else
    fail "harness does not activate FIPS via setup.sh --fips"
  fi
  # Isolated compose project so a dev box's live `droplet` stack (volumes,
  # container names) is never touched.
  if grep -q 'droplet-fips-stack' "$HARNESS" && grep -qE '\-p +"\$PROJECT"' "$HARNESS"; then
    pass "runs under an isolated compose project (droplet-fips-stack)"
  else
    fail "harness does not isolate its compose project name"
  fi
  # Health wait on the orchestrator's rolled-up health endpoint.
  if grep -q '/api/orchestrator/health' "$HARNESS"; then
    pass "waits for orchestrator health before asserting"
  else
    fail "missing orchestrator health wait"
  fi
  # The structured self-test line for each provider-shipping service.
  st_ok=true
  for svc in orchestrator mcp-server ai-gateway file-indexer; do
    grep -q "$svc" "$HARNESS" || { st_ok=false; break; }
  done
  if $st_ok && grep -q 'fips_self_test' "$HARNESS" && grep -q '"fips":true' "$HARNESS"; then
    pass "asserts the fips_self_test log line for all four self-testing services"
  else
    fail "missing fips_self_test log assertions (svc loop broke at '${svc:-}')"
  fi
  # Edge TLS: gateway log line + a negotiated-AES-GCM / ChaCha-refused probe.
  if grep -q 'fips_edge_tls' "$HARNESS" && grep -q 'TLS_CHACHA20_POLY1305_SHA256' "$HARNESS"; then
    pass "asserts gateway fips_edge_tls + ChaCha-refused edge handshake"
  else
    fail "missing edge-TLS FIPS assertions (fips_edge_tls / ChaCha probe)"
  fi
  # The three API smoke endpoints.
  ep_ok=true
  for ep in /api/llm/conversations /api/files/search/status /api/calendar/places; do
    grep -q "$ep" "$HARNESS" || { ep_ok=false; break; }
  done
  if $ep_ok; then
    pass "smoke-checks the three API endpoints through the FIPS-enforcing stack"
  else
    fail "missing endpoint smoke check ('${ep:-}')"
  fi
  # Runtime MD5-refusal execs in BOTH stacks (Python + Node).
  if grep -q 'usedforsecurity=True' "$HARNESS" \
     && grep -qE "createHash\(.md5.\)" "$HARNESS"; then
    pass "execs MD5-refusal probes in both the Python and Node stacks"
  else
    fail "missing runtime MD5-refusal exec probes"
  fi
  # Non-provider services must not crash-loop (the WARP-318 collateral fix).
  if grep -q 'RestartCount' "$HARNESS" && grep -q 'device-identity-svc' "$HARNESS"; then
    pass "guards non-provider services against FIPS-on crash-loops"
  else
    fail "missing non-provider crash-loop guard (RestartCount)"
  fi
  # Teardown: volumes removed, orphans cleaned, on EXIT.
  if grep -qE 'trap .*down( -v| --volumes)' "$HARNESS" \
     || { grep -qE '^trap .*teardown.* EXIT' "$HARNESS" && grep -qE 'down -v --remove-orphans' "$HARNESS"; }; then
    pass "tears down with down -v --remove-orphans via an EXIT trap"
  else
    fail "missing down -v teardown trap"
  fi
  # Refuses to clobber a developer's existing .env unless explicitly allowed.
  if grep -q 'FIPS_STACK_ALLOW_ENV_REWRITE' "$HARNESS"; then
    pass "refuses to rewrite a pre-existing .env without explicit opt-in"
  else
    fail "missing pre-existing .env guard"
  fi
fi

# --- 3) Compose pins: no FIPS-required boot gate on non-provider images -----
# Every service below runs the WARP-229 boot self-test but its image does NOT
# ship the validated fips.so, so DROPLET_FIPS_REQUIRED must be pinned to a
# literal false in its environment block (never interpolated from the global
# knob) or setup.sh --fips crash-loops it.
svc_block() {  # $1 = service name → prints its top-level block
  awk -v s="  $1:" '$0==s{f=1; next} f && /^  [a-zA-Z][a-zA-Z0-9_-]*:$/{exit} f{print}' "$COMPOSE_FILE"
}
for svc in matter-controller email-indexer device-identity-svc camera-discovery fleet-agent; do
  block="$(svc_block "$svc")"
  # Accept both compose environment styles: `- KEY=false` and `KEY: "false"`.
  if printf '%s\n' "$block" | grep -qE '^\s+(- DROPLET_FIPS_REQUIRED=false|DROPLET_FIPS_REQUIRED: "?false"?)$' \
     && ! printf '%s\n' "$block" | grep -qE 'DROPLET_FIPS_REQUIRED[=:] *\$\{'; then
    pass "compose pins DROPLET_FIPS_REQUIRED=false for $svc (no provider in image)"
  else
    fail "compose does not pin DROPLET_FIPS_REQUIRED=false for $svc"
  fi
done
# The env_file-inheriting trio would also receive OPENSSL_CONF=<fips cnf> from
# a FIPS-on .env; their images carry the cnf but not the module, so crypto
# would break at first use. Pin the stock config (environment beats env_file).
for svc in device-identity-svc camera-discovery fleet-agent; do
  if svc_block "$svc" | grep -qE '^\s+(- OPENSSL_CONF=/etc/ssl/openssl\.cnf|OPENSSL_CONF: /etc/ssl/openssl\.cnf)$'; then
    pass "compose pins stock OPENSSL_CONF for $svc (env_file would leak the FIPS cnf)"
  else
    fail "compose does not pin stock OPENSSL_CONF for $svc"
  fi
done
# The email-indexer legacy `:-true` default (crash-loop even with the knob
# OFF on a .env without the key) must be gone.
if grep -q 'DROPLET_FIPS_REQUIRED=\${DROPLET_FIPS_REQUIRED:-true}' "$COMPOSE_FILE"; then
  fail "compose still carries the email-indexer DROPLET_FIPS_REQUIRED:-true default"
else
  pass "the DROPLET_FIPS_REQUIRED:-true default is gone from the compose file"
fi

# --- 4) CI wiring + operator docs -------------------------------------------
TFY="$REPO_ROOT/.github/workflows/test-fips.yml"
if grep -q 'tests/integration/fips-stack.test.sh' "$TFY" && grep -q 'fips-stack' "$TFY"; then
  pass "test-fips.yml carries the Docker-gated fips-stack job"
else
  fail "test-fips.yml does not wire tests/integration/fips-stack.test.sh"
fi
if [ -f "$REPO_ROOT/docs/fips.md" ]; then
  pass "docs/fips.md exists (referenced by ENVIRONMENT.md, .env.example, setup.sh)"
else
  fail "docs/fips.md missing — dangling references in ENVIRONMENT.md/.env.example/setup.sh"
fi
if grep -q 'docs/fips.md' "$REPO_ROOT/README.md" 2>/dev/null; then
  pass "README.md links docs/fips.md"
else
  fail "README.md does not link docs/fips.md"
fi
if grep -q 'docs/fips.md' "$REPO_ROOT/CLAUDE.md" 2>/dev/null; then
  pass "CLAUDE.md links docs/fips.md"
else
  fail "CLAUDE.md does not link docs/fips.md"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mResults: %d passed, 0 failed\033[0m\n\n" "$TESTS"
  exit 0
else
  printf "  \033[31mResults: %d passed, %d failed\033[0m\n\n" "$((TESTS - FAILURES))" "$FAILURES"
  exit 1
fi
