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
#     isolated compose project, per-service fips_self_test assertions,
#     edge-TLS probes, the full FIPS-enforcing boot (orchestrator health +
#     API endpoints — always asserted since the WARP-1063 fix; the pre-fix
#     LIBRARY_HAS_NO_CIPHERS exception branch is gone), the
#     enforcing-AND-alive runtime crypto execs, the non-provider FIPS-gate
#     guard, and a down -v teardown trap;
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
  # The structured self-test line for the three provider services observable
  # before their (possibly TLS-blocked) app startup.
  st_ok=true
  for svc in orchestrator mcp-server ai-gateway; do
    grep -q "$svc" "$HARNESS" || { st_ok=false; break; }
  done
  # The harness greps container logs with a whitespace-tolerant JSON pattern
  # ("fips":[[:space:]]*true) because Python's json.dumps emits `"fips": true`
  # with a space while Node emits `"fips":true` without — so match the value
  # tolerantly here too rather than the literal (they must stay in lockstep).
  if $st_ok && grep -q 'fips_self_test' "$HARNESS" && grep -qE '"fips":[^,}]*true' "$HARNESS"; then
    pass "asserts the fips_self_test log line for the provider services"
  else
    fail "missing fips_self_test log assertions (svc loop broke at '${svc:-}')"
  fi
  # Edge TLS: gateway log line + a negotiated-AES-GCM / ChaCha-refused probe.
  if grep -q 'fips_edge_tls' "$HARNESS" && grep -q 'TLS_CHACHA20_POLY1305_SHA256' "$HARNESS"; then
    pass "asserts gateway fips_edge_tls + ChaCha-refused edge handshake"
  else
    fail "missing edge-TLS FIPS assertions (fips_edge_tls / ChaCha probe)"
  fi
  # WARP-1063: the full FIPS-enforcing boot is ALWAYS asserted — the pre-fix
  # branch that expected LIBRARY_HAS_NO_CIPHERS as documented behavior must be
  # gone (no wait_for_log on that pattern), while the orchestrator health
  # check anchors the fixed-boot assertions.
  if grep -q '/api/orchestrator/health' "$HARNESS" \
     && ! grep -qE "wait_for_log .*(library has no ciphers|LIBRARY_HAS_NO_CIPHERS)" "$HARNESS"; then
    pass "asserts the full FIPS-enforcing boot (no expected-no-ciphers exception branch)"
  else
    fail "harness still encodes the pre-WARP-1063 no-ciphers exception (or lost the health check)"
  fi
  # EXPECT_FIPS_STACK_BOOTS stays accepted (ticket-acceptance invocation) even
  # though the fixed boot is now the default assertion.
  if grep -q 'EXPECT_FIPS_STACK_BOOTS' "$HARNESS"; then
    pass "still documents/accepts EXPECT_FIPS_STACK_BOOTS (back-compat no-op)"
  else
    fail "EXPECT_FIPS_STACK_BOOTS disappeared from the harness"
  fi
  # The three API endpoints are asserted on the fixed-boot path.
  ep_ok=true
  for ep in /api/llm/conversations /api/files/search/status /api/calendar/places; do
    grep -q "$ep" "$HARNESS" || { ep_ok=false; break; }
  done
  if $ep_ok; then
    pass "smoke-checks the three API endpoints under the FIPS-enforcing boot"
  else
    fail "missing endpoint smoke check ('${ep:-}')"
  fi
  # Runtime enforcing-AND-alive execs in BOTH stacks (Python + Node): an
  # approved digest must WORK (a dead provider also refuses MD5 — WARP-1063)
  # and MD5 must be refused.
  if grep -q 'usedforsecurity=True' "$HARNESS" \
     && grep -qE "createHash\(.md5.\)" "$HARNESS" \
     && grep -qE "createHash\(.sha256.\)" "$HARNESS" \
     && grep -qE '_hashlib\.new\("sha256"' "$HARNESS"; then
    pass "execs enforcing-AND-alive probes (SHA-256 works + MD5 refused) in both stacks"
  else
    fail "missing runtime enforcing-AND-alive exec probes"
  fi
  # The ai-gateway exec must exercise BOTH of its libcrypto instances in the
  # production order (pyca cryptography first, then the system libssl) — the
  # dual-instance collision is exactly what WARP-1063 fixed.
  if grep -q 'default_backend' "$HARNESS" && grep -q 'PROTOCOL_TLS_CLIENT' "$HARNESS"; then
    pass "ai-gateway exec probes both libcrypto instances (pyca + system ssl)"
  else
    fail "ai-gateway exec no longer probes the dual-libcrypto shape"
  fi
  # Non-provider services must not enter the FIPS gate (the WARP-318 fix):
  # assert on the FAILED self-test line, not RestartCount (a service can be
  # down for an unrelated reason — the load-bearing signal is fips:false).
  # Same whitespace-tolerant match as the fips:true check above — the harness
  # asserts the non-provider negative with "fips":[[:space:]]*false.
  if grep -qE '"fips":[^,}]*false' "$HARNESS" && grep -q 'device-identity-svc' "$HARNESS"; then
    pass "guards non-provider services against the FIPS boot gate"
  else
    fail "missing non-provider FIPS-gate guard (fips:false)"
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
#
# ⚠ Capture the block FIRST, exactly like the DROPLET_FIPS_REQUIRED loop
# above. `svc_block "$svc" | grep -q …` looks equivalent but is a race under
# this file's `set -o pipefail`: grep -q exits the instant it matches, awk
# takes SIGPIPE (141) while still writing the rest of the block, and
# pipefail promotes that to the pipeline's status — so a PRESENT pin reads
# as absent. It only fires when enough of the block follows the matched
# line, which is why this passed for a year and then failed the moment the
# camera-discovery block grew from 70 lines to 90 (WARP-1957). A guard that
# silently flips to "fail" on unrelated growth is worse than no guard.
for svc in device-identity-svc camera-discovery fleet-agent; do
  block="$(svc_block "$svc")"
  if printf '%s\n' "$block" | grep -qE '^\s+(- OPENSSL_CONF=/etc/ssl/openssl\.cnf|OPENSSL_CONF: /etc/ssl/openssl\.cnf)$'; then
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

