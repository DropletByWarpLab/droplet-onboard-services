#!/usr/bin/env bash
# Internal-DNS HTTPS redirects and trust guidance, without a fleet dependency.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGINX_DIR="$REPO_ROOT/docker/nginx"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
TESTS=0; FAILURES=0
pass() { TESTS=$((TESTS+1)); printf '  PASS %s\n' "$1"; }
fail() { TESTS=$((TESTS+1)); FAILURES=$((FAILURES+1)); printf '  FAIL %s\n' "$1"; }
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/local.key" \
  -out "$WORK/local.crt" -subj /CN=Droplet -days 2 \
  -addext subjectAltName=DNS:droplet-ai.lan,DNS:droplet.local >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/legacy.key" \
  -out "$WORK/legacy.crt" -subj /CN=Legacy -days 2 \
  -addext subjectAltName=DNS:old.devices.warp-lab.ai >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/wildcard.key" \
  -out "$WORK/wildcard.crt" -subj /CN=Droplet -days 2 \
  -addext 'subjectAltName=DNS:*.office.example' >/dev/null 2>&1
run_render() {
  DROPLET_LAN_DNS_AUTHORITY="$1" DROPLET_LAN_HOSTNAME="${3:-droplet-ai.lan}" \
    DROPLET_PUBLIC_FQDN=old.devices.warp-lab.ai \
    DROPLET_CANONICAL_CERT="$2" DROPLET_CANONICAL_OUT="$WORK/out.conf" \
    sh "$NGINX_DIR/render-canonical-host.sh" >/dev/null
  cat "$WORK/out.conf"
}
if run_render 1 "$WORK/local.crt" | grep -q 'https://droplet-ai.lan'; then
  pass 'valid self-signed local certificate enables internal DNS redirects'
else fail 'local certificate did not enable internal DNS redirect'; fi
if ! run_render 1 "$WORK/local.crt" | grep -qE '^ +droplet-ai\.lan +"https://droplet-ai\.lan"'; then
  pass 'canonical internal host serves HTTPS content without a redirect loop'
else fail 'canonical internal host redirects to itself'; fi
if run_render 1 "$WORK/wildcard.crt" box.office.example | grep -q 'https://box.office.example'; then
  pass 'wildcard SAN coverage enables the configured internal name'
else fail 'wildcard certificate coverage was ignored'; fi
if run_render 1 "$WORK/legacy.crt" | grep -q 'redirect: OFF'; then
  pass 'legacy public-only certificate cannot choose a fleet redirect target'
else fail 'legacy certificate still chooses an external redirect'; fi
if run_render 1 "$WORK/local.crt" custom.lan | grep -q 'redirect: OFF'; then
  pass 'configured name must be covered by the installed certificate'
else fail 'uncovered internal hostname enabled a redirect'; fi
if run_render 1 "$WORK/local.crt" 'bad;host' | grep -q 'redirect: OFF'; then
  pass 'unsafe configured name cannot reach nginx configuration'
else fail 'unsafe hostname reached configuration'; fi
if run_render 0 "$WORK/local.crt" | grep -q 'redirect: OFF'; then
  pass 'DNS authority gate avoids redirects on unmanaged LANs'
else fail 'authority=0 enabled internal redirect'; fi
if run_render 1 "$WORK/missing.crt" | grep -q 'redirect: OFF'; then
  pass 'missing certificate serves local trust guidance'
else fail 'missing certificate enabled redirect'; fi
if [ "$(run_render 0 "$WORK/local.crt")" = "$(cat "$NGINX_DIR/canonical-host.off.conf")" ]; then
  pass 'rendered fallback equals the baked configuration'
else fail 'baked fallback differs'; fi
if grep -q 'checkend 0' "$NGINX_DIR/render-canonical-host.sh"; then
  pass 'expired certificates cannot enable redirects'
else fail 'expiry check missing'; fi
if ! grep -qE 'proxy_pass|web-dashboard|api/tls/status' "$NGINX_DIR/canonical-host.off.conf"; then
  pass 'HTTP fallback serves guidance without dashboard content or TLS worker polling'
else fail 'HTTP fallback still proxies dashboard or certificate service'; fi
if ! grep -qE 'fetch\(|setTimeout|hqConfigured|location.reload|redirectTo' "$NGINX_DIR/tls-status/index.html" \
   && grep -q 'Trust the Droplet certificate' "$NGINX_DIR/tls-status/index.html" \
   && grep -q 'next.protocol = "https:"' "$NGINX_DIR/tls-status/index.html"; then
  pass 'trust guidance immediately links to same-host HTTPS without external polling'
else fail 'trust guidance still waits for fleet certificate issuance'; fi
if grep -q 'canonical-host.active.conf' "$NGINX_DIR/nginx.conf" \
   && grep -q 'return 307 \$canonical_target\$request_uri;' "$NGINX_DIR/nginx.conf"; then
  pass 'TLS server uses the same internal canonical target'
else fail 'canonical target not wired into TLS server'; fi
if grep -q 'DROPLET_LAN_HOSTNAME=.*droplet-ai.lan' "$REPO_ROOT/docker/docker-compose.yml"; then
  pass 'gateway receives the configured internal DNS name'
else fail 'gateway lacks internal DNS configuration'; fi
if grep -q 'render-canonical-host.sh' "$REPO_ROOT/scripts/lib/tls-reload.sh"; then
  pass 'certificate reload refreshes internal redirect configuration'
else fail 'certificate reload lacks render hook'; fi
# Guest/host-origin isolation remains despite remote relay removal.
printf 'Iface\tDestination\tGateway\neth0\t00000000\t010012AC\n' > "$WORK/routes"
DROPLET_LLM_ACCESS_ROUTES="$WORK/routes" DROPLET_LLM_ACCESS_OUT="$WORK/llm.conf" \
  DROPLET_LLM_BOX_IP=192.168.9.250 sh "$NGINX_DIR/render-llm-access.sh" >/dev/null
if grep -q '172.18.0.1.*1;' "$WORK/llm.conf" && grep -q '192.168.9.250.*1;' "$WORK/llm.conf"; then
  pass 'LLM access still refuses bridge-origin and configured host-origin traffic'
else fail 'LLM ingress source isolation changed'; fi
DROPLET_LLM_ACCESS_ROUTES="$WORK/missing" DROPLET_LLM_ACCESS_OUT="$WORK/llm.conf" \
  sh "$NGINX_DIR/render-llm-access.sh" >/dev/null
if grep -q 'default.*1;' "$WORK/llm.conf"; then
  pass 'LLM access fails closed when the gateway route cannot be read'
else fail 'LLM missing route no longer fails closed'; fi
printf '%s checks, %s failures\n' "$TESTS" "$FAILURES"
[ "$FAILURES" -eq 0 ]
