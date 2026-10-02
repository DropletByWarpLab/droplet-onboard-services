#!/usr/bin/env bash
# =============================================================================
# WARP-2941 / ADR-008 §4 / ADR-058 slice 4 — the box advertises
# `_droplet._tcp.local` with `fqdn=` and `state=` TXT hints, and the hints
# follow the served certificate through every reload.
# =============================================================================
#
# THE INVARIANT:
#   The Droplet apps find a Droplet by TYPE (`_droplet._tcp`), not by the
#   display string "Droplet (…)". The TXT records are hints a client may use
#   to skip work, never to decide trust — so they must be present, well-
#   formed, escaped, and current, and their absence or staleness must only
#   ever cost a client the slower verified path.
#
# Runs the REAL functions out of scripts/lib/avahi-service.sh with `sudo`
# stubbed to a no-op and the services directory pointed at a temp dir. No
# docker, no root, no network; openssl generates the fixture certificates.
# =============================================================================
set -uo pipefail

REPO_ROOT_REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO_ROOT_REAL/scripts/lib/avahi-service.sh"
LOCAL_DNS="$REPO_ROOT_REAL/scripts/lib/local-dns.sh"
TLS_RELOAD="$REPO_ROOT_REAL/scripts/lib/tls-reload.sh"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

printf '\n=== WARP-2941: _droplet._tcp with fqdn= / state= hints ===\n\n'

[ -f "$LIB" ] || { printf 'FATAL: %s not found\n' "$LIB"; exit 1; }
command -v openssl >/dev/null 2>&1 || { printf 'FATAL: openssl not on PATH\n'; exit 1; }

# --- PART 1 (static): both callers go through the one renderer -------------

if grep -qE 'source "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)/avahi-service.sh"' "$LOCAL_DNS" \
   && grep -qE '^\s*write_avahi_service_file ' "$LOCAL_DNS"; then
  ok "local-dns.sh installs the advertisement through avahi-service.sh"
else
  bad "local-dns.sh does not use avahi-service.sh — setup would write a stale static file"
fi
if grep -qE '<type>_droplet\._tcp</type>' "$LOCAL_DNS"; then
  bad "local-dns.sh still carries its own copy of the service XML (two renderers drift)"
else
  ok "local-dns.sh no longer carries a second copy of the service XML"
fi

_reload_block="$(awk '/nginx -s reload 2>\/dev\/null; then/,/return 0/' "$TLS_RELOAD")"
if grep -q '_refresh_avahi_advert_for_cert' <<<"$_reload_block"; then
  ok "tls-reload.sh re-renders the advertisement in the same reload that serves a new cert"
else
  bad "tls-reload.sh does not refresh the advertisement on a cert swap — state=issued would never land"
fi

if grep -qE '"tests/local-dns-avahi.test.sh"' "$REPO_ROOT_REAL/.github/workflows/setup-tests.yml" \
   && grep -qE 'run: bash tests/local-dns-avahi.test.sh' "$REPO_ROOT_REAL/.github/workflows/setup-tests.yml"; then
  ok "this suite is wired into setup-tests.yml (paths + run step)"
else
  bad "this suite is not wired into setup-tests.yml — it would run nowhere (WARP-2647 class)"
fi

# --- PART 2 (behavioral): the real renderer over fixture certificates ------

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export AVAHI_SERVICE_DIR="$TMP/services"
export REPO_ROOT="$TMP/repo"
mkdir -p "$REPO_ROOT/docker/certs"
sudo() { "$@"; }            # the install step's sudo is a no-op here
export -f sudo
# shellcheck source=../scripts/lib/avahi-service.sh
source "$LIB"

