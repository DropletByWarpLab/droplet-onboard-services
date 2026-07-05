#!/usr/bin/env bash
# =============================================================================
# WARP-317 — full-stack FIPS 140-3 activation smoke test.
# =============================================================================
#
# Boots the real compose stack with the customer knob ON (DROPLET_FIPS_MODE=1,
# written by the REAL activation path: scripts/setup.sh --fips) and proves the
# whole appliance runs on the validated provider:
#
#   1. Rendered-config pins (fail-fast, covers services we don't boot):
#      the five provider services get the FIPS activation env; every
#      non-provider image (matter-controller, email-indexer,
#      device-identity-svc, camera-discovery, fleet-agent) keeps the literal
#      OFF posture — the WARP-318 collateral crash-loop fix.
#   2. Boot: gateway + db + cache + broker + device-identity-svc + ai-gateway
#      + file-indexer + mcp-server + orchestrator + web-dashboard +
#      email-indexer, wait until the orchestrator's rolled-up health serves.
#   3. Per-service structured self-test lines: {"event":"fips_self_test",
#      ...,"fips":true} for orchestrator, mcp-server, ai-gateway,
#      file-indexer (web-dashboard has no boot self-test by design — its
#      posture is covered by the env render + the shared image gate).
#   4. Edge TLS (WARP-1021): gateway logs fips_edge_tls fips:true; a TLS 1.3
#      handshake negotiates AES-GCM; a ChaCha20-Poly1305-only client is
#      refused.
#   5. API smoke through the FIPS-enforcing stack: /api/llm/conversations,
#      /api/files/search/status, /api/calendar/places all 200.
#        NOTE (merged WARP-318 reality): /api/llm/conversations returning 200
#        *is* the orchestrator↔Postgres assertion — the orchestrator boots
#        FIPS-ENFORCING and still reaches `db` because that intra-compose hop
#        is plaintext today (pgvector ships no server cert; sslmode=prefer
#        falls back). The P1011 "library has no ciphers" clash documented in
#        docker-compose.yml only materializes when WARP-233 lands Postgres
#        TLS + sslmode=require; this test pins the ACTUAL current behavior,
#        not the aspirational post-WARP-233 one.
#   6. Runtime enforcement execs: MD5 must be REFUSED inside the running
#      containers in both stacks (Python _hashlib usedforsecurity=True and
#      Node crypto.createHash("md5")), and Node must report getFips()==1.
#   7. Non-provider services that we boot (device-identity-svc,
#      email-indexer) stay Running with RestartCount 0 and never emit a
#      failed self-test line.
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
BOOT_SERVICES=(gateway db cache broker device-identity-svc ai-gateway file-indexer mcp-server orchestrator web-dashboard email-indexer)
SELFTEST_SERVICES=(orchestrator mcp-server ai-gateway file-indexer)
NONPROVIDER_BOOTED=(device-identity-svc email-indexer)

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
    echo "── failure log dump (last 80 lines per service) ──"
    for svc in "${BOOT_SERVICES[@]}"; do
      echo "── $svc ──"
      compose logs --no-color --tail 80 "$svc" 2>&1 || true
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

echo ""
echo "  WARP-317 full-stack FIPS activation smoke test"
echo ""

# ── 1) Activate FIPS through the real customer path ─────────────────────────
echo "── setup.sh --fips (secrets + knob; no build, no start) ──"
./scripts/setup.sh --skip-docker --skip-drivers --skip-build --skip-start --fips --verbose
grep -qE '^DROPLET_FIPS_MODE=1$' .env || { echo "FAIL: setup.sh --fips did not write DROPLET_FIPS_MODE=1"; exit 1; }
grep -qE '^OPENSSL_CONF=/etc/ssl/openssl-fips\.cnf$' .env || { echo "FAIL: derived OPENSSL_CONF missing from .env"; exit 1; }

# The API smoke checks run without a browser session — same trick as the
# rag-tests lane (override-file env precedence is unreliable across compose
# versions, so force it in .env).
if grep -qE '^AUTH_ENABLED=' .env; then
  sed -i.bak 's/^AUTH_ENABLED=.*/AUTH_ENABLED=false/' .env && rm -f .env.bak
else
  echo "AUTH_ENABLED=false" >> .env
fi

# The gateway needs certs; fresh CI checkouts may not have run the full cert
# phase. Any self-signed pair is fine — the probes use -k / s_client.
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

echo "── waiting for orchestrator health ──"
ok=""
for _ in $(seq 1 150); do
  if curl -sf http://localhost:3000/api/orchestrator/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || { echo "FAIL: orchestrator never became healthy (300s)"; exit 1; }
