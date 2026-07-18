#!/usr/bin/env bash
# =============================================================================
# WARP-317 — full-stack FIPS 140-3 activation smoke test.
# =============================================================================
#
# Boots the real compose stack with the customer knob ON (DROPLET_FIPS_MODE=1,
# written by the REAL activation path: scripts/setup.sh --fips) and asserts the
# ACTUAL merged behavior of FIPS activation — not an aspirational one.
#
# ┌─ WHAT THIS TEST ASSERTS (WARP-317 found the defect; WARP-1063 fixed it) ────┐
# │ The first CI boots of this harness surfaced that under DROPLET_FIPS_MODE=1  │
# │ the two TLS-client services could not boot: constructing ANY TLS client     │
# │ raised `LIBRARY_HAS_NO_CIPHERS` (OpenSSL 0A0000A1) before a peer was even   │
# │ contacted (orchestrator: Prisma `$connect()` → P1011; ai-gateway: httpx     │
# │ `ssl.create_default_context()`), while every self-test signal still read    │
# │ "enforcing". WARP-1063's root-cause analysis: that error signature means    │
# │ the validated provider did NOT activate in the failing process — under the  │
# │ config's `default_properties = fips=yes` pin a dead provider leaves NOTHING │
# │ fetchable, so MD5 is "refused" (self-test green) and the default SSL_CTX    │
# │ has zero ciphersuites (TLS client construction dies). The old fips:true     │
# │ signals (Node getFips(), cryptography _fips_enabled, MD5-refusal) are all   │
# │ property-pin-based and cannot see a dead provider.                          │
# │                                                                             │
# │ The WARP-1063 fix this harness now guards:                                  │
# │   * docker/openssl-fips.cnf pins an explicit FIPS-approved TLS posture on   │
# │     the default context (ssl_conf/system_default: AES-GCM CipherString +    │
# │     Ciphersuites, MinProtocol TLSv1.2) matching the nginx edge profile;     │
# │   * both boot self-tests gained a POSITIVE probe — an approved digest       │
# │     (SHA-256) must WORK — so a dead provider now fails the boot with the    │
# │     real diagnosis (fips_self_test fips:false, provider-not-active reason)  │
# │     instead of an opaque downstream TLS error.                              │
# │                                                                             │
# │ This test therefore asserts, end to end:                                    │
# │   * the provider loads and enforces per service (fips_self_test fips:true — │
# │     which now implies the positive probe passed);                           │
# │   * the FULL FIPS-enforcing app boot: orchestrator healthy + the three API  │
# │     endpoints serve (TLS clients to Postgres/internal HTTP constructed);    │
# │   * the edge TLS profile restricts to AES-GCM (WARP-1021);                  │
# │   * runtime crypto is enforcing AND alive in both stacks (SHA-256 works,    │
# │     MD5 refused);                                                           │
# │   * the WARP-318 collateral fix: non-provider images never enter the FIPS   │
# │     boot gate (no fips_self_test fips:false, no FIPS-caused restart-loop).  │
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
#   EXPECT_FIPS_STACK_BOOTS=1       accepted for backward compatibility and as
#                                   the ticket-acceptance invocation — since
#                                   the WARP-1063 config fix, the full
#                                   FIPS-enforcing boot + the three API
#                                   endpoints are ALWAYS asserted (the flag is
#                                   a no-op; the pre-fix exception branch that
#                                   expected LIBRARY_HAS_NO_CIPHERS is gone)
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
# can observe at the top of their app startup.
SELFTEST_SERVICES=(orchestrator mcp-server ai-gateway)
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
#
# WARP-1063: capture the logs FIRST, then grep a herestring — never
# `compose logs | grep -q`. Under `set -o pipefail`, once the logs outgrow
# the pipe buffer grep's early exit SIGPIPEs `docker compose`, the pipeline
# reports the kill signal instead of grep's match, and the `if` discards a
# REAL match every iteration (observed locally: the fips_self_test line was
# in the logs for minutes while this loop "never" saw it; CI dodged it only
# while boot logs still fit in one pipe buffer).
wait_for_log() {
  local svc="$1" pat="$2" deadline="$3" i out
  for ((i = 0; i < deadline; i += 2)); do
    out="$(compose logs --no-color "$svc" 2>/dev/null || true)"
    if grep -qE "$pat" <<<"$out"; then return 0; fi
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
# of each service's boot, and since WARP-1063 a fips:true line also implies
# the positive probe passed (an approved digest WORKS — a dead provider now
# logs fips:false with the provider-not-active reason instead).
echo "── structured self-test log lines ──"
# 300s: the orchestrator's entrypoint runs `prisma migrate deploy` against a
# cold pgdata volume BEFORE dist/index.js (and its self-test) starts — on a
# first boot that alone can exceed two minutes on slower disks/VMs.
for svc in "${SELFTEST_SERVICES[@]}"; do
  if wait_for_log "$svc" '"event":[[:space:]]*"fips_self_test".*"fips":[[:space:]]*true' 300; then
    echo "  ✓ $svc: fips_self_test fips:true (provider active + enforcing)"
  else
    echo "FAIL: $svc never logged fips_self_test fips:true"; exit 1
  fi
done

# ── 5) Edge TLS under the FIPS cipher profile (WARP-1021) ───────────────────
echo "── edge TLS ──"
wait_for_log gateway '"event":[[:space:]]*"fips_edge_tls".*"fips":[[:space:]]*true' 120 \
  || { echo "FAIL: gateway did not log fips_edge_tls fips:true"; exit 1; }
neg="$(echo | openssl s_client -connect "127.0.0.1:${EDGE_PORT}" -brief 2>&1 || true)"
printf '%s' "$neg" | grep -qE 'Ciphersuite: TLS_AES_(128|256)_GCM_SHA(256|384)' \
  || { echo "FAIL: edge TLS did not negotiate an AES-GCM TLS 1.3 suite: $neg"; exit 1; }
if echo | openssl s_client -connect "127.0.0.1:${EDGE_PORT}" -tls1_3 \
     -ciphersuites TLS_CHACHA20_POLY1305_SHA256 -brief >/dev/null 2>&1; then
  echo "FAIL: edge TLS accepted a ChaCha20-Poly1305-only client under FIPS mode"; exit 1
fi
echo "  ✓ gateway: AES-GCM negotiated, ChaCha refused, fips_edge_tls logged"

# ── 6) Runtime enforcement execs — provider ALIVE and enforcing ─────────────
# WARP-1063: "MD5 refused" alone is also true of a DEAD provider (under the
# fips=yes property pin, a failed activation refuses everything), so each
# probe additionally requires an approved digest to WORK — enforcing AND
# alive, per libcrypto instance.
echo "── runtime enforcement (approved crypto works, MD5 refused) ──"
if ! compose exec -T mcp-server node -e '
  const c = require("crypto");
  if (c.getFips() !== 1) process.exit(1);
  try { c.createHash("sha256").update("x").digest(); } catch { process.exit(1) }
  try { c.createHash("md5").update("x").digest(); process.exit(1) } catch { process.exit(0) }
' >/dev/null 2>&1; then
  echo "FAIL: mcp-server getFips()!=1, SHA-256 unavailable, or MD5 succeeded under FIPS mode"; exit 1
fi
echo "  ✓ mcp-server (Node bundled OpenSSL): getFips()==1, SHA-256 works, MD5 refused"
# ai-gateway probes BOTH of its libcrypto instances in the production order
# (pyca cryptography's static OpenSSL first, then the system libssl) — the
# exact dual-instance shape whose collision WARP-1063 fixed.
if ! compose exec -T ai-gateway python -c '
from cryptography.hazmat.backends import default_backend
assert getattr(default_backend(), "_fips_enabled", False), "pyca not FIPS"
from cryptography.hazmat.primitives import hashes
h = hashes.Hash(hashes.SHA256()); h.update(b"x"); h.finalize()
import ssl
ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
import _hashlib
_hashlib.new("sha256", b"x", usedforsecurity=True)
try:
    _hashlib.new("md5", b"x", usedforsecurity=True)
except ValueError:
    raise SystemExit(0)
raise SystemExit(1)
' >/dev/null 2>&1; then
  echo "FAIL: ai-gateway dual-libcrypto probe failed (pyca/system not both FIPS-enforcing + alive)"; exit 1
fi
echo "  ✓ ai-gateway (pyca + system OpenSSL): both enforcing, TLS context constructible, MD5 refused"

# ── 7) Non-provider services must not enter the FIPS gate (WARP-318 fix) ─────
# The load-bearing assertion: with DROPLET_FIPS_MODE=1, NO non-provider service
# may emit a FAILED boot self-test. If a WARP-318 pin regressed, that image
# (which has no validated provider) would receive DROPLET_FIPS_REQUIRED=true,
# run the WARP-229 self-test, fail it, and log `fips_self_test fips:false`
# before restart-looping. We assert the negative across the whole booted set —
# robust to a service being down for an unrelated reason, because the pin's
# effect is "the self-test is SKIPPED", i.e. no fips line at all. (The old
# example of such a reason — the test-lane TPM perm crash-loop — is fixed and
# asserted healthy below, WARP-1248.)
echo "── non-provider services stay off the FIPS boot gate (WARP-318 fix) ──"
# Herestring greps, not `compose logs | grep -q` — same pipefail/SIGPIPE trap
# as wait_for_log (worse here: a SIGPIPE-poisoned pipeline looks like "no
# match", i.e. a silent false PASS on the load-bearing negative assertion).
all_logs="$(compose logs --no-color 2>/dev/null || true)"
if grep -qE '"event":[[:space:]]*"fips_self_test".*"fips":[[:space:]]*false' <<<"$all_logs"; then
  echo "FAIL: a service emitted fips_self_test fips:false under FIPS mode —"
  echo "      a non-provider image entered the boot gate (WARP-318 pin regressed):"
  grep -E '"event":[[:space:]]*"fips_self_test".*"fips":[[:space:]]*false' <<<"$all_logs" | head
  exit 1
fi
# And positively confirm device-identity-svc (a non-provider image we booted)
# ran WITHOUT ever hitting the gate: it must have logged NO fips_self_test line
# at all (skipped), never a fips:true (would mean it wrongly got the provider).
dis_logs="$(compose logs --no-color device-identity-svc 2>/dev/null || true)"
if grep -qE '"event":[[:space:]]*"fips_self_test"' <<<"$dis_logs"; then
  echo "FAIL: device-identity-svc ran the FIPS self-test — its pin (no provider) regressed"; exit 1
fi
echo "  ✓ no non-provider service entered the FIPS boot gate; device-identity-svc skipped it"

# ── 7b) device-identity-svc genuinely boots (WARP-1248 fix) ──────────────────
# On a fresh host dockerd auto-creates the bind-mounted /var/lib/droplet/tpm +
# /var/run/droplet as root:root, which used to fail the sidecar's first EK-cert
# write (PermissionError: ek-cert.pem.tmp) into a crash-loop — silent in green
# runs (nothing asserted its health), muddying every red run's failure dump.
# The image entrypoint now chowns the two mounts before dropping privileges.
# Assert the visible symptom stays gone AND the positive outcomes it blocked:
# provisioning completed and the gRPC socket actually exists (grpc's
# add_insecure_port fails WITHOUT raising, so the "Listening" log line alone
# proves nothing — exec and check the filesystem).
echo "── device-identity-svc boots on fresh bind mounts (WARP-1248 fix) ──"
if grep -q 'PermissionError' <<<"$dis_logs"; then
  echo "FAIL: device-identity-svc hit a PermissionError — the WARP-1248 mount-ownership fix regressed:"
  grep 'PermissionError' <<<"$dis_logs" | head
  exit 1
fi
wait_for_log device-identity-svc 'Listening on unix://' 120 \
  || { echo "FAIL: device-identity-svc never reached its serving log line"; exit 1; }
compose exec -T device-identity-svc test -f /var/lib/droplet/tpm/provisioned.json \
  || { echo "FAIL: device-identity-svc did not auto-provision (provisioned.json missing)"; exit 1; }
compose exec -T device-identity-svc test -S /var/run/droplet/device-identity.sock \
  || { echo "FAIL: device-identity-svc socket missing (unix bind failed silently)"; exit 1; }
echo "  ✓ device-identity-svc provisioned + socket bound (no tpm-dir PermissionError)"

# ── 8) The full FIPS-enforcing app boot (WARP-1063 fixed the boot block) ─────
# Always asserted since the WARP-1063 fix. EXPECT_FIPS_STACK_BOOTS=1 remains
# accepted (it was the pre-fix opt-in for these assertions and is the ticket's
# acceptance invocation) but is now a no-op — the pre-fix branch that expected
# LIBRARY_HAS_NO_CIPHERS as the documented exception is gone. If a service
# regresses into that state, the fips_self_test fips:false line (dead provider,
# WARP-1063 positive probe) or these boot assertions catch it, and the teardown
# log dump carries the diagnosis.
echo "── full FIPS-enforcing boot ──"
ok=""
for ((i = 0; i < 300; i += 2)); do
  if curl -sf http://localhost:3000/api/orchestrator/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || { echo "FAIL: orchestrator never became healthy under FIPS"; exit 1; }
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

echo ""
echo "  PASS: FIPS activates + enforces across the provider services (self-tests,"
echo "  edge TLS restriction, runtime approved-crypto + MD5-refusal probes), the"
echo "  full app boot completes with working TLS clients (WARP-1063), and"
echo "  non-provider images stay off the boot gate (WARP-318 fix)."
