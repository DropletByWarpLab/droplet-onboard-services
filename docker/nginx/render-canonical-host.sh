#!/bin/sh
# render-canonical-host.sh — write /etc/nginx/canonical-host.active.conf from
# the installed cert artifact + the DROPLET_LAN_DNS_AUTHORITY knob.
#
# Warning-free droplet.local (ADR-023 follow-through): the friendly .local/.lan
# names 307-redirect to the publicly-trusted per-device FQDN when — and only
# when — ALL of these hold (spec §2):
#   (a) DROPLET_LAN_DNS_AUTHORITY=1 (box owns the LAN's DHCP/DNS; without it
#       the FQDN is unresolvable client-side and a redirect would dead-end),
#   (b) the installed droplet.crt is NOT self-issued (bootstrap cert),
#   (c) it is unexpired,
#   (d) it carries a public (non-.local/.lan) DNS SAN — that SAN IS the
#       redirect target, so the redirect can never point at a name the served
#       cert doesn't cover.
# Anything else renders the OFF variant (status page on :80, no redirect).
#
# Runs (1) at container start via /docker-entrypoint.d/02-canonical-host.sh and
# (2) via `docker compose exec -T gateway ...` from scripts/lib/tls-reload.sh
# before every reload, so cert swaps and redirect posture change together.
#
# Test seams: DROPLET_CANONICAL_CERT / DROPLET_CANONICAL_OUT override paths.
set -eu

CERT="${DROPLET_CANONICAL_CERT:-/etc/nginx/certs/droplet.crt}"
OUT="${DROPLET_CANONICAL_OUT:-/etc/nginx/canonical-host.active.conf}"
AUTHORITY="${DROPLET_LAN_DNS_AUTHORITY:-0}"

# MUST stay in sync with scripts/lib/secrets.sh::_generate_tls_cert's SAN set
# and trust-droplet-cert.sh. tests/nginx-canonical-host.test.sh guards it.
FRIENDLY_NAMES="droplet.local droplet-ai.local droplet.lan droplet-ai.lan"

write_off() {
  cat > "$OUT.tmp" <<'EOF'
# RENDERED by render-canonical-host.sh — DO NOT EDIT (redirect: OFF)
# Warning-free droplet.local (ADR-023 follow-through): no valid publicly-
# trusted cert is installed (or this box doesn't own the LAN's DNS), so the
# friendly names serve the plain-HTTP status page — NEVER a forced HTTPS
# upgrade into the self-signed interstitial, and NEVER app content over HTTP.
# The request host is only a lookup KEY against fixed literal hostnames;
# the map's values are hardcoded literals — this IS the allowlist
# remediation the rule recommends.
# nosemgrep: generic.nginx.security.request-host-used.request-host-used
map $host $canonical_target {
    default "";
}
server {
    listen 80;
    server_name droplet.local droplet-ai.local droplet.lan droplet-ai.lan;
    root /usr/share/nginx/tls-status;
    location = /api/tls/status {
        set $upstream_orchestrator "orchestrator:3000";
        # The variable is the literal set one line up — no request data can
        # reach it (same annotated pattern as the first-party legs in
        # nginx.conf).
        # nosemgrep: generic.nginx.security.dynamic-proxy-host.dynamic-proxy-host
        proxy_pass http://$upstream_orchestrator/api/tls/status;
        # First-party Host passthrough to the orchestrator, identical to
        # every gateway leg in nginx.conf.
        # nosemgrep: generic.nginx.security.request-host-used.request-host-used
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / {
        try_files /index.html =404;
    }
}
server {
    listen 80 default_server;
    # Host-preserving HTTPS upgrade — the redirect target is the host the
    # client itself sent (pre-existing gateway behavior, moved from nginx.conf).
    # nosemgrep: generic.nginx.security.request-host-used.request-host-used
    return 301 https://$host$request_uri;
}
EOF
  mv "$OUT.tmp" "$OUT"
  echo '{"event":"canonical_host_render","gateway":"nginx","redirect":false}'
}

target=""
if [ "$AUTHORITY" = "1" ] && [ -f "$CERT" ]; then
  subj="$(openssl x509 -in "$CERT" -noout -subject 2>/dev/null | sed 's/^subject=//')" || subj=""
  iss="$(openssl x509 -in "$CERT" -noout -issuer 2>/dev/null | sed 's/^issuer=//')" || iss=""
  if [ -n "$subj" ] && [ "$subj" != "$iss" ] \
     && openssl x509 -checkend 0 -noout -in "$CERT" >/dev/null 2>&1; then
    # First DNS SAN that isn't a LAN-only name = the redirect target.
    sans="$(openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null \
      | tr ',' '\n' | sed -n 's/.*DNS://p' | tr -d ' ')"
    for san in $sans; do
      case "$san" in
        *.local|*.lan|localhost) continue ;;
      esac
      target="$san"
      break
    done
  fi
fi

# Charset defense: the SAN is written into an nginx config — reject anything
# outside hostname characters rather than trusting the cert blindly.
case "$target" in
  ''|*[!a-zA-Z0-9.-]*) write_off; exit 0 ;;
esac

{
  printf '# RENDERED by render-canonical-host.sh — DO NOT EDIT (redirect: ON -> https://%s)\n' "$target"
  # The request host is only a lookup KEY against the fixed friendly-name literals.
  # nosemgrep: generic.nginx.security.request-host-used.request-host-used
  printf 'map $host $canonical_target {\n'
  printf '    default            "";\n'
  for name in $FRIENDLY_NAMES; do
    printf '    %-18s "https://%s";\n' "$name" "$target"
  done
  printf '}\n'
  printf 'server {\n'
  printf '    listen 80 default_server;\n'
  printf '    # 307: method-preserving + non-cacheable (posture can flip OFF).\n'
  printf '    if ($canonical_target != "") {\n'
  printf '        return 307 $canonical_target$request_uri;\n'
  printf '    }\n'
  printf '    # Non-friendly hosts (the FQDN itself, IPs): plain HTTPS upgrade.\n'
  # Host-preserving upgrade — target host is the one the client sent.
  # nosemgrep: generic.nginx.security.request-host-used.request-host-used
  printf '    return 301 https://$host$request_uri;\n'
  printf '}\n'
} > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "{\"event\":\"canonical_host_render\",\"gateway\":\"nginx\",\"redirect\":true,\"target\":\"$target\"}"