echo "  ✓ orchestrator healthy"

# ── 4) fips_self_test lines, per self-testing service ───────────────────────
echo "── structured self-test log lines ──"
for svc in "${SELFTEST_SERVICES[@]}"; do
  ok=""
  for _ in $(seq 1 45); do
    if compose logs --no-color "$svc" 2>/dev/null | grep '"event":"fips_self_test"' | grep -q '"fips":true'; then ok=1; break; fi
    sleep 2
  done
  [ -n "$ok" ] || { echo "FAIL: $svc never logged fips_self_test fips:true"; exit 1; }
  echo "  ✓ $svc: fips_self_test fips:true"
done

# ── 5) Edge TLS under the FIPS cipher profile (WARP-1021) ───────────────────
echo "── edge TLS ──"
compose logs --no-color gateway | grep '"event":"fips_edge_tls"' | grep -q '"fips":true' \
  || { echo "FAIL: gateway did not log fips_edge_tls fips:true"; exit 1; }
neg="$(echo | openssl s_client -connect "127.0.0.1:${EDGE_PORT}" -brief 2>&1 || true)"
printf '%s' "$neg" | grep -qE 'Ciphersuite: TLS_AES_(128|256)_GCM_SHA(256|384)' \
  || { echo "FAIL: edge TLS did not negotiate an AES-GCM TLS 1.3 suite: $neg"; exit 1; }
if echo | openssl s_client -connect "127.0.0.1:${EDGE_PORT}" -tls1_3 \
     -ciphersuites TLS_CHACHA20_POLY1305_SHA256 -brief >/dev/null 2>&1; then
  echo "FAIL: edge TLS accepted a ChaCha20-Poly1305-only client under FIPS mode"; exit 1
fi
echo "  ✓ gateway: AES-GCM negotiated, ChaCha refused, fips_edge_tls logged"

# ── 6) API smoke through the FIPS-enforcing stack ────────────────────────────
echo "── API endpoints ──"
for ep in /api/llm/conversations /api/files/search/status /api/calendar/places; do
  ok=""
  code=""
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000${ep}" || true)"
    if [ "$code" = "200" ]; then ok=1; break; fi
    sleep 2
  done
  [ -n "$ok" ] || { echo "FAIL: ${ep} never returned 200 (last=$code)"; exit 1; }
  echo "  ✓ ${ep} → 200"
done

# ── 7) Runtime enforcement execs ─────────────────────────────────────────────
echo "── in-container MD5 refusal ──"
if compose exec -T ai-gateway python -c 'import _hashlib; _hashlib.new("md5", b"x", usedforsecurity=True)' >/dev/null 2>&1; then
  echo "FAIL: ai-gateway accepted MD5 under FIPS mode"; exit 1
fi
echo "  ✓ ai-gateway (Python/_hashlib): MD5 refused"
if ! compose exec -T orchestrator node -e '
  const c = require("crypto");
  if (c.getFips() !== 1) process.exit(1);
  try { c.createHash("md5").update("x").digest(); process.exit(1) } catch { process.exit(0) }
' >/dev/null 2>&1; then
  echo "FAIL: orchestrator getFips()!=1 or MD5 succeeded under FIPS mode"; exit 1
fi
echo "  ✓ orchestrator (Node bundled OpenSSL): getFips()==1, MD5 refused"

# ── 8) Non-provider services must not crash-loop ─────────────────────────────
echo "── non-provider services stay up ──"
for svc in "${NONPROVIDER_BOOTED[@]}"; do
  cid="$(compose ps -q "$svc")"
  [ -n "$cid" ] || { echo "FAIL: $svc has no container"; exit 1; }
  state="$(docker inspect --format '{{.RestartCount}} {{.State.Running}}' "$cid")"
  [ "$state" = "0 true" ] || { echo "FAIL: $svc restarting/stopped under FIPS mode (RestartCount Running = $state)"; exit 1; }
  if compose logs --no-color "$svc" 2>/dev/null | grep '"event":"fips_self_test"' | grep -q '"fips":false'; then
    echo "FAIL: $svc emitted a failed fips_self_test line"; exit 1
  fi
  echo "  ✓ $svc: Running, RestartCount 0, no failed self-test"
done

echo ""
echo "  PASS: full stack boots FIPS-enforcing (edge TLS restricted, provider"
echo "  services self-tested, MD5 refused at runtime, non-provider services"
echo "  pinned out of the gate and stable)."
