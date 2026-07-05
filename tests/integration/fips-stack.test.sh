#!/usr/bin/env bash
# =============================================================================
# WARP-317 — full-stack FIPS 140-3 activation smoke test.
# =============================================================================
#
# Boots the real compose stack with the customer knob ON (DROPLET_FIPS_MODE=1,
# written by the REAL activation path: scripts/setup.sh --fips) and asserts the
# ACTUAL merged behavior of FIPS activation — not an aspirational one.
#
# ┌─ WHAT THIS TEST FOUND, AND WHY IT ASSERTS WHAT IT DOES ─────────────────────┐
# │ Booting the stack with DROPLET_FIPS_MODE=1 for the first time in CI         │
# │ surfaced that the merged FIPS OpenSSL config (docker/openssl-fips.cnf)      │
# │ pins `default_properties = fips=yes` with only the fips+base providers      │
# │ active. Under that config a DEFAULT client SSL_CTX comes up with ZERO       │
# │ usable ciphersuites, so *constructing any TLS client* raises                │
# │ `LIBRARY_HAS_NO_CIPHERS` (OpenSSL err 0A0000A1) BEFORE a peer is even        │
# │ contacted:                                                                  │
# │   - orchestrator: Prisma `$connect()` → P1011 "library has no ciphers"      │
# │   - ai-gateway:   httpx `ssl.create_default_context()` in the Ollama        │
# │                   provider ctor → ssl.SSLError LIBRARY_HAS_NO_CIPHERS       │
# │ The validated provider IS loaded and IS enforcing (the boot self-tests      │
# │ below pass and MD5 is refused) — the defect is purely that the shared       │
# │ FIPS config offers no TLS ciphersuites to the default context. That is a    │
# │ WARP-967/WARP-318 provider-config issue (a correct FIPS config needs a      │
# │ `ssl_conf`/`system_default` section keeping the FIPS-approved suites        │
# │ available), NOT a WARP-317 test bug and NOT the WARP-318 crash-loop.        │
# │                                                                             │
# │ Per the WARP-317 mandate ("if the merged activation path runs a hop with a  │
# │ documented exception, assert the ACTUAL merged behavior with an explicit    │
# │ comment, not an aspirational one"), this test therefore:                    │
# │   * ASSERTS the parts that genuinely work end-to-end — the provider loads   │
# │     and enforces per service (fips_self_test fips:true), the edge TLS       │
# │     profile restricts to AES-GCM (WARP-1021), and MD5 is refused at         │
# │     runtime in both stacks;                                                 │
# │   * ASSERTS the LIBRARY_HAS_NO_CIPHERS boot block AS THE EXPECTED CURRENT    │
# │     behavior for the two TLS-client services (documented exception), rather │
# │     than waiting for an app health/endpoint that cannot come up today;      │
# │   * ASSERTS the WARP-318 collateral fix: non-provider images never enter    │
# │     the FIPS boot gate (no fips_self_test fips:false, no FIPS-caused        │
# │     restart-loop).                                                          │
# │ When the FIPS config defect is fixed, EXPECT_FIPS_STACK_BOOTS=1 flips this   │
# │ test to assert the services boot healthy + the three API endpoints serve —  │
# │ so this file is the regression guard that proves the fix when it lands.     │
# └─────────────────────────────────────────────────────────────────────────────┘
#
# Environment seams (CI-runner-safe — no PATH tricks, runners ship docker in
# /usr/bin; same convention as VFY_ASSUME_MISSING / SABOTAGE_ASSUME_NO_DOCKER):
#   FIPS_STACK_ASSUME_NO_DOCKER=1   treat docker as absent → SKIP (exit 0)
#   FIPS_STACK_ALLOW_ENV_REWRITE=1  allow running with a pre-existing .env
#                                   (setup.sh --fips REWRITES it — never set
#                                   this on a box whose .env you care about)
#   FIPS_STACK_KEEP_STACK=1         skip teardown (debugging)
#   FIPS_STACK_RENDER_ONLY=1        stop after the rendered-config posture
#                                   assertions (no image builds, no boot) —
#                                   the fast dev-box sanity path
#   EXPECT_FIPS_STACK_BOOTS=1       assert the full FIPS-enforcing app boot +
#                                   the three API endpoints (set this once the
#                                   FIPS-config no-ciphers defect is fixed)
#   FIPS_STACK_EDGE_HTTPS_PORT      host port for the gateway :443 (18443)
#   DROPLET_COMPOSE_BUILD_EXTRA_FILE  optional GHCR BuildKit cache overlay,
#                                   merged exactly like scripts/lib/compose.sh
#
# Runs in CI via .github/workflows/test-fips.yml (fips-stack job, gated on
# the FIPS option paths). Docker-free logic checks for THIS harness live in
# tests/fips-stack-logic.test.sh.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if [ -n "${FIPS_STACK_ASSUME_NO_DOCKER:-}" ] || ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker unavailable — the FIPS stack smoke test runs in the Docker-gated CI leg"
  exit 0
