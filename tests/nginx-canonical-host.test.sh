#!/usr/bin/env bash
# =============================================================================
# Warning-free droplet.local — canonical-host redirect artifact + behavior
# checks (no Docker). Mirrors tests/nginx-internal-scheme.test.sh.
#
#   * render-canonical-host.sh decisions: knob off → OFF; self-signed → OFF;
#     CA-signed+valid+knob → ON with the right target; friendly/invalid SANs
#     filtered; charset defense.
#   * OFF render output is byte-identical to the baked canonical-host.off.conf.
#   * nginx.conf includes the active file, moved the :80 server out, added the
#     :443 canonical 307.
#   * Dockerfile bakes script + entrypoint + default + status page.
#   * compose passes DROPLET_LAN_DNS_AUTHORITY to the gateway.
#   * tls-reload.sh re-renders before reloading.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NGINX_DIR="$REPO_ROOT/docker/nginx"
RENDER="$NGINX_DIR/render-canonical-host.sh"
TESTS=0
FAILURES=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  nginx canonical-host redirect checks (no Docker)"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- cert fixtures -----------------------------------------------------------
# Self-signed (bootstrap-shaped): even with a public SAN it must render OFF.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/self.key" \
  -out "$WORK/self.crt" -subj "/CN=Droplet Edge Device" -days 2 \
  -addext "subjectAltName=DNS:droplet.local,DNS:d-abc123.devices.warp-lab.ai" \
  >/dev/null 2>&1

# CA-signed leaf (LE-shaped): mini root + leaf with SANs.
make_leaf() { # $1 = out cert path, $2 = subjectAltName value
  openssl req -newkey rsa:2048 -nodes -keyout "$WORK/leaf.key" \
    -out "$WORK/leaf.csr" -subj "/CN=leaf" >/dev/null 2>&1
  printf 'subjectAltName=%s\n' "$2" > "$WORK/san.cnf"
  openssl x509 -req -in "$WORK/leaf.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" \
    -CAcreateserial -days 2 -extfile "$WORK/san.cnf" -out "$1" >/dev/null 2>&1
}
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/ca.key" \
  -out "$WORK/ca.crt" -subj "/CN=Fake Root" -days 2 >/dev/null 2>&1
make_leaf "$WORK/le.crt"       "DNS:mybox.droplet-us.com"
make_leaf "$WORK/le-mixed.crt" "DNS:droplet.local,DNS:mybox.droplet-us.com"
make_leaf "$WORK/le-bad.crt"   "DNS:bad_host.droplet-us.com"

run_render() { # $1 = authority, $2 = cert path ("" = missing file)
  local out="$WORK/out.$$.conf"
  rm -f "$out"
  DROPLET_LAN_DNS_AUTHORITY="$1" \
  DROPLET_CANONICAL_CERT="${2:-$WORK/nonexistent.crt}" \
  DROPLET_CANONICAL_OUT="$out" \
    sh "$RENDER" >/dev/null 2>&1
  cat "$out" 2>/dev/null
  rm -f "$out"
}

# 1) knob=0 + valid LE-shaped cert → OFF (deployment-shape gate wins).
if run_render 0 "$WORK/le.crt" | grep -q 'redirect: OFF'; then
  pass "authority=0 renders OFF even with a CA-signed cert"
else
  fail "authority=0 did not render OFF"
fi

# 2) knob=1 + self-signed → OFF (bootstrap cert never redirects).
if run_render 1 "$WORK/self.crt" | grep -q 'redirect: OFF'; then
  pass "self-signed cert renders OFF"
else
  fail "self-signed cert did not render OFF"
fi

# 3) knob=1 + missing cert → OFF.
if run_render 1 "" | grep -q 'redirect: OFF'; then
  pass "missing cert renders OFF"
else
  fail "missing cert did not render OFF"
fi

# 4) knob=1 + CA-signed → ON; all four friendly names map to the target.
on_out="$(run_render 1 "$WORK/le.crt")"
ok=true
for name in droplet.local droplet-ai.local droplet.lan droplet-ai.lan; do
  printf '%s\n' "$on_out" | grep -qE "^[[:space:]]*${name}[[:space:]]+\"https://mybox\.droplet-us\.com\";" || ok=false
done
printf '%s\n' "$on_out" | grep -q 'return 307 \$canonical_target\$request_uri;' || ok=false
printf '%s\n' "$on_out" | grep -q 'return 301 https://\$host\$request_uri;' || ok=false
if [ "$ok" = true ]; then
  pass "CA-signed cert renders ON: 4 friendly names → 307 target, others → 301 upgrade"