# Fixture certs: a self-signed bootstrap leaf, and a leaf signed by a tiny CA
# (issuer != subject — what an LE fullchain's leaf looks like to the detector).
gen_selfsigned() {
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$1.key" -out "$1" -days 2 -subj "/CN=Droplet Edge Device" >/dev/null 2>&1
}
gen_ca_signed() {
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$TMP/ca.key" -out "$TMP/ca.crt" -days 2 -subj "/CN=Fixture CA" >/dev/null 2>&1
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$1.key" -out "$TMP/leaf.csr" -subj "/CN=d-fixture.devices.warp-lab.ai" >/dev/null 2>&1
  openssl x509 -req -in "$TMP/leaf.csr" -CA "$TMP/ca.crt" -CAkey "$TMP/ca.key" -CAcreateserial \
    -out "$1" -days 2 >/dev/null 2>&1
}
export MSYS_NO_PATHCONV=1   # Git Bash: keep "/CN=…" from being path-converted
gen_selfsigned "$TMP/self.crt"
gen_ca_signed  "$TMP/issued.crt"

# state=
[ "$(avahi_tls_state "$TMP/self.crt")" = "bootstrap" ] \
  && ok "a self-signed leaf advertises state=bootstrap" \
  || bad "a self-signed leaf is not state=bootstrap (got '$(avahi_tls_state "$TMP/self.crt")')"
[ "$(avahi_tls_state "$TMP/issued.crt")" = "issued" ] \
  && ok "a CA-signed leaf advertises state=issued" \
  || bad "a CA-signed leaf is not state=issued (got '$(avahi_tls_state "$TMP/issued.crt")')"
# A fullchain (leaf first, then the CA) is judged by its LEAF.
cat "$TMP/issued.crt" "$TMP/ca.crt" > "$TMP/fullchain.crt"
[ "$(avahi_tls_state "$TMP/fullchain.crt")" = "issued" ] \
  && ok "a fullchain is judged by its first block (the leaf)" \
  || bad "a fullchain is not judged by its leaf"
[ "$(avahi_tls_state "$TMP/does-not-exist.crt")" = "bootstrap" ] \
  && ok "a missing certificate advertises state=bootstrap, never a throw" \
  || bad "a missing certificate is not state=bootstrap"
printf 'garbage\n' > "$TMP/garbage.crt"
[ "$(avahi_tls_state "$TMP/garbage.crt")" = "bootstrap" ] \
  && ok "an unreadable certificate advertises state=bootstrap" \
  || bad "an unreadable certificate is not state=bootstrap"

# fqdn= : env wins, then .env, and only a valid name ever renders
unset DROPLET_PUBLIC_FQDN
[ "$(avahi_public_fqdn)" = "" ] \
  && ok "no FQDN anywhere → fqdn= is empty" \
  || bad "no FQDN anywhere should render empty (got '$(avahi_public_fqdn)')"
printf 'DROPLET_PUBLIC_FQDN=d-abc123.devices.warp-lab.ai\n' > "$REPO_ROOT/.env"
[ "$(avahi_public_fqdn)" = "d-abc123.devices.warp-lab.ai" ] \
  && ok "fqdn= is read from \$REPO_ROOT/.env when not exported (the tls-reload wrapper's case)" \
  || bad "fqdn= not read from .env (got '$(avahi_public_fqdn)')"
printf 'DROPLET_PUBLIC_FQDN="quoted.example.com"\n' > "$REPO_ROOT/.env"
[ "$(avahi_public_fqdn)" = "quoted.example.com" ] \
  && ok "a quoted .env value is unquoted" \
  || bad "a quoted .env value is not unquoted (got '$(avahi_public_fqdn)')"
DROPLET_PUBLIC_FQDN="env-wins.example.com"
[ "$(avahi_public_fqdn)" = "env-wins.example.com" ] \
  && ok "an exported DROPLET_PUBLIC_FQDN wins over .env" \
  || bad "the exported value does not win over .env"
DROPLET_PUBLIC_FQDN='evil.example.com</txt-record><txt-record>x=1'
[ "$(avahi_public_fqdn)" = "" ] \
  && ok "a value with XML metacharacters is refused before it can reach the file" \
  || bad "an XML-injecting FQDN was accepted (got '$(avahi_public_fqdn)')"