fi
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required"; exit 1; }

EDGE_PORT="${FIPS_STACK_EDGE_HTTPS_PORT:-18443}"
PROJECT="droplet-fips-stack"
# Boot only what the FIPS assertions need + their hard deps. Deliberately NOT
# booted: email-indexer (pre-existing missing-key bug, fixed in the WARP-235
# email.key generator — orthogonal to FIPS), file-indexer's watch loop (needs
# the Nextcloud data volume), nextcloud/ollama (heavy, no FIPS signal here).
BOOT_SERVICES=(gateway db cache broker ai-gateway mcp-server orchestrator device-identity-svc)
# Services whose images ship the validated provider AND run a boot self-test we
# can observe before their (possibly TLS-blocked) app startup.
SELFTEST_SERVICES=(orchestrator mcp-server ai-gateway)
# The two provider services whose app startup constructs a default TLS client
# and is therefore blocked by the shared-config no-ciphers defect today.
TLS_BLOCKED_SERVICES=(orchestrator ai-gateway)
# device-identity-svc is a non-provider image we boot; step 7 asserts its
# WARP-318 pin keeps it OFF the FIPS gate (checked directly by name there).

# ── .env safety: setup.sh --fips REWRITES .env ───────────────────────────────
if [ -f .env ] && [ "${FIPS_STACK_ALLOW_ENV_REWRITE:-}" != "1" ]; then
  echo "FAIL: $REPO_ROOT/.env already exists and this harness would rewrite it"
  echo "      (setup.sh --fips). Re-run with FIPS_STACK_ALLOW_ENV_REWRITE=1 on"
  echo "      a box whose .env is disposable (CI), or move your .env aside."
  exit 2
fi

# ── Compose invocation (isolated project; never the live 'droplet' stack) ────
# The gateway publishes 80/443 in the base file; remap to a loopback high port
# so the harness coexists with a box that already terminates :443.
EDGE_OVERRIDE="$(mktemp -t fips-stack-edge-XXXXXX.yml)"
cat > "$EDGE_OVERRIDE" <<EOF
services:
  gateway:
    ports: !override
      - "127.0.0.1:${EDGE_PORT}:443"
EOF

compose() {
  docker compose -p "$PROJECT" --env-file .env \
    -f docker/docker-compose.yml \
    -f docker/docker-compose.test.override.yml \
    -f "$EDGE_OVERRIDE" \
    ${DROPLET_COMPOSE_BUILD_EXTRA_FILE:+-f "$DROPLET_COMPOSE_BUILD_EXTRA_FILE"} \
    --profile full "$@"
}

teardown() {
  rc=$?
  if [ $rc -ne 0 ]; then
    echo ""
    echo "── failure log dump (last 60 lines per service) ──"
    for svc in "${BOOT_SERVICES[@]}"; do
      echo "── $svc ──"
      compose logs --no-color --tail 60 "$svc" 2>&1 || true
    done
  fi
  if [ "${FIPS_STACK_KEEP_STACK:-}" = "1" ]; then
    echo "FIPS_STACK_KEEP_STACK=1 — leaving the stack up (project $PROJECT)"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -f "$EDGE_OVERRIDE"
  exit $rc
}
trap teardown EXIT

# wait_for_log SERVICE PATTERN SECONDS — poll a service's logs for a grep -E
# pattern until it appears or the deadline passes.
wait_for_log() {
  local svc="$1" pat="$2" deadline="$3" i
  for ((i = 0; i < deadline; i += 2)); do
    if compose logs --no-color "$svc" 2>/dev/null | grep -qE "$pat"; then return 0; fi
    sleep 2
  done
  return 1
}