else
  fail "ON render is missing a friendly-name mapping or the 307/301 returns"
fi

# 5) friendly SANs are filtered out of target selection.
if run_render 1 "$WORK/le-mixed.crt" | grep -q '"https://mybox.droplet-us.com"'; then
  pass "target selection skips .local/.lan SANs"
else
  fail "target selection picked a friendly SAN (or none)"
fi

# 6) charset defense: a SAN with an nginx-unsafe character renders OFF.
if run_render 1 "$WORK/le-bad.crt" | grep -q 'redirect: OFF'; then
  pass "unsafe SAN charset renders OFF (config-injection defense)"
else
  fail "unsafe SAN was rendered into the config"
fi

# 7) OFF render output is byte-identical to the baked default variant.
if [ "$(run_render 0 "$WORK/le.crt")" = "$(cat "$NGINX_DIR/canonical-host.off.conf")" ]; then
  pass "OFF render is byte-identical to canonical-host.off.conf"
else
  fail "OFF render drifted from canonical-host.off.conf"
fi

# 8) the render script uses checkend (expiry gate) — not constructible as a
#    fixture with `openssl x509 -req`, so assert the artifact.
if grep -q 'checkend 0' "$RENDER"; then
  pass "render script gates on cert expiry (openssl -checkend 0)"
else
  fail "render script is missing the expiry gate"
fi

# 9) OFF variant: status page served ONLY on friendly hosts, one proxy leg,
#    no app proxying over HTTP.
off="$NGINX_DIR/canonical-host.off.conf"
if grep -qE 'server_name[[:space:]]+droplet\.local[[:space:]]+droplet-ai\.local[[:space:]]+droplet\.lan[[:space:]]+droplet-ai\.lan;' "$off" \
   && grep -q 'root /usr/share/nginx/tls-status;' "$off" \
   && [ "$(grep -c 'proxy_pass' "$off")" -eq 1 ] \
   && grep -q 'orchestrator:3000' "$off" \
   && ! grep -q 'web-dashboard' "$off"; then
  pass "OFF variant: status page + single /api/tls/status leg, no app over HTTP"
else
  fail "OFF variant server blocks are wrong"
fi

# --- Wiring checks (fail until Tasks 3-4 land; listed here so one file guards
# --- the whole feature) -------------------------------------------------------
conf="$NGINX_DIR/nginx.conf"
if grep -qE 'include[[:space:]]+/etc/nginx/canonical-host\.active\.conf;' "$conf" \
   && grep -q 'return 307 \$canonical_target\$request_uri;' "$conf"; then
  pass "nginx.conf includes canonical-host.active.conf + :443 canonical 307"
else
  fail "nginx.conf is missing the include or the :443 canonical 307"
fi
# the old bare :80 server must be GONE from nginx.conf (moved into the variants)
if [ "$(grep -c 'listen 80' "$conf")" -eq 0 ]; then
  pass "nginx.conf no longer declares its own :80 server (moved to variants)"
else
  fail "nginx.conf still has a :80 server — friendly hosts would be forced to HTTPS"
fi

df="$NGINX_DIR/Dockerfile"
if grep -q 'render-canonical-host.sh' "$df" \
   && grep -q '02-canonical-host.sh' "$df" \
   && grep -q 'canonical-host.off.conf /etc/nginx/canonical-host.active.conf' "$df" \
   && grep -q 'tls-status/index.html' "$df"; then
  pass "Dockerfile bakes render script + entrypoint + OFF default + status page"
else
  fail "Dockerfile is missing a canonical-host artifact"
fi

compose="$REPO_ROOT/docker/docker-compose.yml"
if grep -qE 'DROPLET_LAN_DNS_AUTHORITY=\$\{DROPLET_LAN_DNS_AUTHORITY:-0\}' "$compose"; then
  pass "compose: gateway gets DROPLET_LAN_DNS_AUTHORITY (default 0)"
else
  fail "compose gateway is missing the DROPLET_LAN_DNS_AUTHORITY knob"
fi

if grep -q 'render-canonical-host.sh' "$REPO_ROOT/scripts/lib/tls-reload.sh"; then
  pass "tls-reload.sh re-renders the canonical-host include before reloading"
else
  fail "tls-reload.sh is missing the render hook"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "PASS tests/nginx-canonical-host.test.sh ($TESTS checks)"
  exit 0
fi
echo "FAIL tests/nginx-canonical-host.test.sh ($FAILURES/$TESTS failed)"
exit 1