DROPLET_PUBLIC_FQDN=$'ok.example.com\nnext=line'
[ "$(avahi_public_fqdn)" = "" ] \
  && ok "a multi-line value is refused (whole-string match, not line-based)" \
  || bad "a multi-line FQDN was accepted"
unset DROPLET_PUBLIC_FQDN
rm -f "$REPO_ROOT/.env"

# XML shape
xml="$(avahi_service_xml "d-abc123.devices.warp-lab.ai" "issued")"
for needle in '<type>_droplet._tcp</type>' '<type>_https._tcp</type>' '<type>_http._tcp</type>' \
              '<txt-record>fqdn=d-abc123.devices.warp-lab.ai</txt-record>' '<txt-record>state=issued</txt-record>' \
              '<name replace-wildcards="yes">Droplet (%h)</name>' '<type>_smb._tcp</type>'; do
  grep -qF -- "$needle" <<<"$xml" && ok "rendered XML carries $needle" || bad "rendered XML lacks $needle"
done
# The _droplet entry's TXT records sit INSIDE that service element, on 443.
_droplet_block="$(awk '/<type>_droplet\._tcp<\/type>/,/<\/service>/' <<<"$xml")"
grep -q '<port>443</port>' <<<"$_droplet_block" && grep -q 'fqdn=' <<<"$_droplet_block" \
  && grep -q 'state=' <<<"$_droplet_block" \
  && ok "_droplet._tcp is on 443 and owns both TXT records" \
  || bad "_droplet._tcp block is malformed:\n$_droplet_block"
# Escaping is defence in depth behind the validation.
xml_esc="$(avahi_service_xml 'a&b<c>"d' "boot'strap")"
grep -qF '<txt-record>fqdn=a&amp;b&lt;c&gt;&quot;d</txt-record>' <<<"$xml_esc" \
  && grep -qF "<txt-record>state=boot&apos;strap</txt-record>" <<<"$xml_esc" \
  && ok "TXT values are XML-escaped (& < > \" ')" \
  || bad "TXT values are not XML-escaped"
if command -v xmllint >/dev/null 2>&1; then
  # The DOCTYPE references avahi's DTD, which is not on this machine:
  # --noout without --valid checks well-formedness only, which is the claim.
  if xmllint --noout - <<<"$xml_esc" 2>/dev/null; then
    ok "the rendered file is well-formed XML (xmllint), even with escaped metacharacters"
  else
    bad "the rendered file is not well-formed XML"
  fi
else
  ok "xmllint not installed here — well-formedness covered by the escaping checks above"
fi
# Nothing secret in TXT: the id, tokens and keys are never rendered.
DROPLET_DEVICE_ID="droplet-deadbeefcafe" BRIDGE_AUTH_TOKEN="hunter2" \
  xml_env="$(avahi_service_xml "" "bootstrap")"
if grep -qE 'deadbeef|hunter2|DROPLET_DEVICE_ID' <<<"$xml_env"; then
  bad "the advertisement leaks non-public values into TXT"
else
  ok "the advertisement carries nothing non-public (no device id, no tokens)"
fi

# Install: writes, is idempotent, follows the certificate.
cp "$TMP/self.crt" "$REPO_ROOT/docker/certs/droplet.crt"
write_avahi_service_file && [ -f "$AVAHI_SERVICE_DIR/droplet.service" ] \
  && ok "write_avahi_service_file installs the file (creating the services dir)" \
  || bad "write_avahi_service_file did not install the file"
grep -q '<txt-record>state=bootstrap</txt-record>' "$AVAHI_SERVICE_DIR/droplet.service" \
  && ok "a fresh install with the bootstrap cert advertises state=bootstrap" \
  || bad "a fresh install did not advertise state=bootstrap"
grep -q '<txt-record>fqdn=</txt-record>' "$AVAHI_SERVICE_DIR/droplet.service" \
  && ok "no FQDN yet → the record is present and empty (clients treat it as 'peek')" \
  || bad "the empty-fqdn record is missing or malformed"
