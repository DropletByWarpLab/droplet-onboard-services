#!/usr/bin/env bash
# =============================================================================
# WARP-1061 — Docker-free checks for the nginx internal-mTLS upstream scheme.
# =============================================================================
#
# The full parse test (`nginx -t` on both variants) runs inside
# docker/nginx/Dockerfile at build time. This unit test validates the
# artifacts on any box (no Docker), mirroring tests/nginx-fips.test.sh:
#   * the DEFAULT variant maps $internal_scheme to http and carries NO
#     proxy_ssl directives (OFF-path proxy posture byte-identical),
#   * the mTLS variant maps to https + presents the gateway client cert with
#     verification pinned to the internal CA,
#   * nginx.conf includes the active variant and uses $internal_scheme on the
#     three FIRST-PARTY legs only (user-plane legs stay literal http://),
#   * the entrypoint actually SELECTS the right variant from
#     DROPLET_INTERNAL_TLS (executed here against a temp dir),
#   * the Dockerfile bakes both variants + the selector and self-tests them.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NGINX_DIR="$REPO_ROOT/docker/nginx"
TESTS=0
FAILURES=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  WARP-1061 nginx internal-scheme artifact checks (no Docker)"
echo ""

# 1) DEFAULT variant: plain http scheme, zero proxy_ssl directives.
def="$NGINX_DIR/internal-scheme.default.conf"
def_directives="$(grep -vE '^[[:space:]]*#' "$def")"
if printf '%s\n' "$def_directives" | grep -q '"http"' \
   && ! printf '%s\n' "$def_directives" | grep -q 'proxy_ssl'; then
  pass "default variant keeps first-party legs plain http (no proxy_ssl)"
else
  fail "default variant diverged from the plaintext OFF posture"
fi

# 2) mTLS variant: https scheme + client cert + CA-pinned verification.
mtls="$NGINX_DIR/internal-scheme.mtls.conf"
mtls_directives="$(grep -vE '^[[:space:]]*#' "$mtls")"
if printf '%s\n' "$mtls_directives" | grep -q '"https"' \
   && printf '%s\n' "$mtls_directives" | grep -qE 'proxy_ssl_certificate[[:space:]]+/etc/nginx/service-tls/cert\.pem;' \
   && printf '%s\n' "$mtls_directives" | grep -qE 'proxy_ssl_certificate_key[[:space:]]+/etc/nginx/service-tls/key\.pem;' \
   && printf '%s\n' "$mtls_directives" | grep -qE 'proxy_ssl_trusted_certificate[[:space:]]+/etc/nginx/service-tls/ca\.pem;' \
   && printf '%s\n' "$mtls_directives" | grep -qE 'proxy_ssl_verify[[:space:]]+on;'; then
  pass "mtls variant presents the gateway client cert + verifies against the internal CA"
else
  fail "mtls variant is missing the https map or a proxy_ssl directive"
fi

# 3) nginx.conf includes the active variant; the three first-party legs use
#    $internal_scheme; user-plane legs are still literal http://.
conf="$NGINX_DIR/nginx.conf"
scheme_legs=$(grep -cE 'proxy_pass[[:space:]]+\$internal_scheme://' "$conf")
if grep -qE 'include[[:space:]]+/etc/nginx/internal-scheme\.active\.conf;' "$conf" \
   && [ "$scheme_legs" -eq 3 ]; then
  pass "nginx.conf includes internal-scheme.active.conf; 3 first-party legs use \$internal_scheme"
else
  fail "nginx.conf include/scheme-leg count wrong (got $scheme_legs \$internal_scheme legs, want 3)"
