#!/bin/sh
# render-canonical-host.sh — select the configured internal DNS HTTPS name.
# A valid leaf covering DROPLET_LAN_HOSTNAME enables local redirects when the
# box owns LAN DNS. Self-signed certificates are supported; each client must
# trust the Droplet certificate. Public-only legacy certificates cannot redirect
# clients to their old fleet name. Missing/mismatched leaves show trust guidance.
# Re-rendered at container start and by tls-reload.sh after certificate changes.
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
# A missing or mismatched local certificate serves trust guidance on HTTP.
# The dashboard itself remains available only over HTTPS.
# nosemgrep: generic.nginx.security.request-host-used.request-host-used
map $host $canonical_target {
    default "";
}
server {
    listen 80;
    server_name droplet.local droplet-ai.local droplet.lan droplet-ai.lan;
    root /usr/share/nginx/tls-status;
    location / {
        try_files /index.html =404;
    }
}
server {
    listen 80 default_server;
    # Host-preserving HTTPS upgrade.
    # nosemgrep: generic.nginx.security.request-host-used.request-host-used
    return 301 https://$host$request_uri;
}
EOF
  mv "$OUT.tmp" "$OUT"
  echo '{"event":"canonical_host_render","gateway":"nginx","redirect":false}'
}

target="${DROPLET_LAN_HOSTNAME:-droplet-ai.lan}"
# Never infer a redirect destination from a legacy fleet certificate. Only the
# configured internal name may be selected, and the installed leaf must cover it.
case "$target" in
  ''|*[!a-zA-Z0-9.-]*) write_off; exit 0 ;;
esac
if [ "$AUTHORITY" != "1" ] || [ ! -f "$CERT" ] \
   || ! openssl x509 -checkend 0 -noout -in "$CERT" >/dev/null 2>&1; then
  write_off; exit 0
fi
# OpenSSL checks wildcard coverage without using the certificate as a source
# of redirect names. A mismatch can exit zero, so inspect its positive verdict.
if ! openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | grep -q 'DNS:' \
   || ! openssl x509 -in "$CERT" -noout -checkhost "$target" 2>/dev/null \
      | grep -qxF "Hostname $target does match certificate"; then
  write_off; exit 0
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
    # The canonical host itself must serve content on :443, not redirect to
    # the same URI indefinitely.
    [ "$name" != "$target" ] || continue
    printf '    %-18s "https://%s";\n' "$name" "$target"
  done
  printf '}\n'
  printf 'server {\n'
  printf '    listen 80 default_server;\n'
  printf '    # 307: method-preserving + non-cacheable (posture can flip OFF).\n'
  printf '    if ($canonical_target != "") {\n'
  printf '        return 307 $canonical_target$request_uri;\n'
  printf '    }\n'
  printf '    # Other hosts: plain HTTPS upgrade.\n'
  # Host-preserving upgrade — target host is the one the client sent.
  # nosemgrep: generic.nginx.security.request-host-used.request-host-used
  printf '    return 301 https://$host$request_uri;\n'
  printf '}\n'
} > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "{\"event\":\"canonical_host_render\",\"gateway\":\"nginx\",\"redirect\":true,\"target\":\"$target\"}"