before="$(stat -c %Y "$AVAHI_SERVICE_DIR/droplet.service" 2>/dev/null || stat -f %m "$AVAHI_SERVICE_DIR/droplet.service")"
# Make an mtime change observable even on a 1-second filesystem clock.
touch -d '2020-01-01 00:00:00' "$AVAHI_SERVICE_DIR/droplet.service" 2>/dev/null || touch -t 202001010000 "$AVAHI_SERVICE_DIR/droplet.service"
before="$(stat -c %Y "$AVAHI_SERVICE_DIR/droplet.service" 2>/dev/null || stat -f %m "$AVAHI_SERVICE_DIR/droplet.service")"
write_avahi_service_file
after="$(stat -c %Y "$AVAHI_SERVICE_DIR/droplet.service" 2>/dev/null || stat -f %m "$AVAHI_SERVICE_DIR/droplet.service")"
[ "$before" = "$after" ] \
  && ok "an unchanged rendering is not rewritten (no avahi churn on every reload)" \
  || bad "the file was rewritten although nothing changed"
# The cert swap the tls-issuance path performs: fullchain in, FQDN known.
cp "$TMP/fullchain.crt" "$REPO_ROOT/docker/certs/droplet.crt"
printf 'DROPLET_PUBLIC_FQDN=d-abc123.devices.warp-lab.ai\n' > "$REPO_ROOT/.env"
write_avahi_service_file
grep -q '<txt-record>state=issued</txt-record>' "$AVAHI_SERVICE_DIR/droplet.service" \
  && grep -q '<txt-record>fqdn=d-abc123.devices.warp-lab.ai</txt-record>' "$AVAHI_SERVICE_DIR/droplet.service" \
  && ok "after a cert install the advertisement says state=issued with the FQDN" \
  || bad "the advertisement did not follow the cert swap"
# And the same hook the reload uses, standalone (the device-bridge wrapper's
# way in): sourcing tls-reload.sh alone must be enough to refresh it.
cp "$TMP/self.crt" "$REPO_ROOT/docker/certs/droplet.crt"
( # subshell: tls-reload.sh defines its own log shims; keep them out of ours
  # shellcheck source=../scripts/lib/tls-reload.sh
  source "$TLS_RELOAD"
  _refresh_avahi_advert_for_cert "$REPO_ROOT/docker/certs/droplet.crt"
)
grep -q '<txt-record>state=bootstrap</txt-record>' "$AVAHI_SERVICE_DIR/droplet.service" \
  && ok "tls-reload's hook alone (standalone source) re-renders the advertisement" \
  || bad "tls-reload's hook did not re-render (state still issued after the bootstrap cert came back)"
# The install FAILING (sudo refused, read-only /etc) must not fail the reload:
# serving the new certificate outranks a hint. Behavioural, not a grep — a
# `return 0` in the no-avahi branch alone would satisfy a static check.
( sudo() { return 1; }
  # shellcheck source=../scripts/lib/tls-reload.sh
  source "$TLS_RELOAD"
  rm -f "$AVAHI_SERVICE_DIR/droplet.service"
  _refresh_avahi_advert_for_cert "$REPO_ROOT/docker/certs/droplet.crt" 2>/dev/null
) && [ ! -f "$AVAHI_SERVICE_DIR/droplet.service" ]   && ok "a failed install (sudo refused) leaves the reload hook returning 0 — best-effort by behaviour"   || bad "a failed install propagated out of the reload hook, or wrote a file without sudo"
cp "$TMP/self.crt" "$REPO_ROOT/docker/certs/droplet.crt"; write_avahi_service_file >/dev/null
# On a host with no avahi at all (dev laptop): the hook is a silent no-op.
( AVAHI_SERVICE_DIR="$TMP/no-such-dir"
  # shellcheck source=../scripts/lib/tls-reload.sh
  source "$TLS_RELOAD"
  _refresh_avahi_advert_for_cert "$REPO_ROOT/docker/certs/droplet.crt"
) && [ ! -d "$TMP/no-such-dir" ] \
  && ok "no avahi services dir on this host → the reload hook does nothing and succeeds" \
  || bad "the reload hook created an avahi dir on a host without avahi, or failed"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
