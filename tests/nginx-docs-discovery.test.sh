#!/usr/bin/env bash
# =============================================================================
# WARP-2903 — the docs-discovery leg: Nextcloud must reach Collabora THROUGH
# the gateway so the editor URL it hands the browser is path-relative.
# =============================================================================
#
# richdocuments 8.4 builds the editor form target as `urlsrc + "WOPISrc=…"`,
# with `urlsrc` lifted VERBATIM from Collabora's /hosting/discovery XML.
# coolwsd derives that value from the Host header of whoever fetched
# discovery. With Nextcloud fetching straight from docserver:9980, every
# editor form on every box targeted https://docserver:9980/docs/browser/… —
# a compose-internal name no browser resolves, and one Nextcloud's own CSP
# (frame-src / form-action 'self') blocks anyway. Measured on the bench box:
# the connector page and its bundles loaded, and not one /docs/browser/
# request ever reached the gateway. docx, xlsx, pptx — all dead.
#
# `public_wopi_url` (which WARP-1686 documented as "where the browser loads
# the editor from") never touches urlsrc: on 8.4.16 it feeds only the CSP /
# feature-policy allow-list, the admin page and the capabilities blob. So the
# WARP-1694 "URL trio verified" line logged green over a dead editor.
#
# The fix: an internal-only gateway listener (:9981) proxies coolwsd and
# rewrites the advertised origin away (`https://docserver:9980/docs` →
# `/docs`) on text/xml, and Nextcloud's `wopi_url` points at it. The browser
# then resolves the relative urlsrc against the page it is on — same-origin
# on the LAN IP, droplet.local, .lan and the FQDN alike.
#
# The BEHAVIOUR (an actual nginx doing the rewrite) is gated in the image
# build: docker/nginx/Dockerfile lifts the real server block, runs it against
# a stub upstream and asserts on the bytes (docker-build.yml runs on every
# docker/nginx/** change). This file guards the WIRING that build cannot see:
# the leg's shape in nginx.conf, that the port is never published, that the
# hook points wopi_url at the leg, waits for it, and verifies the urlsrc it
# yields. Pure bash, no Docker.
#
# Runtime: < 2 seconds.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
CONF="$REPO_ROOT_REAL/docker/nginx/nginx.conf"
DOCKERFILE="$REPO_ROOT_REAL/docker/nginx/Dockerfile"
COMPOSE_FILE="$REPO_ROOT_REAL/docker/docker-compose.yml"
HOOK="$REPO_ROOT_REAL/docker/nextcloud-init.sh"
TESTS=0
FAILURES=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================="
echo "  WARP-2903 — nginx docs-discovery leg (relative urlsrc)"
echo "  ================================================="
echo ""

for f in "$CONF" "$DOCKERFILE" "$COMPOSE_FILE" "$HOOK"; do
  if [ -f "$f" ]; then
    pass "$(basename "$f") exists"
  else
    fail "$f missing"; echo "FAILURES=$FAILURES"; exit 1
  fi
done

# ── The server block, extracted the same way the Dockerfile self-test does ──
# Match INSIDE the block, never file-wide: a file-wide grep for
# `proxy_pass http://$upstream_docserver;` also hits the public /docs/ variant
# confs, so a regression here would still find a match elsewhere (the exact
# trap WARP-1966's guards fell into).
LEG="$(awk '/^    server \{/{buf="";cap=1} cap{buf=buf $0 "\n"} /^    \}/{ if (cap && buf ~ /listen 9981;/) printf "%s", buf; cap=0 }' "$CONF")"

echo "--- Phase 1: the listener exists and is compose-internal ---"

if [ -n "$LEG" ]; then
  pass "nginx.conf carries a server block that listens on 9981"
else
  fail "no server block with 'listen 9981;' in nginx.conf — the docs-discovery leg is gone"; echo "FAILURES=$FAILURES"; exit 1
fi

if printf '%s' "$LEG" | grep -qE '^\s*listen 9981;\s*$'; then
  pass "listen 9981 is PLAIN (no ssl) — a compose-internal http leg"
else
  fail "listen 9981 carries extra flags — Nextcloud fetches it over plain http on the compose network"
fi

# Published = reachable from the LAN. The leg is a body-rewriting proxy to the
# engine; nothing off-box should be able to talk to it.
if grep -qE '^\s*-\s*"?[0-9.]*:?9981:' "$COMPOSE_FILE"; then
  fail "docker-compose.yml PUBLISHES 9981 — the docs-discovery leg must stay compose-internal"
else
  pass "docker-compose.yml never publishes 9981 (gateway publishes 80 + 443 only)"
