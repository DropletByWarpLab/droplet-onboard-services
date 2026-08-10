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
  if printf '%s' "$body" | grep -qE 'set \$upstream_nextcloud[[:space:]]+"nextcloud:80";'; then
    pass "  $prefix sets \$upstream_nextcloud (per-request DNS re-resolution)"
  else
    fail "  $prefix does not set \$upstream_nextcloud like the other legs"
  fi

  # NO trailing slash on proxy_pass: Nextcloud serves these at its OWN root, so
  # the prefix must be forwarded UNSTRIPPED. A trailing slash here (copied from
  # the /nextcloud/ leg, which DOES strip) would rewrite /apps/x → /x and 404.
  if printf '%s' "$body" | grep -qE '^[[:space:]]*proxy_pass http://\$upstream_nextcloud;[[:space:]]*$'; then
    pass "  $prefix forwards the prefix UNSTRIPPED (no trailing slash on proxy_pass)"
  else
    fail "  $prefix must use 'proxy_pass http://\$upstream_nextcloud;' with NO trailing slash — Nextcloud expects these at its own root"
  fi

  for hdr in 'Host \$host' 'X-Real-IP \$remote_addr' \
             'X-Forwarded-For \$proxy_add_x_forwarded_for' 'X-Forwarded-Proto \$scheme'; do
    if printf '%s' "$body" | grep -qE "proxy_set_header[[:space:]]+$hdr;"; then
      pass "  $prefix sets proxy_set_header ${hdr%% *}"
    else
      fail "  $prefix is missing proxy_set_header ${hdr%% *} (diverges from every other gateway leg)"
    fi
  done

  # ── Semgrep suppressions (the CI gate is DIFF-SCOPED) ──
  #
  # `semgrep.yml` scans with `--baseline-commit <merge-base>`, so the identical
  # patterns in the pre-existing legs are INVISIBLE to it while these new lines
  # are not. "The leg above does the same thing and is fine" is therefore not
  # evidence — every new leg needs its own annotation, in the house style:
  # justification prose, then the `# nosemgrep:` line, then the directive.
  for rule in dynamic-proxy-host.dynamic-proxy-host \
              request-host-used.request-host-used; do
    if printf '%s' "$body" | grep -qF "# nosemgrep: generic.nginx.security.$rule"; then
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

echo "--- Phase 2: ordering — every asset leg precedes the catch-all ---"

CATCHALL_LINE=$(grep -nE '^[[:space:]]*location / \{' "$CONF" | head -1 | cut -d: -f1)
if [ -n "$CATCHALL_LINE" ]; then
  pass "found the dashboard catch-all 'location /' at line $CATCHALL_LINE"
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
if grep -qE '^[[:space:]]*location[[:space:]]+(\^~[[:space:]]+)?/index\.php/[[:space:]]*\{' "$CONF"; then
  fail "a blanket 'location /index.php/' leg exists — that publishes Nextcloud's login/settings/admin surface at the dashboard origin (explicitly rejected scope)"
else
  pass "no blanket /index.php/ leg — only the two prefixes the editor needs are exposed"
fi

for denied in /index.php/login /index.php/settings /index.php/apps/files /apps/files; do
  if grep -qF "location ^~ $denied" "$CONF"; then
    fail "$denied is routed — Nextcloud's own UI must stay unreachable at this origin"
  else
    pass "$denied is NOT routed at the gateway"
  fi
done

# Regression guard: the pre-existing /nextcloud/ leg DOES strip its prefix.
# The new legs must not have been "fixed" to match it, nor it to match them.
if grep -qE '^[[:space:]]*proxy_pass http://\$upstream_nextcloud/;' "$CONF"; then
  pass "the /nextcloud/ leg still strips its prefix (trailing slash preserved)"
else
  fail "the /nextcloud/ leg lost its trailing-slash strip — that breaks the whole Nextcloud proxy"
fi

echo "--- Phase 4: no collision with a dashboard surface ---"

# The dashboard's 12 surfaces plus its Next.js asset roots. None may be
# shadowed by a new asset leg.
for surface in home chat files email cameras network devices tools activity \
               people models settings _next api ai docs nextcloud; do
  for prefix in "${ASSET_PREFIXES[@]}"; do
    case "/$surface/" in
      "$prefix"*)
        fail "asset leg $prefix shadows the dashboard/gateway surface /$surface/"
        ;;
    esac
  done
done
pass "no asset leg shadows any dashboard surface or existing gateway leg"

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

echo "--- Phase 6: structural sanity (balanced braces) ---"

OPEN=$(tr -cd '{' < "$CONF" | wc -c | tr -d ' ')
CLOSE=$(tr -cd '}' < "$CONF" | wc -c | tr -d ' ')
if [ "$OPEN" = "$CLOSE" ]; then
  pass "braces are balanced ($OPEN open / $CLOSE close)"
else
  fail "brace imbalance: $OPEN open vs $CLOSE close"
fi

# Every directive line inside the new legs must be terminated. An unterminated
# proxy_pass is the classic copy-paste break.
for prefix in "${ASSET_PREFIXES[@]}"; do
  body="$(location_body "$prefix")"
  bad=$(printf '%s\n' "$body" \
    | grep -vE '^[[:space:]]*(#.*)?$' \
    | grep -vE ';[[:space:]]*$' \
    | head -3)
  if [ -z "$bad" ]; then
    pass "$prefix: every directive line is terminated with ';'"
  else
    fail "$prefix: unterminated directive line(s): $(printf '%s' "$bad" | tr '\n' '|')"
  fi
done

echo ""
echo "  $((TESTS - FAILURES))/$TESTS passed"
echo "FAILURES=$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
exit 0
