#!/usr/bin/env bash
# =============================================================================
# WARP-1688 — gateway routing for the Nextcloud asset namespaces the embedded
# editor loads.
# =============================================================================
#
# The dashboard iframes the richdocuments editor page from the DASHBOARD's
# origin. That page emits ROOT-ABSOLUTE URLs for everything it needs — measured
# from the rendered page on the box:
#
#   /apps/…                      richdocuments, theming, firstrunwizard assets
#   /core/…                      core css/js/img
#   /dist/core-common.js         the bundled core chunks
#   /index.php/apps/richdocuments/…   the editor's own dynamic endpoints
#   /index.php/apps/theming/…         theming (css variables, favicon)
#
# None of those were routed at the gateway: probing them at the gateway root
# returned 404/307, so the iframe rendered an unstyled, script-less page.
#
# TIGHT SCOPE, decided deliberately: the whole `/index.php/` leg is NOT routed.
# Nextcloud's dynamic surface IS live behind it (verified: `/index.php/login`
# → 200), so routing all of it would publish Nextcloud's login/settings/admin
# UI at the dashboard's own origin. Only the two dynamic prefixes the editor
# actually needs are exposed.
#
# Phase 7 (WARP-3053 / WARP-3318) pins the opposite kind of route: the OCS
# sharing API, and the other OCS routes that mint a bearer-style URL
# (richdocuments direct editing, files directEditing, dav direct download),
# under /nextcloud/ are DENIED at the gateway, so an app password cannot mint
# public links or credential-free URLs to company files.
#
# These checks need no Docker. The authoritative PARSE gate is the nginx image
# build (docker/nginx/Dockerfile runs `nginx -t` on the real config — asserted
# in phase 5 below); this file guards the routing SHAPE, which a parse check
# cannot see.
#
# Runtime: < 2 seconds.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
CONF="$REPO_ROOT_REAL/docker/nginx/nginx.conf"
NGINX_DIR="$REPO_ROOT_REAL/docker/nginx"   # nginx.conf AND every conf it includes
DOCKERFILE="$REPO_ROOT_REAL/docker/nginx/Dockerfile"
TESTS=0
FAILURES=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================="
echo "  WARP-1688 — nginx Nextcloud asset-namespace routing"
echo "  ================================================="
echo ""

if [ -f "$CONF" ]; then
  pass "docker/nginx/nginx.conf exists"
else
  fail "docker/nginx/nginx.conf missing at $CONF"; echo "FAILURES=$FAILURES"; exit 1
fi

# The exact prefixes the editor page emits. `/dist/` is included: it is NOT in
# the original ticket text but the rendered page loads /dist/core-common.js, so
# leaving it out ships a broken editor.
ASSET_PREFIXES=(
  "/apps/"
  "/core/"
  "/dist/"
  "/index.php/apps/richdocuments/"
  "/index.php/apps/theming/"
)

# location_body <prefix> — print the body of `location ^~ <prefix> { … }`.
location_body() {
  awk -v want="location ^~ $1 {" '
    index($0, want) { inblock = 1; next }
    inblock && /^[[:space:]]*}[[:space:]]*$/ { exit }
    inblock { print }
  ' "$CONF"
}

echo "--- Phase 1: each asset namespace is routed to the nextcloud upstream ---"