fi

echo "--- Phase 2: the /docs/ location rewrites, and only what it should ---"

LOC="$(printf '%s' "$LEG" | awk '/location \/docs\/ \{/{cap=1} cap{print} cap && /^        \}/{exit}')"
if [ -n "$LOC" ]; then
  pass "the leg has a location /docs/ block"
else
  fail "no 'location /docs/' inside the 9981 server block"; echo "FAILURES=$FAILURES"; exit 1
fi

# WARP-1966: a URI on a VARIABLE upstream replaces the request path outright.
if printf '%s' "$LOC" | grep -qE '^\s*proxy_pass http://\$upstream_docserver;\s*$'; then
  pass "proxy_pass carries NO URI (variable upstream — a URI would replace the path, WARP-1966)"
else
  fail "proxy_pass is not the URI-less 'http://\$upstream_docserver;' form"
fi

if printf '%s' "$LOC" | grep -qE '^\s*set \$upstream_docserver "docserver:9980";'; then
  pass "upstream is docserver:9980 (coolwsd, net.service_root=/docs)"
else
  fail "upstream is not docserver:9980"
fi

# Host pinned: coolwsd builds urlsrc from the Host it receives. Pass-through
# would make the advertised origin track the fetcher's name (gateway:9981)
# and the literal below would silently stop matching.
if printf '%s' "$LOC" | grep -qE '^\s*proxy_set_header Host docserver:9980;'; then
  pass "Host is pinned to docserver:9980 — the advertised origin is deterministic"
else
  fail "Host is not pinned to docserver:9980 — the sub_filter literal cannot be exact"
fi

# sub_filter is blind to a compressed body. Nextcloud's HTTP client may ask
# for gzip; the leg must strip that on the way up.
if printf '%s' "$LOC" | grep -qE '^\s*proxy_set_header Accept-Encoding "";'; then
  pass "Accept-Encoding is stripped upstream (sub_filter needs an uncompressed body)"
else
  fail "Accept-Encoding is not stripped — a gzipped discovery bypasses the rewrite"
fi

if printf '%s' "$LOC" | grep -qE '^\s*sub_filter_types text/xml;'; then
  pass "sub_filter_types adds text/xml (discovery); JSON capabilities stay untouched"
else
  fail "sub_filter_types text/xml missing — discovery is text/xml and would not be filtered"
fi

if printf '%s' "$LOC" | grep -qE '^\s*sub_filter_once off;'; then
  pass "sub_filter_once off — discovery carries dozens of urlsrc attributes"
else
  fail "sub_filter_once is not off — only the first urlsrc would be rewritten"
fi

for scheme in https http; do
  if printf '%s' "$LOC" | grep -qE "^\s*sub_filter \"${scheme}://docserver:9980/docs\" \"/docs\";"; then
    pass "sub_filter maps ${scheme}://docserver:9980/docs → /docs (path-relative)"
  else
    fail "sub_filter for ${scheme}://docserver:9980/docs → /docs is missing"
  fi
done

# The replacement must be RELATIVE. An absolute replacement would re-introduce
# a fixed hostname and break every other name the box answers to.
if printf '%s' "$LOC" | grep -E '^\s*sub_filter ' | grep -qE '"https?://[^"]*"\s*;'; then
  fail "a sub_filter REPLACEMENT is absolute — the urlsrc must stay path-relative"
else
  pass "every sub_filter replacement is path-relative"
fi

if printf '%s' "$LEG" | grep -qE '^\s*location / \{' && printf '%s' "$LEG" | grep -qE '^\s*return 404;'; then
  pass "everything outside /docs/ on the listener is a 404"
else
  fail "the listener answers outside /docs/ — it must 404 everything else"
fi

echo "--- Phase 3: the Nextcloud hook uses the leg, waits for it, and checks its output ---"

if grep -qE 'rd_wopi="\$\{RICHDOCUMENTS_WOPI_URL:-http://gateway:9981/docs\}"' "$HOOK"; then
  pass "nextcloud-init.sh defaults wopi_url to http://gateway:9981/docs (the leg), not docserver directly"
else
  fail "nextcloud-init.sh does not default wopi_url to http://gateway:9981/docs — the browser gets an absolute docserver urlsrc again"
fi

if grep -qE 'until curl -fsS --max-time [0-9]+ -o /dev/null "\$\{rd_wopi%/\}/hosting/discovery"' "$HOOK"; then
  pass "the hook waits (bounded) for discovery over the leg BEFORE activate-config"
else
  fail "no bounded wait for the leg before activate-config — a cold start empties the discovery cache (resetCache runs before the failing fetch)"