# --- 3b) device-identity-svc mount-ownership fix (WARP-1248) -----------------
# The compose file bind-mounts /var/lib/droplet/tpm + /var/run/droplet into
# device-identity-svc; on any host where a source dir doesn't pre-exist (every
# fresh CI runner) dockerd auto-creates it root:root and the non-root sidecar
# crash-loops on its first EK-cert write. The image entrypoint must fix the
# mount ownership as root and then DROP privileges, and the harness must
# assert the sidecar genuinely boots (the crash-loop was silent in green runs).
DIS_ENTRYPOINT="$REPO_ROOT/services/device-identity-svc/entrypoint.sh"
DIS_DOCKERFILE="$REPO_ROOT/services/device-identity-svc/Dockerfile"
if [ -f "$DIS_ENTRYPOINT" ] \
   && grep -q 'chown -R droplet:droplet' "$DIS_ENTRYPOINT" \
   && grep -qE 'setpriv .*--reuid droplet' "$DIS_ENTRYPOINT"; then
  pass "device-identity entrypoint chowns the bind mounts, then drops to droplet via setpriv"
else
  fail "device-identity entrypoint missing its chown-then-drop-privileges shape"
fi
if grep -qE '^ENTRYPOINT \["/entrypoint\.sh"\]' "$DIS_DOCKERFILE" \
   && ! grep -qE '^USER ' "$DIS_DOCKERFILE"; then
  pass "device-identity Dockerfile wires the entrypoint (no USER directive to bypass it)"
else
  fail "device-identity Dockerfile does not start via the ownership-fixing entrypoint"
fi
if [ -f "$HARNESS" ] \
   && grep -q 'PermissionError' "$HARNESS" \
   && grep -q 'test -S /var/run/droplet/device-identity.sock' "$HARNESS" \
   && grep -q 'test -f /var/lib/droplet/tpm/provisioned.json' "$HARNESS"; then
  pass "harness asserts device-identity-svc health (no PermissionError, provisioned, socket bound)"
else
  fail "harness lost the WARP-1248 device-identity-svc health assertions"
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