fi
# WARP-1686: the docserver leg moved out of nginx.conf into the DOCS_ENGINE
# variant pair (docs-engine.{collabora,onlyoffice}.conf — selected at container
# start, same pattern as internal-scheme itself). The invariant is unchanged —
# every user-plane leg stays literal http:// — so the docserver assertion now
# points at BOTH variants (collabora keeps the /docs prefix ⇒ no trailing
# slash on its proxy_pass; onlyoffice strips ⇒ trailing slash).
#
# WARP-1966: what this check pins is the SCHEME (literal http:// rather than
# $internal_scheme://), not the presence of a URI on proxy_pass. The nextcloud
# leg's trailing slash was incidental to that — and it was also wrong: against
# a VARIABLE upstream nginx cannot compute a prefix strip, so the URI in the
# directive replaces the request URI outright and every request under
# /nextcloud/ reached the upstream as literally `/`. That leg now strips its
# prefix with an explicit `rewrite … break` and carries no URI. The shape
# itself is guarded in nginx-nextcloud-assets.
#
# Match it INSIDE its location block rather than file-wide. The old pattern
# was unique only because of the slash; dropping the slash makes a bare
# `http://$upstream_nextcloud;` match any of the half-dozen ^~ asset legs
# too, so a regression on THIS leg would still find a match elsewhere and
# the assertion would pass while the leg it names had moved off http://.
nc_leg=$(awk '
  /^[[:space:]]*location \/nextcloud\/ \{/ { inblock = 1; next }
  inblock && /^[[:space:]]*}[[:space:]]*$/ { exit }
  inblock && /^[[:space:]]*proxy_pass/    { print }
' "$conf")
if printf '%s\n' "$nc_leg" | grep -qE '^[[:space:]]*proxy_pass[[:space:]]+http://\$upstream_nextcloud;[[:space:]]*$' \
   && grep -qE 'proxy_pass[[:space:]]+http://\$upstream_web_dashboard;' "$conf" \
   && grep -qE 'proxy_pass[[:space:]]+http://\$upstream_docserver;' "$NGINX_DIR/docs-engine.collabora.conf" \
   && grep -qE 'proxy_pass[[:space:]]+http://\$upstream_docserver/;' "$NGINX_DIR/docs-engine.onlyoffice.conf"; then
  pass "user-plane legs (nextcloud, web-dashboard, both docs-engine variants) stay literal http://"
else
  fail "a user-plane leg was moved off literal http:// (out of mTLS scope)"
fi

# 4) The entrypoint SELECTS the right variant from DROPLET_INTERNAL_TLS. Run a
#    path-rewritten copy against a sandbox and inspect the symlink (same
#    technique as tests/nginx-fips.test.sh).
entry="$NGINX_DIR/docker-entrypoint-internal-tls.sh"
run_entry() {  # $1 = DROPLET_INTERNAL_TLS value ("" = unset)
  local box; box="$(mktemp -d)"
  mkdir -p "$box/etc/nginx"
  : > "$box/etc/nginx/internal-scheme.default.conf"
  : > "$box/etc/nginx/internal-scheme.mtls.conf"
  sed "s#/etc/nginx#$box/etc/nginx#g" "$entry" > "$box/entry.sh"
  if [ -n "$1" ]; then
    DROPLET_INTERNAL_TLS="$1" sh "$box/entry.sh" >/dev/null 2>&1
  else
    env -u DROPLET_INTERNAL_TLS sh "$box/entry.sh" >/dev/null 2>&1
  fi
  readlink "$box/etc/nginx/internal-scheme.active.conf" | sed "s#$box##"
  rm -rf "$box"
}
off_target="$(run_entry 0)"
unset_target="$(run_entry "")"
on_target="$(run_entry 1)"
[ "$off_target" = "/etc/nginx/internal-scheme.default.conf" ] \
  && pass "entrypoint: DROPLET_INTERNAL_TLS=0 → active → default variant" \
  || fail "entrypoint OFF selected '$off_target' (expected default)"
[ "$unset_target" = "/etc/nginx/internal-scheme.default.conf" ] \
  && pass "entrypoint: knob unset → active → default variant" \
  || fail "entrypoint UNSET selected '$unset_target' (expected default)"
[ "$on_target" = "/etc/nginx/internal-scheme.mtls.conf" ] \
  && pass "entrypoint: DROPLET_INTERNAL_TLS=1 → active → mtls variant" \
  || fail "entrypoint ON selected '$on_target' (expected mtls)"

# 5) Dockerfile bakes both variants + selector, defaults the symlink to the
#    OFF posture, and parse-tests both variants at build time.
df="$NGINX_DIR/Dockerfile"
if grep -q 'internal-scheme.default.conf' "$df" \
   && grep -q 'internal-scheme.mtls.conf' "$df" \
   && grep -q '01-internal-scheme.sh' "$df" \
   && grep -qE 'ln -sf /etc/nginx/internal-scheme\.default\.conf /etc/nginx/internal-scheme\.active\.conf' "$df"; then
  pass "Dockerfile bakes both variants + selector, default symlink = OFF posture"
else
  fail "Dockerfile is missing an internal-scheme artifact or the default symlink"
fi
if grep -qE 'for scheme in default mtls' "$df"; then
  pass "Dockerfile self-tests both internal-scheme variants via nginx -t"
else
  fail "Dockerfile is missing the internal-scheme parse self-test"
fi

# 6) Compose wiring: the gateway passes the knob and mounts its own bundle at
#    the path the mtls variant reads.
compose="$REPO_ROOT/docker/docker-compose.yml"
if grep -qE 'DROPLET_INTERNAL_TLS=\$\{DROPLET_INTERNAL_TLS:-0\}' "$compose" \
   && grep -q 'service-tls/gateway:/etc/nginx/service-tls:ro' "$compose"; then
  pass "compose: gateway gets the knob + its service-tls bundle mount"
else
  fail "compose gateway wiring is missing the knob or the bundle mount"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "PASS tests/nginx-internal-scheme.test.sh ($TESTS checks)"
  exit 0
fi
echo "FAIL tests/nginx-internal-scheme.test.sh ($FAILURES/$TESTS failed)"
exit 1