fi

# The wait must precede activation: activate-config is resetCache THEN fetch.
wait_line=$(grep -nE 'until curl -fsS' "$HOOK" | head -1 | cut -d: -f1)
act_line=$(grep -nE 'occ_www richdocuments:activate-config' "$HOOK" | head -1 | cut -d: -f1)
if [ -n "$wait_line" ] && [ -n "$act_line" ] && [ "$wait_line" -lt "$act_line" ]; then
  pass "the wait sits before activate-config (line $wait_line < $act_line)"
else
  fail "the wait does not precede activate-config (wait@${wait_line:-none}, activate@${act_line:-none})"
fi

if grep -qE "'urlsrc=\"/docs/'\*\)" "$HOOK"; then
  pass "the hook accepts ONLY a path-relative urlsrc (/docs/…) as healthy"
else
  fail "the hook has no relative-urlsrc acceptance case — it cannot tell a dead editor from a live one"
fi

# The absolute case must be DRIFT (rd_drift=1), not a shrug: it is the exact
# WARP-2903 failure. Look for rd_drift=1 inside the case's default arm.
if awk '/case "\$rd_urlsrc" in/{c=1} c && /^\s*\*\)/{d=1} c && d && /rd_drift=1/{found=1} c && /esac/{exit} END{exit !found}' "$HOOK"; then
  pass "an absolute urlsrc is reported as drift (rd_drift=1)"
else
  fail "an absolute urlsrc does not set rd_drift=1 — the WARP-2903 failure would log as verified"
fi

# The unreachable case must NOT be drift — first boot, engine still starting.
if awk '/case "\$rd_urlsrc" in/{c=1} c && /^\s*'"''"'\)/{e=1} c && e && /rd_drift=1/{bad=1} c && e && /;;/{e=0} c && /esac/{exit} END{exit bad}' "$HOOK"; then
  pass "an unreachable discovery is deferred, not drift (engine may still be starting)"
else
  fail "an unreachable discovery sets rd_drift=1 — every slow boot would report a broken editor"
fi

# The probe's `|| true` must be INSIDE the substitution: under pipefail an
# unmatched grep fails the pipeline, and a failing substitution in an
# assignment aborts the whole hook.
if grep -qE 'rd_urlsrc="\$\( \{ curl' "$HOOK" && grep -qE '\| head -1; \} 2>/dev/null \|\| true \)"' "$HOOK"; then
  pass "the urlsrc probe's '|| true' is inside the substitution (pipefail-safe)"
else
  fail "the urlsrc probe is not pipefail-safe — an unmatched grep would abort the hook"
fi

if bash -n "$HOOK" 2>/dev/null; then
  pass "nextcloud-init.sh parses (bash -n)"
else
  fail "nextcloud-init.sh does not parse"
fi

echo "--- Phase 3b: the probe and the wait, driven with a stubbed curl under the hook's own set -euo pipefail ---"

# The shape checks above cannot see the failure that matters most here: a
# probe that ABORTS the hook. Under `set -euo pipefail` an unmatched grep in a
# command substitution kills the script, and the first time that happens is a
# boot where the engine is slow — exactly when the rest of the hook (shared
# folders, connector wiring) is most needed. So lift the probe and the wait
# out of the hook verbatim and run them against a scripted `curl`.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
probe_s=$(grep -n 'rd_urlsrc="\$( { curl' "$HOOK" | head -1 | cut -d: -f1)
probe_e=$(awk -v s="${probe_s:-0}" 'NR>s && /^[[:space:]]*esac/{print NR; exit}' "$HOOK")
wait_s=$(grep -n 'rd_tries="\${RICHDOCUMENTS_DISCOVERY_TRIES' "$HOOK" | head -1 | cut -d: -f1)
wait_e=$(awk -v s="${wait_s:-0}" 'NR>s && /^[[:space:]]*done/{print NR; exit}' "$HOOK")
if [ -n "$probe_s" ] && [ -n "$probe_e" ] && [ -n "$wait_s" ] && [ -n "$wait_e" ]; then
  sed -n "${probe_s},${probe_e}p" "$HOOK" > "$WORK/probe.sh"
  sed -n "${wait_s},${wait_e}p" "$HOOK" > "$WORK/wait.sh"
  pass "probe (lines $probe_s-$probe_e) and wait (lines $wait_s-$wait_e) lifted from the hook"
else
  fail "could not lift the probe/wait out of the hook (probe ${probe_s:-?}-${probe_e:-?}, wait ${wait_s:-?}-${wait_e:-?})"
fi