echo ""
echo "  WARP-317 full-stack FIPS activation smoke test"
echo ""

# ── 1) Activate FIPS through the real customer path ─────────────────────────
echo "── setup.sh --fips (secrets + knob; no build, no start) ──"
./scripts/setup.sh --skip-docker --skip-drivers --skip-build --skip-start --fips --verbose
grep -qE '^DROPLET_FIPS_MODE=1$' .env || { echo "FAIL: setup.sh --fips did not write DROPLET_FIPS_MODE=1"; exit 1; }
grep -qE '^OPENSSL_CONF=/etc/ssl/openssl-fips\.cnf$' .env || { echo "FAIL: derived OPENSSL_CONF missing from .env"; exit 1; }

# API smoke checks (only under EXPECT_FIPS_STACK_BOOTS) run without a browser
# session — same trick as the rag-tests lane.
if grep -qE '^AUTH_ENABLED=' .env; then
  sed -i.bak 's/^AUTH_ENABLED=.*/AUTH_ENABLED=false/' .env && rm -f .env.bak
else
  echo "AUTH_ENABLED=false" >> .env
fi

# The gateway needs certs; fresh CI checkouts may not have run the cert phase.
if [ ! -f docker/certs/droplet.crt ] || [ ! -f docker/certs/droplet.key ]; then
  mkdir -p docker/certs
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=droplet-ai.local \
    -keyout docker/certs/droplet.key -out docker/certs/droplet.crt >/dev/null 2>&1
fi

# ── 2) Fail-fast render assertions (cover the services we do NOT boot) ──────
echo "── rendered-config FIPS posture assertions ──"
RENDER="$(mktemp -t fips-stack-render-XXXXXX.json)"
compose --profile telemetry --profile linux --profile eval config --format json > "$RENDER" 2>/dev/null

render_env() { jq -r --arg s "$1" --arg k "$2" '.services[$s].environment[$k] // ""' "$RENDER"; }

for svc in orchestrator mcp-server web-dashboard; do
  [ "$(render_env "$svc" OPENSSL_CONF)" = "/etc/ssl/openssl-fips.cnf" ] || { echo "FAIL: $svc did not receive the FIPS OPENSSL_CONF"; exit 1; }
  [ "$(render_env "$svc" NODE_OPTIONS)" = "--openssl-shared-config" ]   || { echo "FAIL: $svc did not receive NODE_OPTIONS=--openssl-shared-config"; exit 1; }
done
for svc in orchestrator mcp-server ai-gateway file-indexer; do
  [ "$(render_env "$svc" DROPLET_FIPS_REQUIRED)" = "true" ] || { echo "FAIL: $svc did not receive DROPLET_FIPS_REQUIRED=true"; exit 1; }
done
for svc in ai-gateway file-indexer; do
  [ "$(render_env "$svc" OPENSSL_CONF)" = "/etc/ssl/openssl-fips.cnf" ] || { echo "FAIL: $svc did not receive the FIPS OPENSSL_CONF"; exit 1; }
done
[ "$(render_env gateway DROPLET_FIPS_MODE)" = "1" ] || { echo "FAIL: gateway did not receive DROPLET_FIPS_MODE=1"; exit 1; }
# Non-provider images must keep the literal OFF posture even with the knob ON
# (the WARP-318 collateral crash-loop fix; matter-controller / camera-discovery
# / fleet-agent are asserted here precisely because we don't boot them).
for svc in matter-controller email-indexer device-identity-svc camera-discovery fleet-agent; do
  [ "$(render_env "$svc" DROPLET_FIPS_REQUIRED)" = "false" ] || { echo "FAIL: non-provider $svc rendered DROPLET_FIPS_REQUIRED != false under FIPS mode"; exit 1; }
done
for svc in device-identity-svc camera-discovery fleet-agent; do
  [ "$(render_env "$svc" OPENSSL_CONF)" = "/etc/ssl/openssl.cnf" ] || { echo "FAIL: non-provider $svc rendered a non-stock OPENSSL_CONF under FIPS mode"; exit 1; }
done
rm -f "$RENDER"
echo "  ✓ render: provider services FIPS-on, non-provider services pinned OFF"

if [ "${FIPS_STACK_RENDER_ONLY:-}" = "1" ]; then
  echo ""
  echo "  PASS (render-only): activation env verified; skipping the stack boot"
  exit 0