for prefix in "${ASSET_PREFIXES[@]}"; do
  if grep -qF "location ^~ $prefix {" "$CONF"; then
    pass "location ^~ $prefix exists (prefix-priority match)"
  else
    fail "location ^~ $prefix is missing — the editor iframe loads it root-absolute and would 404"
    continue
  fi

  body="$(location_body "$prefix")"

  # Same variable-driven, per-request Docker-DNS resolution as every other leg.
  if grep -qE 'set \$upstream_nextcloud[[:space:]]+"nextcloud:80";' <<<"$body"; then
    pass "  $prefix sets \$upstream_nextcloud (per-request DNS re-resolution)"
  else
    fail "  $prefix does not set \$upstream_nextcloud like the other legs"
  fi

  # NO URI on proxy_pass: Nextcloud serves these at its OWN root, so the prefix
  # must be forwarded UNSTRIPPED. A trailing slash here would not "strip /apps/"
  # — against a variable upstream it sends every one of these requests upstream
  # as literally `/` (WARP-1966, guarded file-wide in Phase 3).
  if grep -qE '^[[:space:]]*proxy_pass http://\$upstream_nextcloud;[[:space:]]*$' <<<"$body"; then
    pass "  $prefix forwards the prefix UNSTRIPPED (no trailing slash on proxy_pass)"
  else
    fail "  $prefix must use 'proxy_pass http://\$upstream_nextcloud;' with NO trailing slash — Nextcloud expects these at its own root"
  fi

  for hdr in 'Host \$host' 'X-Real-IP \$remote_addr' \
             'X-Forwarded-For \$proxy_add_x_forwarded_for' 'X-Forwarded-Proto \$scheme'; do
    if grep -qE "proxy_set_header[[:space:]]+$hdr;" <<<"$body"; then
      pass "  $prefix sets proxy_set_header ${hdr%% *}"
    else
      fail "  $prefix is missing proxy_set_header ${hdr%% *} (diverges from every other gateway leg)"
    fi
  done

  # ── Semgrep suppressions (the CI gate is DIFF-SCOPED) ──
  #
  # The semgrep leg (`ci.yml`, WARP-2481) scans with `--baseline-commit
  # <merge-base>`, so the identical
  # patterns in the pre-existing legs are INVISIBLE to it while these new lines
  # are not. "The leg above does the same thing and is fine" is therefore not
  # evidence — every new leg needs its own annotation, in the house style:
  # justification prose, then the `# nosemgrep:` line, then the directive.
  for rule in dynamic-proxy-host.dynamic-proxy-host \
              request-host-used.request-host-used; do
    if grep -qF "# nosemgrep: generic.nginx.security.$rule" <<<"$body"; then
      pass "  $prefix carries the ${rule%%.*} suppression"
    else
      fail "  $prefix is missing '# nosemgrep: generic.nginx.security.$rule' — the diff-scoped semgrep gate blocks the PR without it"
    fi
  done

  # A bare suppression is not acceptable: the line above each one must be a
  # justification comment, not another nosemgrep and not the directive itself.
  bare=$(printf '%s\n' "$body" | awk '
    /# nosemgrep:/ { if (prev !~ /^[[:space:]]*#/ || prev ~ /# nosemgrep:/) print NR }
    { prev = $0 }
  ')
  if [ -z "$bare" ]; then
    pass "  $prefix: every suppression is preceded by a justification comment"
  else
    fail "  $prefix: bare suppression with no justification above it (line(s) $bare in block)"
  fi

  # THE TRAP, pinned: `request-host-used` matches GENERIC text, so spelling the
  # Host variable in the justification PROSE trips the rule on the comment line
  # — above the suppression, which therefore cannot cover it. Measured: doing
  # exactly that produced 5 fresh blocking findings while the directives were
  # clean. The variable may appear ONCE per leg: on the directive.
  host_var_lines=$(printf '%s\n' "$body" | grep -cF '$host' || true)
  if [ "$host_var_lines" = "1" ]; then
    pass "  $prefix: the Host variable appears only on the directive, never in the prose"
  else
    fail "  $prefix: the Host variable appears on $host_var_lines lines — prose mentioning it self-trips request-host-used on a line no suppression can cover"
  fi
done

echo "--- Phase 1b: the Host variable never appears in PROSE (file-wide) ---"

# The per-leg check above only covers the five new blocks. This is the same
# invariant across the WHOLE file, because the trap bit twice: once in the legs'
# justification comments, and again in the explanatory note above the dashboard
# catch-all, where quoting the directive inside a sentence produced a fresh
# blocking finding on the comment line itself.
#
# `request-host-used` matches GENERIC text, so ANY line carrying the Host
# variable is a finding — a comment cannot be covered by a `# nosemgrep:` line
# beneath it, because the finding lands above the suppression. The rule is
# therefore simple and absolute: that token may appear ONLY on a real
# `proxy_set_header` directive line.
prose_hits=""
while IFS=: read -r lineno _; do
  [ -n "$lineno" ] || continue
  if ! grep -qE '^[[:space:]]*proxy_set_header (Host|X-Forwarded-Host) \$host;$' \
       <<<"$(sed -n "${lineno}p" "$CONF")"; then
    prose_hits="$prose_hits $lineno"
  fi
done <<EOF
$(grep -n 'Host \$host' "$CONF")
EOF
if [ -z "$prose_hits" ]; then
  pass "the Host variable appears only on proxy_set_header directives, never in prose"
else
  fail "the Host variable appears in non-directive (comment) text at line(s):$prose_hits — that self-trips request-host-used on a line no suppression can cover"
fi

echo "--- Phase 2: ordering — every asset leg precedes the catch-all ---"

# READABILITY, not correctness. An earlier version of this file claimed the
# catch-all would 'swallow' a leg declared after it — that model is WRONG.
# nginx prefix locations are ORDER-INDEPENDENT: the longest matching prefix
# wins regardless of declaration order, and `^~` additionally short-circuits
# the regex phase. `location /` can never take a request that `^~ /apps/`
# matches, wherever either sits in the file.
#
# The assertion is kept anyway because the house convention is specific-first
# and a leg that drifts below the catch-all is a review smell worth catching —
# but nobody should read this and think it is preventing a routing bug.

# The dashboard catch-all is the one in the HTTPS server. nginx.conf carries
# more than one `server {}` (WARP-2903 added the compose-internal :9981
# docs-discovery listener above it, with its own `location /` 404), so the
# FIRST `location /` in the file is no longer the right one — anchor on the
# `listen 443 ssl;` line and take the first catch-all after it.
HTTPS_LINE=$(grep -nE '^[[:space:]]*listen 443 ssl;' "$CONF" | head -1 | cut -d: -f1)
CATCHALL_LINE=$(awk -v start="${HTTPS_LINE:-0}" 'NR > start && /^[[:space:]]*location \/ \{/ { print NR; exit }' "$CONF")
if [ -n "$CATCHALL_LINE" ]; then
  pass "found the dashboard catch-all 'location /' at line $CATCHALL_LINE (in the :443 server, after line ${HTTPS_LINE:-?})"
else
  fail "could not find the dashboard catch-all 'location /'"
fi

for prefix in "${ASSET_PREFIXES[@]}"; do
  line=$(grep -nF "location ^~ $prefix {" "$CONF" | head -1 | cut -d: -f1)
  if [ -n "$line" ] && [ -n "$CATCHALL_LINE" ] && [ "$line" -lt "$CATCHALL_LINE" ]; then
    pass "$prefix (line $line) is declared before the catch-all"
  else
    fail "$prefix must be declared BEFORE 'location /' or the dashboard swallows it"
  fi
done

echo "--- Phase 3: the tight scope holds (no whole-/index.php/ leg) ---"

# Explicitly rejected design: routing all of /index.php/. Nextcloud's dynamic
# surface is live behind it (/index.php/login → 200), so a blanket leg would
# publish NC's login/settings/admin UI at the dashboard's origin.
#
# The guard has to cover every SHAPE that reintroduces it, not just the one
# spelling we happened to reject:
#   location /index.php/        prefix, with or without ^~
#   location /index.php         NO trailing slash — matches MORE, /index.phpfoo
#                               included
#   location ~ ^/index\.php/    regex form (and ~* case-insensitive)
# A guard that only knows one spelling is a guard that will be walked around.
blanket_hits=""
if grep -qE '^[[:space:]]*location[[:space:]]+(\^~[[:space:]]+)?/index\.php/?[[:space:]]*\{' "$CONF"; then
  blanket_hits="$blanket_hits prefix-form"
fi
# Any REGEX location mentioning php at all. Deliberately broader than
# `^/index\.php/`: `location ~ \.php$` reintroduces exactly the same exposure by
# a different spelling. This gateway proxies everything and runs no fastcgi, so
# there is no legitimate php regex leg for this to false-positive on.
if grep -qE '^[[:space:]]*location[[:space:]]+~\*?[[:space:]]+[^{]*php' "$CONF"; then
  blanket_hits="$blanket_hits regex-form"
fi
if [ -z "$blanket_hits" ]; then
  pass "no blanket /index.php leg in any form (prefix, slash-less, or regex)"
else
  fail "a blanket /index.php leg exists ($blanket_hits) — that publishes Nextcloud's login/settings/admin surface at the dashboard origin (explicitly rejected scope)"
fi

# What is genuinely UNREACHABLE at this origin: paths under /index.php/ that are
# not one of the two allowed editor prefixes. `/apps/files` is deliberately NOT
# in this list — see the note below; it IS reachable, and claiming otherwise
# would be a guard that lies.
for denied in /index.php/login /index.php/settings /index.php/apps/files; do
  case "$denied" in
    /index.php/apps/richdocuments/*|/index.php/apps/theming/*)
      fail "$denied is inside an allowed editor prefix — the denied list is wrong"
      continue
      ;;
  esac
  if grep -qF "location ^~ $denied" "$CONF"; then
    fail "$denied is routed explicitly — Nextcloud's own UI must stay unreachable at this origin"
  else
    pass "$denied is not routed (no /index.php/ leg reaches it)"
  fi
done

# HONESTY, not enforcement (WARP-1688 review C2). `^~ /apps/` is a
# WHOLE-NAMESPACE leg, so /apps/files IS routed to Nextcloud — the earlier
# version of this test grepped for an explicit `location ^~ /apps/files` leg,
# found none, and printed "/apps/files is NOT routed", which was simply false.
# A guard that does not guard is worse than no guard.
#
# What is true: reaching it still requires Nextcloud's own authn (measured:
# /apps/files/ → 401), and the exposure delta is ZERO — every one of those paths
# was already reachable at /nextcloud/apps/… on the same origin and cookie
# scope, because the /nextcloud/ leg strips its prefix and Nextcloud believes
# its webroot is /. Narrowing these legs (e.g. a static-file-extension regex) is
# tracked separately; it is a real tightening, not a fix for a hole this PR
# opened.
if grep -qE '^[[:space:]]*location \^~ /apps/ \{' "$CONF"; then
  pass "/apps/ is a whole-namespace leg (so /apps/files IS routed — NC authn still applies; zero delta vs the pre-existing /nextcloud/ leg)"
else
  fail "the /apps/ leg changed shape — re-check what this test claims about /apps/files"
fi

# ── WARP-1966: the /nextcloud/ leg strips its prefix with a REWRITE ──
#
# This guard used to assert the OPPOSITE — that `proxy_pass
# http://$upstream_nextcloud/;` (trailing slash) was the correct
# prefix-stripping shape, and it failed the build if the slash was removed. It
# encoded the bug as an invariant, on a belief that is only true for a LITERAL
# upstream: a trailing slash strips the location prefix when nginx can compute
# the replacement, but with a VARIABLE upstream it cannot, and its documented
# fallback is that the URI in the directive replaces the request URI outright.
#
# So that leg sent EVERY request under /nextcloud/ upstream as literally `/`.
# Measured on the box: GET /nextcloud/index.php/apps/richdocuments/direct/<tok>
# arrived at Nextcloud's Apache as `GET /` and 302'd to the login page, while
# the same path through the no-URI `^~ /index.php/apps/richdocuments/` leg
# arrived intact. Not a syntax error, so `nginx -t` (Phase 5) could never see
# it — which is exactly why it needs a shape guard here.
NC_BODY="$(awk '
  /^[[:space:]]*location \/nextcloud\/ \{/ { inblock = 1; next }
  inblock && /^[[:space:]]*}[[:space:]]*$/ { exit }
  inblock { print }
' "$CONF")"

if [ -n "$NC_BODY" ]; then
  pass "found the location /nextcloud/ leg"
else
  fail "location /nextcloud/ is missing — the whole Nextcloud proxy leg is gone"
fi

if grep -qE '^[[:space:]]*rewrite \^/nextcloud/\(\.\*\)\$ /\$1 break;[[:space:]]*$' <<<"$NC_BODY"; then
  pass "the /nextcloud/ leg strips its prefix with an explicit 'rewrite … break'"
else
  fail "the /nextcloud/ leg must strip its prefix with 'rewrite ^/nextcloud/(.*)\$ /\$1 break;' — a trailing slash on proxy_pass cannot do it against a variable upstream"
fi

if grep -qE '^[[:space:]]*proxy_pass http://\$upstream_nextcloud;[[:space:]]*$' <<<"$NC_BODY"; then
  pass "the /nextcloud/ leg's proxy_pass carries NO URI (the rewrite owns the path)"
else
  fail "the /nextcloud/ leg's proxy_pass must be 'http://\$upstream_nextcloud;' with no URI — a URI on a variable upstream REPLACES the request path with itself"
fi

# ── EVERY conf: a variable upstream may never carry a BARE `/` URI ──
#
# WARP-1986. The predecessor of this check called itself "file-wide" and
# grepped $CONF — nginx.conf alone. That file `include`s six siblings
# (internal-scheme.*, canonical-host.*, cipher-profile.*, docs-engine.*), none
# of which were scanned, so docs-engine.onlyoffice.conf carried the identical
# defect through a guard whose pass message claimed the file was covered. A
# guard that names a scope it does not have is worse than no guard: it is read
# as evidence.
#
# WHY BARE `/` SPECIFICALLY, and not any URI. With a variable upstream nginx
# cannot compute the prefix replacement, so the directive's URI REPLACES the
# request URI. When that URI is `/`, every path under the location collapses to
# root — the broken prefix-strip idiom. When it is a specific path under an
# exact-match location it is a deliberate pin and correct:
# canonical-host.off.conf legitimately has
# `location = /api/tls/status` -> `proxy_pass http://$upstream_orchestrator/api/tls/status;`
# where the substitution is a no-op. Flagging every URI would red-light that
# and the guard would be turned off.
bare_uri_hits=""
_scanned=0
for _cf in "$NGINX_DIR"/*.conf; do
  _scanned=$((_scanned + 1))
  _h=$(grep -nE '^[[:space:]]*proxy_pass[[:space:]]+[a-z$][^;]*\$[A-Za-z_][A-Za-z0-9_]*/;[[:space:]]*$' "$_cf" || true)
  [ -z "$_h" ] || bare_uri_hits="$bare_uri_hits $(basename "$_cf"):$(printf '%s' "$_h" | cut -d: -f1 | tr '
' ',')"
done
if [ -z "$bare_uri_hits" ]; then
  pass "no proxy_pass in ANY gateway conf combines a variable upstream with a bare '/' URI"
else
  fail "variable upstream + bare '/' URI at:$bare_uri_hits — nginx replaces the request URI with '/', so EVERY request under that location reaches the upstream as root. Strip the prefix with 'rewrite … break' and drop the URI."
fi

# The scan must actually cover the siblings, not just nginx.conf — that blind
# spot IS the bug this phase exists for. Counted from the loop's own iterations,
# NOT by listing the directory: an earlier draft did the latter and still
# reported "covers all 8 confs" after the loop was narrowed back to one file, so
# the assertion could not detect the regression it was written to catch.
if [ "${_scanned:-0}" -ge 5 ]; then
  pass "the shape scan covers all $_scanned confs under docker/nginx/ (nginx.conf plus its includes)"
else
  fail "the shape scan saw only ${_scanned:-0} conf file(s) — it is not covering the included variants"
fi

# Both docs-engine variants strip their prefix the way that actually works.
for _v in collabora onlyoffice; do
  _f="$NGINX_DIR/docs-engine.$_v.conf"
  [ -f "$_f" ] || { fail "docs-engine.$_v.conf is missing"; continue; }
  if grep -qE '^[[:space:]]*proxy_pass[[:space:]]+http://\$upstream_docserver;[[:space:]]*$' "$_f"; then
    pass "docs-engine.$_v.conf proxy_pass carries no URI"
  else
    fail "docs-engine.$_v.conf must use 'proxy_pass http://\$upstream_docserver;' with no URI"
  fi
done
# Only the onlyoffice variant needs a rewrite: coolwsd's net.service_root keeps
# the /docs prefix, so collabora must NOT strip it.
if grep -qE '^[[:space:]]*rewrite \^/docs/\(\.\*\)\$ /\$1 break;' "$NGINX_DIR/docs-engine.onlyoffice.conf"; then
  pass "docs-engine.onlyoffice.conf strips /docs/ with an explicit rewrite"
else
  fail "docs-engine.onlyoffice.conf must strip /docs/ with 'rewrite ^/docs/(.*)\$ /\$1 break;' — the Document Server serves at its root"
fi
if grep -qE '^[[:space:]]*rewrite \^/docs/' "$NGINX_DIR/docs-engine.collabora.conf"; then
  fail "docs-engine.collabora.conf strips /docs/ — coolwsd's net.service_root EXPECTS that prefix; stripping it breaks the collabora engine"
else
  pass "docs-engine.collabora.conf leaves /docs/ intact (coolwsd expects the prefix)"
fi

echo "--- Phase 3c: the WebDAV Destination header follows the rewrite (WARP-1990) ---"

# A `rewrite` edits the REQUEST LINE only. WebDAV MOVE/COPY carry their target
# as an absolute URL in the Destination header, and paired clients are handed a
# /nextcloud-prefixed base, so without this the header keeps a prefix the
# request line no longer has and Sabre answers Forbidden — renames fail while
# GET/PUT/PROPFIND work, which reads as a client bug rather than routing.
if grep -qE '^[[:space:]]*map \$http_destination \$dav_destination \{' "$CONF"; then
  pass "the \$dav_destination map exists at http level"
else
  fail "no \$http_destination map — WebDAV MOVE/COPY through /nextcloud/ will 403 on every rename"
fi

# The default branch is what leaves a non-DAV request (and an already-correct
# Destination) alone. Without it the map yields "" and nginx DROPS the header.
if grep -qE '^[[:space:]]*default[[:space:]]+\$http_destination;' <<<"$(sed -n '/map \$http_destination/,/^[[:space:]]*}/p' "$CONF")"; then
  pass "the map passes an unprefixed Destination through unchanged (default branch)"
else
  fail "the map has no 'default \$http_destination' — a Destination without the prefix would be dropped, breaking MOVE for clients that never had it"
fi

if grep -qE '^[[:space:]]*proxy_set_header Destination \$dav_destination;' <<<"$NC_BODY"; then
  pass "the /nextcloud/ leg rewrites the Destination header"
else
  fail "the /nextcloud/ leg strips the prefix from the request line but not from Destination — MOVE/COPY will 403"
fi

# Scoped: no other leg strips a prefix, so no other leg may touch this header.
_dest_legs=$(grep -c 'proxy_set_header Destination' "$CONF" || true)
if [ "${_dest_legs:-0}" = "1" ]; then
  pass "exactly one leg rewrites Destination (the only one that strips a prefix)"
else
  fail "Destination is rewritten on ${_dest_legs} legs — only /nextcloud/ strips a prefix, so only it should"
fi

echo "--- Phase 4: no collision with a dashboard surface ---"

# Read the REAL route tree instead of restating a hardcoded list that drifts the
# first time someone adds a surface. Every top-level directory under the app
# router is a route segment the dashboard owns; none may be shadowed by an
# asset leg. Route groups `(name)` and private `_dirs` are not URL segments, so
# they are skipped.
APP_DIR="$REPO_ROOT_REAL/apps/web-dashboard/src/app"
collision=""
checked=0
if [ -d "$APP_DIR" ]; then
  for entry in "$APP_DIR"/*/; do
    [ -d "$entry" ] || continue
    surface=$(basename "$entry")
    case "$surface" in
      \(*\)|_*) continue ;;
    esac
    checked=$((checked + 1))
    for prefix in "${ASSET_PREFIXES[@]}"; do
      case "/$surface/" in
        "$prefix"*) collision="$collision /$surface(vs $prefix)" ;;
      esac
    done
  done
  # Plus the gateway legs and Next.js asset root, which are not app-router dirs.
  for surface in _next api ai docs nextcloud; do
    checked=$((checked + 1))
    for prefix in "${ASSET_PREFIXES[@]}"; do
      case "/$surface/" in
        "$prefix"*) collision="$collision /$surface(vs $prefix)" ;;
      esac
    done
  done
else
  fail "dashboard app router not found at $APP_DIR — cannot check for route collisions"
fi

if [ "$checked" -eq 0 ]; then
  fail "no dashboard surfaces were checked — the collision test would pass vacuously"
elif [ -n "$collision" ]; then
  fail "asset leg shadows dashboard/gateway surface(s):$collision"
else
  pass "no asset leg shadows any of the $checked real dashboard/gateway surfaces"
fi

echo "--- Phase 5: the config is parse-gated at image build ---"

# nginx.conf itself had NO parse gate: the Dockerfile self-tests each INCLUDE
# variant in a throwaway config, but skipped the full config because the TLS
# certs are runtime volume mounts. Adding locations directly to nginx.conf
# therefore shipped unparsed. The gate stages a throwaway cert at the expected
# path and runs `nginx -t` on the REAL config.
if grep -qE 'nginx -t([[:space:]]*;|[[:space:]]*$|[[:space:]]+-c /etc/nginx/nginx.conf)' "$DOCKERFILE" \
   || grep -qF 'nginx -t -c /etc/nginx/nginx.conf' "$DOCKERFILE"; then
  pass "Dockerfile runs nginx -t against the REAL /etc/nginx/nginx.conf"
else
  fail "Dockerfile never parses the full nginx.conf — a syntax error in a location block would ship"
fi

if grep -qF '/etc/nginx/certs/droplet.crt' "$DOCKERFILE"; then
  pass "Dockerfile stages a throwaway cert at the runtime cert path for the parse"
else
  fail "Dockerfile does not stage the certs the full-config parse needs"
fi

# NOTE: there is deliberately no brace-balance / directive-terminator phase.
# Counting braces over a file this comment-dense red-lights CI on one future
# `{` in prose, with a misleading message, and the terminator loop it sat
# beside passed vacuously for any leg that did not exist. `nginx -t` on the
# REAL config is the actual syntax gate — it runs in the image build, and
# Phase 5 above asserts that gate is still wired.

echo ""
echo "--- Phase 6: security headers survive every add_header (WARP-3193 SEC-DATA-8) ---"
# nginx inherits add_header only into a location that declares NONE of its own,
# so a location that adds any header must also include one of the two shared
# sets, or it silently drops HSTS / anti-framing. The Nextcloud legs take the
# upstream (HSTS-only) set: Nextcloud sends its own CSP and framing headers.

if grep -qE '^[[:space:]]*server_tokens off;' "$CONF"; then
  pass "server_tokens off"
else
  fail "server_tokens is not switched off"
fi

for f in security-headers.conf security-headers.upstream.conf; do
  if [ -f "$NGINX_DIR/$f" ] && grep -qF "COPY docker/nginx/$f" "$DOCKERFILE"; then
    pass "$f exists and is copied into the image"
  else
    fail "$f missing or not COPYed by the Dockerfile"
  fi
done

UNGUARDED=$(awk '
  /^[[:space:]]*location[[:space:]].*\{[[:space:]]*$/ { inloc = 1; name = $0; hdr = 0; inc = 0; next }
  inloc && /^[[:space:]]*add_header[[:space:]]/ { hdr = 1 }
  inloc && /include \/etc\/nginx\/security-headers(\.upstream)?\.conf;/ { inc = 1 }
  inloc && /^[[:space:]]*}[[:space:]]*$/ { if (hdr && !inc) print name; inloc = 0 }
' "$CONF" "$NGINX_DIR"/docs-engine.*.conf)
if [ -z "$UNGUARDED" ]; then
  pass "every location with its own add_header includes a security-headers set"
else
  fail "location(s) with add_header but no security-headers include: $UNGUARDED"
fi

for prefix in "${ASSET_PREFIXES[@]}"; do
  if location_body "$prefix" | grep -qF 'include /etc/nginx/security-headers.upstream.conf;'; then
    pass "$prefix keeps Nextcloud's own framing/CSP (upstream header set)"
  else
    fail "$prefix does not include security-headers.upstream.conf"
  fi
done
for f in "$NGINX_DIR"/docs-engine.*.conf; do
  if grep -qF 'include /etc/nginx/security-headers.upstream.conf;' "$f"; then
    pass "$(basename "$f") keeps the engine's own framing/CSP (upstream header set)"
  else
    fail "$(basename "$f") does not include security-headers.upstream.conf"
  fi
done

echo ""
echo "--- Phase 7: the OCS sharing API and bearer-URL routes are denied under /nextcloud/ (WARP-3053, WARP-3318) ---"
# Every user's Nextcloud password equals their Droplet password and app
# passwords (device pairing, the personal Finder / File Explorer drive) are
# full-scope, so through /nextcloud/ any member or guest could call Nextcloud's
# own share endpoint and publish company files, skipping the owner/admin-only
# rule the web app enforces in the orchestrator. The gateway refuses it.
SHARING_PREFIXES=(
  "/nextcloud/ocs/v1.php/apps/files_sharing"
  "/nextcloud/ocs/v2.php/apps/files_sharing"
  "/nextcloud/index.php/ocsapp/apps/files_sharing"
  "/nextcloud/ocsapp/apps/files_sharing"
)

# The other OCS routes that hand back a URL usable WITHOUT the caller's
# credentials (audit: docs/SECURITY.md "Nextcloud OCS audit"). Each is reached
# by the same four spellings as the sharing app. richdocuments is denied as a
# whole app; files and dav only by route, because their apps also carry routes
# Nextcloud's own clients use.
#   richdocuments            direct-editing URL   (…/richdocuments/direct/<token>)
#   files …/directEditing    direct-editing URL for any registered editor
#   dav …/v1/direct          direct-download URL  (…/remote.php/direct/<token>)
BEARER_URL_PREFIXES=()
for app in "apps/richdocuments" "apps/files/api/v1/directEditing" "apps/dav/api/v1/direct"; do
  for spelling in "ocs/v1.php" "ocs/v2.php" "index.php/ocsapp" "ocsapp"; do
    BEARER_URL_PREFIXES+=("/nextcloud/$spelling/$app")
  done
done

for prefix in "${SHARING_PREFIXES[@]}" "${BEARER_URL_PREFIXES[@]}"; do
  if grep -qF "location ^~ $prefix {" "$CONF"; then
    pass "location ^~ $prefix exists (prefix-priority match beats the plain /nextcloud/ leg)"
  else
    fail "location ^~ $prefix is missing — that OCS path reaches Nextcloud through /nextcloud/"
    continue
  fi
  body="$(location_body "$prefix")"
  if [ "$(grep -cE '^[[:space:]]*[^#[:space:]]' <<<"$body")" = "1" ] \
     && grep -qE '^[[:space:]]*return 403;[[:space:]]*$' <<<"$body"; then
    pass "  $prefix answers 403 and does nothing else"
  else
    fail "  $prefix must be exactly 'return 403;' — anything more can proxy the request"
  fi
  if grep -qE 'proxy_pass|rewrite ' <<<"$body"; then
    fail "  $prefix proxies or rewrites — the denial must come before anything is forwarded"
  else
    pass "  $prefix never reaches proxy_pass"
  fi
done

# The location match runs on the normalised URI only while repeated slashes
# are merged (the nginx default); switching it off would let `/nextcloud//ocs/…`
# walk past the prefixes above.
if grep -rqE 'merge_slashes[[:space:]]+off' "$NGINX_DIR"; then
  fail "merge_slashes is off in a gateway conf — /nextcloud//ocs/v2.php/apps/files_sharing/… would bypass the sharing block"
else
  pass "merge_slashes is left at its default (on) in every gateway conf"
fi

# Resolve probe URIs the way nginx picks a location: the LONGEST matching prefix
# wins, and a `^~` winner skips the regex phase. Only the :443 server's prefix
# locations are considered. (nginx normalises the URI first — decoding, dot
# segments, merged slashes — so probes are written in normalised form.)
PREFIX_LOCS="$(awk -v start="${HTTPS_LINE:-0}" '
  NR > start && /^[[:space:]]*location[[:space:]]+(\^~[[:space:]]+)?\/[^[:space:]]*[[:space:]]*\{[[:space:]]*$/ {
    mod = ($2 == "^~") ? "^~" : ""
    path = (mod == "^~") ? $3 : $2
    inblock = 1; deny = 0; proxy = 0; next
  }
  inblock && /return 403;/ { deny = 1 }
  inblock && /proxy_pass/ { proxy = 1 }
  inblock && /^[[:space:]]*}[[:space:]]*$/ {
    print path "|" mod "|" ((deny && !proxy) ? "deny" : "other"); inblock = 0
  }
' "$CONF")"

# resolve_uri <uri> — print "<winning prefix>|<modifier>|<deny|other>".
resolve_uri() {
  local uri="$1" best="" line path
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    path="${line%%|*}"
    case "$uri" in
      "$path"*) [ "${#path}" -gt "${#best}" ] && best="$path" ;;
    esac
  done <<<"$PREFIX_LOCS"
  [ -n "$best" ] || return 0
  # Anchored at the line start: `/` would otherwise match the first line that
  # merely CONTAINS "/|" (e.g. "/api/ws/||other").
  awk -v want="$best|" 'index($0, want) == 1 { print; exit }' <<<"$PREFIX_LOCS"
}

for uri in \
  /nextcloud/ocs/v2.php/apps/files_sharing/api/v1/shares \
  /nextcloud/ocs/v2.php/apps/files_sharing/api/v1/shares/42 \
  /nextcloud/ocs/v2.php/apps/files_sharing/api/v1/sharees \
  /nextcloud/ocs/v2.php/apps/files_sharing/api/v1/remote_shares \
  /nextcloud/ocs/v2.php/apps/files_sharing \
  /nextcloud/ocs/v1.php/apps/files_sharing/api/v1/shares \
  /nextcloud/ocs/v1.php/apps/files_sharing/api/v1/shares/42 \
  /nextcloud/ocs/v1.php/apps/files_sharing \
  /nextcloud/index.php/ocsapp/apps/files_sharing/api/v1/shares \
  /nextcloud/ocsapp/apps/files_sharing/api/v1/shares \
  /nextcloud/ocs/v2.php/apps/richdocuments/api/v1/document \
  /nextcloud/ocs/v2.php/apps/richdocuments/api/v1/templates/new \
  /nextcloud/ocs/v2.php/apps/richdocuments \
  /nextcloud/ocs/v1.php/apps/richdocuments/api/v1/document \
  /nextcloud/index.php/ocsapp/apps/richdocuments/api/v1/document \
  /nextcloud/ocsapp/apps/richdocuments/api/v1/document \
  /nextcloud/ocs/v2.php/apps/files/api/v1/directEditing/open \
  /nextcloud/ocs/v2.php/apps/files/api/v1/directEditing/create \
  /nextcloud/ocs/v2.php/apps/files/api/v1/directEditing \
  /nextcloud/ocs/v1.php/apps/files/api/v1/directEditing/open \
  /nextcloud/index.php/ocsapp/apps/files/api/v1/directEditing/open \
  /nextcloud/ocsapp/apps/files/api/v1/directEditing/open \
  /nextcloud/ocs/v2.php/apps/dav/api/v1/direct \
  /nextcloud/ocs/v1.php/apps/dav/api/v1/direct \
  /nextcloud/index.php/ocsapp/apps/dav/api/v1/direct \
  /nextcloud/ocsapp/apps/dav/api/v1/direct; do
  got="$(resolve_uri "$uri")"
  case "$got" in
    *"|^~|deny") pass "$uri is denied by a ^~ location (any method)" ;;
    *) fail "$uri resolves to '${got:-nothing}' — expected a ^~ location that returns 403" ;;
  esac
done

for uri in \
  /nextcloud/remote.php/dav/files/alice/ \
  /nextcloud/remote.php/dav/files/alice/Documents/report.docx \
  /nextcloud/status.php \
  /nextcloud/s/AbCdEf123 \
  /nextcloud/ocs/v2.php/cloud/capabilities \
  /nextcloud/ocs/v2.php/apps/notifications/api/v2/notifications \
  /nextcloud/index.php/apps/files_sharing/publicpreview/AbCdEf123 \
  /nextcloud/index.php/apps/richdocuments/direct/AbCdEf123 \
  /nextcloud/index.php/apps/richdocuments/index \
  /nextcloud/remote.php/direct/AbCdEf123 \
  /nextcloud/ocs/v2.php/apps/files/api/v1/stats \
  /nextcloud/ocs/v2.php/apps/files/api/v1/templates \
  /nextcloud/ocs/v2.php/apps/dav/api/v1/outOfOffice/alice \
  /nextcloud/ocs/v2.php/core/getapppassword; do
  got="$(resolve_uri "$uri")"
  if [ "$got" = "/nextcloud/||other" ]; then
    pass "$uri still resolves to the proxied /nextcloud/ leg"
  else
    fail "$uri resolves to '${got:-nothing}' — only the OCS files_sharing and bearer-URL mint paths may be denied; everything else stays proxied by /nextcloud/"
  fi
done

# The embedded editor keeps working: the page the orchestrator hands the iframe
# (/nextcloud/…/direct/<token>, above) and every root-absolute namespace it loads
# are proxied by their own legs, not denied. Only MINTING a direct URL is closed.
for probe in \
  "/index.php/apps/richdocuments/direct/AbCdEf123|/index.php/apps/richdocuments/" \
  "/index.php/apps/theming/theme/light.css|/index.php/apps/theming/" \
  "/apps/richdocuments/js/richdocuments-document.js|/apps/" \
  "/core/js/common.js|/core/" \
  "/dist/core-common.js|/dist/"; do
  uri="${probe%%|*}"; want="${probe##*|}"
  got="$(resolve_uri "$uri")"
  if [ "$got" = "$want|^~|other" ]; then
    pass "$uri is proxied by its editor leg ($want), not denied"
  else
    fail "$uri resolves to '${got:-nothing}' — expected the proxied editor leg '$want'; the embedded editor needs it"
  fi
done

# Root /ocs/ is NOT routed to Nextcloud (it falls to the dashboard catch-all), so
# the denials above, all under /nextcloud/, cover every OCS address the gateway
# serves. Routing /ocs/ to Nextcloud would reopen every route denied here.
for uri in \
  /ocs/v2.php/apps/richdocuments/api/v1/document \
  /ocs/v2.php/apps/files/api/v1/directEditing/open \
  /ocs/v2.php/apps/dav/api/v1/direct \
  /ocs/v2.php/apps/files_sharing/api/v1/shares; do
  got="$(resolve_uri "$uri")"
  if [ "$got" = "/||other" ]; then
    pass "$uri is not routed to Nextcloud (dashboard catch-all)"
  else
    fail "$uri resolves to '${got:-nothing}' — the gateway must not route root /ocs/ to Nextcloud, or the denials above are bypassed"
  fi
done

# The block is only safe because the web app never sends its own sharing calls
# through this gateway. Pin the two facts that make that true: the orchestrator's
# Nextcloud base is the compose-internal address, and every OCS URL is built
# from it.
if grep -qF -- '- NEXTCLOUD_URL=http://nextcloud:80' "$REPO_ROOT_REAL/docker/docker-compose.yml"; then
  pass "the orchestrator talks to Nextcloud on the compose network (NEXTCLOUD_URL=http://nextcloud:80), not through this gateway"
else
  fail "docker-compose.yml no longer pins NEXTCLOUD_URL=http://nextcloud:80 — if the orchestrator reaches Nextcloud through the gateway, the web app's own sharing would get 403"
fi
if grep -qE 'function ocsUrl\(endpoint: string\): string \{' "$REPO_ROOT_REAL/apps/orchestrator/src/services/nextcloud.client.ts" \
   && grep -qF 'return `${config.NEXTCLOUD_URL}${endpoint}`;' "$REPO_ROOT_REAL/apps/orchestrator/src/services/nextcloud.client.ts"; then
  pass "the orchestrator builds every OCS URL from config.NEXTCLOUD_URL (ocsUrl in nextcloud.client.ts)"
else
  fail "nextcloud.client.ts no longer builds OCS URLs from config.NEXTCLOUD_URL — re-check that web sharing does not cross the gateway"
fi
# The editor's direct-editing mint is one of the routes denied above. It is an
# orchestrator→Nextcloud call over NEXTCLOUD_URL, so the denial cannot break it.
if grep -qF 'ocsUrl("/ocs/v2.php/apps/richdocuments/api/v1/document")' "$REPO_ROOT_REAL/apps/orchestrator/src/services/nextcloud.client.ts"; then
  pass "the editor's direct-editing mint goes through ocsUrl (compose network), not the gateway"
else
  fail "nextcloud.client.ts no longer mints the richdocuments direct URL via ocsUrl(...) — re-check that editing does not cross the gateway"
fi
# And the dashboard never requests a /nextcloud/ OCS path itself.
if grep -rnE 'ocs/v[12]\.php|/ocsapp' "$REPO_ROOT_REAL/apps/web-dashboard/src" --include='*.ts' --include='*.tsx' \
   | grep -vE '\.test\.tsx?:|__tests__' | grep -q .; then
  fail "apps/web-dashboard/src requests a Nextcloud OCS path — it would cross the gateway; re-check the Phase 7 denials"
else
  pass "the dashboard requests no Nextcloud OCS path through the gateway"
fi

echo ""
echo "  $((TESTS - FAILURES))/$TESTS passed"
echo "FAILURES=$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
exit 0