# stub_curl <mode>: down = connection refused; relative/absolute = the two
# discovery shapes. `sleep` is stubbed so the wait's give-up path runs in ms.
stub_curl() {
  cat > "$WORK/curl" <<EOF
#!/usr/bin/env bash
case "$1" in
  down)     exit 7 ;;
  relative) printf '%s\n' '<wopi-discovery><action urlsrc="/docs/browser/2229109277/cool.html?"/></wopi-discovery>' ;;
  absolute) printf '%s\n' '<wopi-discovery><action urlsrc="https://docserver:9980/docs/browser/2229109277/cool.html?"/></wopi-discovery>' ;;
esac
EOF
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/sleep"
  chmod +x "$WORK/curl" "$WORK/sleep"
}
run_probe() {
  stub_curl "$1"
  PATH="$WORK:$PATH" bash -c 'set -euo pipefail; rd_wopi="http://gateway:9981/docs"; rd_drift=0; . "$1"; echo "HOOK_ALIVE rd_drift=$rd_drift"' _ "$WORK/probe.sh" 2>&1
}
if [ -s "$WORK/probe.sh" ]; then
  out="$(run_probe down)"
  if printf '%s' "$out" | grep -q 'HOOK_ALIVE rd_drift=0' && printf '%s' "$out" | grep -q 'deferred'; then
    pass "engine down: probe defers, rd_drift stays 0, and the hook stays alive (no pipefail abort)"
  else
    fail "engine down: expected a deferred message with rd_drift=0 and the hook alive, got: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
  fi
  out="$(run_probe relative)"
  if printf '%s' "$out" | grep -q 'HOOK_ALIVE rd_drift=0' && printf '%s' "$out" | grep -q 'path-relative'; then
    pass "relative urlsrc: reported healthy, rd_drift 0"
  else
    fail "relative urlsrc: expected healthy with rd_drift=0, got: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
  fi
  out="$(run_probe absolute)"
  if printf '%s' "$out" | grep -q 'HOOK_ALIVE rd_drift=1' && printf '%s' "$out" | grep -q 'ABSOLUTE'; then
    pass "absolute urlsrc (the WARP-2903 failure): reported as drift, rd_drift 1, hook alive"
  else
    fail "absolute urlsrc: expected drift with rd_drift=1, got: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
  fi
fi
if [ -s "$WORK/wait.sh" ]; then
  stub_curl down
  out="$(PATH="$WORK:$PATH" RICHDOCUMENTS_DISCOVERY_TRIES=3 bash -c 'set -euo pipefail; rd_wopi="http://gateway:9981/docs"; . "$1"; echo "WAIT_RETURNED n=$rd_n"' _ "$WORK/wait.sh" 2>&1)"
  if printf '%s' "$out" | grep -q 'WAIT_RETURNED n=3' && printf '%s' "$out" | grep -q 'not reachable'; then
    pass "engine never comes up: the wait gives up after RICHDOCUMENTS_DISCOVERY_TRIES, says so, and returns"
  else
    fail "the wait did not give up cleanly after RICHDOCUMENTS_DISCOVERY_TRIES=3: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
  fi
  stub_curl relative
  out="$(PATH="$WORK:$PATH" RICHDOCUMENTS_DISCOVERY_TRIES=3 bash -c 'set -euo pipefail; rd_wopi="http://gateway:9981/docs"; . "$1"; echo "WAIT_RETURNED n=$rd_n"' _ "$WORK/wait.sh" 2>&1)"
  if printf '%s' "$out" | grep -q 'WAIT_RETURNED n=0'; then
    pass "engine already up: the wait returns immediately without a single retry"
  else
    fail "engine up: expected an immediate return (n=0), got: $(printf '%s' "$out" | tail -1)"
  fi
fi

echo "--- Phase 4: the build gate exercises the leg for real ---"

if grep -qE 'buf ~ /listen 9981;/' "$DOCKERFILE"; then
  pass "docker/nginx/Dockerfile lifts the 9981 server block for its self-test"
else
  fail "Dockerfile does not extract the 9981 block — the rewrite is never exercised at build"
fi

for needle in 'urlsrc="/docs/browser/1/cool.html?"' '<enc>\[\]</enc>' '"u":"https://docserver:9980/docs"' 'HTTP/1.1 404'; do
  if grep -qF "$needle" "$DOCKERFILE"; then
    pass "Dockerfile self-test asserts: $needle"
  else
    fail "Dockerfile self-test no longer asserts: $needle"
  fi
done

echo ""
echo "  $((TESTS - FAILURES))/$TESTS passed"
echo "FAILURES=$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
exit 0