fi

# ── 3) Boot ──────────────────────────────────────────────────────────────────
echo "── compose up (${BOOT_SERVICES[*]}) ──"
compose up -d "${BOOT_SERVICES[@]}"

# ── 4) fips_self_test lines — the provider loads AND enforces per service ────
# This is the primary "FIPS is genuinely active" signal. It fires at the top
# of each service's boot, BEFORE the TLS-client startup that the config defect
# blocks, so we can observe it regardless of the boot outcome.
echo "── structured self-test log lines ──"
for svc in "${SELFTEST_SERVICES[@]}"; do
  if wait_for_log "$svc" '"event":"fips_self_test".*"fips":true' 120; then
    echo "  ✓ $svc: fips_self_test fips:true (provider active + enforcing)"
  else
    echo "FAIL: $svc never logged fips_self_test fips:true"; exit 1
  fi
done

# ── 5) Edge TLS under the FIPS cipher profile (WARP-1021) ───────────────────
echo "── edge TLS ──"
wait_for_log gateway '"event":"fips_edge_tls".*"fips":true' 60 \
  || { echo "FAIL: gateway did not log fips_edge_tls fips:true"; exit 1; }
neg="$(echo | openssl s_client -connect "127.0.0.1:${EDGE_PORT}" -brief 2>&1 || true)"
printf '%s' "$neg" | grep -qE 'Ciphersuite: TLS_AES_(128|256)_GCM_SHA(256|384)' \
  || { echo "FAIL: edge TLS did not negotiate an AES-GCM TLS 1.3 suite: $neg"; exit 1; }
if echo | openssl s_client -connect "127.0.0.1:${EDGE_PORT}" -tls1_3 \
     -ciphersuites TLS_CHACHA20_POLY1305_SHA256 -brief >/dev/null 2>&1; then
  echo "FAIL: edge TLS accepted a ChaCha20-Poly1305-only client under FIPS mode"; exit 1
fi
echo "  ✓ gateway: AES-GCM negotiated, ChaCha refused, fips_edge_tls logged"

# ── 6) Runtime enforcement execs — MD5 refused, provider genuinely on ───────
# mcp-server stays up (its Postgres use is lazy, not at boot), so exec into it
# for the Node runtime check; ai-gateway's app exits under the defect, so probe
# the Python runtime with a one-shot `run` under the same FIPS env instead.
echo "── runtime MD5 refusal ──"
if ! compose exec -T mcp-server node -e '
  const c = require("crypto");
  if (c.getFips() !== 1) process.exit(1);
  try { c.createHash("md5").update("x").digest(); process.exit(1) } catch { process.exit(0) }
' >/dev/null 2>&1; then
  echo "FAIL: mcp-server getFips()!=1 or MD5 succeeded under FIPS mode"; exit 1
fi
echo "  ✓ mcp-server (Node bundled OpenSSL): getFips()==1, MD5 refused"
if compose run --rm --no-deps -T ai-gateway \
     python -c 'import _hashlib; _hashlib.new("md5", b"x", usedforsecurity=True)' >/dev/null 2>&1; then
  echo "FAIL: ai-gateway accepted MD5 under FIPS mode"; exit 1
fi
echo "  ✓ ai-gateway (Python/_hashlib): MD5 refused"

# ── 7) Non-provider services must not enter the FIPS gate (WARP-318 fix) ─────
# The load-bearing assertion: with DROPLET_FIPS_MODE=1, NO non-provider service
# may emit a FAILED boot self-test. If a WARP-318 pin regressed, that image
# (which has no validated provider) would receive DROPLET_FIPS_REQUIRED=true,
# run the WARP-229 self-test, fail it, and log `fips_self_test fips:false`
# before restart-looping. We assert the negative across the whole booted set —
# robust to the service being down for an unrelated reason (e.g. the pre-
# existing test-lane TPM perm quirk in device-identity-svc), because the pin's
# effect is "the self-test is SKIPPED", i.e. no fips line at all.
echo "── non-provider services stay off the FIPS boot gate (WARP-318 fix) ──"
if compose logs --no-color 2>/dev/null | grep -qE '"event":"fips_self_test".*"fips":false'; then
  echo "FAIL: a service emitted fips_self_test fips:false under FIPS mode —"
  echo "      a non-provider image entered the boot gate (WARP-318 pin regressed):"
  compose logs --no-color 2>/dev/null | grep -E '"event":"fips_self_test".*"fips":false' | head
  exit 1
fi
# And positively confirm device-identity-svc (a non-provider image we booted)
# ran WITHOUT ever hitting the gate: it must have logged NO fips_self_test line
# at all (skipped), never a fips:true (would mean it wrongly got the provider).
if compose logs --no-color device-identity-svc 2>/dev/null | grep -q '"event":"fips_self_test"'; then
  echo "FAIL: device-identity-svc ran the FIPS self-test — its pin (no provider) regressed"; exit 1
fi
echo "  ✓ no non-provider service entered the FIPS boot gate; device-identity-svc skipped it"

# ── 8) The documented Postgres/TLS-client exception (or the fixed boot) ──────
if [ "${EXPECT_FIPS_STACK_BOOTS:-}" = "1" ]; then
  # The FIPS-config no-ciphers defect is fixed — assert the full boot.
  echo "── EXPECT_FIPS_STACK_BOOTS=1: full FIPS-enforcing boot ──"
  ok=""
  for ((i = 0; i < 300; i += 2)); do
    if curl -sf http://localhost:3000/api/orchestrator/health >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  [ -n "$ok" ] || { echo "FAIL: orchestrator never became healthy under FIPS (EXPECT_FIPS_STACK_BOOTS=1)"; exit 1; }
  echo "  ✓ orchestrator healthy under FIPS"
  for ep in /api/llm/conversations /api/files/search/status /api/calendar/places; do
    ok=""; code=""
    for ((i = 0; i < 120; i += 2)); do
      code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000${ep}" || true)"
      if [ "$code" = "200" ]; then ok=1; break; fi
      sleep 2
    done
    [ -n "$ok" ] || { echo "FAIL: ${ep} never returned 200 under FIPS (last=$code)"; exit 1; }
    echo "  ✓ ${ep} → 200 (orchestrator↔Postgres reached under FIPS)"
  done
else
  # ACTUAL merged behavior today: the shared FIPS config leaves the default
  # SSL_CTX with no ciphers, so each TLS-client service fails to construct its
  # client at startup (orchestrator=Prisma P1011, ai-gateway=httpx SSLError).
  # Assert THAT explicitly — it is the documented exception, not a flake.
  echo "── documented exception: TLS-client boot blocked by the FIPS config ──"
  for svc in "${TLS_BLOCKED_SERVICES[@]}"; do
    if wait_for_log "$svc" 'library has no ciphers|LIBRARY_HAS_NO_CIPHERS' 120; then
      echo "  ✓ $svc: LIBRARY_HAS_NO_CIPHERS at TLS-client startup (expected under the current FIPS config)"
    else
      # If this service now BOOTS instead of erroring, the defect is fixed —
      # tell the operator to flip EXPECT_FIPS_STACK_BOOTS=1 rather than pass
      # silently on a stale assertion.
      echo "FAIL: $svc did NOT hit LIBRARY_HAS_NO_CIPHERS — the FIPS-config no-ciphers"
      echo "      defect appears fixed. Re-run with EXPECT_FIPS_STACK_BOOTS=1 to assert"
      echo "      the full FIPS-enforcing boot + the three API endpoints, and drop this"
      echo "      exception branch."
      exit 1
    fi
  done
  echo ""
  echo "  NOTE FOR REVIEW: FIPS is genuinely active + enforcing (self-tests pass,"
  echo "  MD5 refused, edge TLS restricted), but the shared FIPS OpenSSL config"
  echo "  (docker/openssl-fips.cnf) offers no ciphers to a default TLS client, so"
  echo "  the orchestrator/ai-gateway app boot is blocked. That is a WARP-967/"
  echo "  WARP-318 provider-config fix (add a ssl_conf/system_default section);"
  echo "  once landed, set EXPECT_FIPS_STACK_BOOTS=1 here."
fi

echo ""
echo "  PASS: FIPS activates + enforces across the provider services (self-tests,"
echo "  edge TLS restriction, runtime MD5 refusal), non-provider images stay off"
echo "  the boot gate (WARP-318 fix), and the TLS-client boot behaves exactly as"
echo "  the current merged FIPS config dictates."
