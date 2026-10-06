#!/usr/bin/env bash
# =============================================================================
# WARP-2944 / ADR-058 — the self-signed bootstrap certificate follows the
# box's address, and its KEY never changes for that.
# =============================================================================
#
# THE INVARIANT:
#   The key is the box's identity: every Droplet app that paired by the
#   pairing QR's `spki=` (WARP-2953/2954) verifies against it. The SAN is a
#   fact about where the box is right now. When the box moves (new LAN, new
#   lease) the certificate must be regenerated to NAME the new address —
#   around the SAME key — or a pinned client is refused by name while the
#   pin is right (droplet-windows trust.rs `NameMismatch`). A key is minted
#   fresh only when there is no genuine key to keep (first install, torn
#   pair). A public-CA leaf is never touched here.
#
# Runs the REAL scripts/lib/secrets.sh::_generate_tls_cert in a temp
# REPO_ROOT, with DROPLET_TLS_SAN_IPS standing in for `ip addr` so a "box
# moved" is one variable away. No docker, no root, no network.
# =============================================================================
set -uo pipefail

REPO_ROOT_REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="$REPO_ROOT_REAL/scripts/lib/secrets.sh"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

printf '\n=== WARP-2944: the bootstrap certificate follows the box, the key stays ===\n\n'

[ -f "$SECRETS" ] || { printf 'FATAL: %s not found\n' "$SECRETS"; exit 1; }
command -v openssl >/dev/null 2>&1 || { printf 'FATAL: openssl not on PATH\n'; exit 1; }

if grep -qE '"tests/tls-bootstrap-cert-follows-the-box.test.sh"' "$REPO_ROOT_REAL/.github/workflows/setup-tests.yml" \
   && grep -qE 'run: bash tests/tls-bootstrap-cert-follows-the-box.test.sh' "$REPO_ROOT_REAL/.github/workflows/setup-tests.yml"; then
  ok "this suite is wired into setup-tests.yml (paths + run step)"
else
  bad "this suite is not wired into setup-tests.yml — it would run nowhere (WARP-2647 class)"
fi

# --- harness ----------------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export REPO_ROOT="$TMP/repo"
mkdir -p "$REPO_ROOT/docker/certs"
CERT="$REPO_ROOT/docker/certs/droplet.crt"
KEY="$REPO_ROOT/docker/certs/droplet.key"
export MSYS_NO_PATHCONV=1

log_info()    { :; }
log_success() { :; }
log_warn()    { printf '%s\n' "$*" >> "$TMP/warn.log"; }
log_error()   { printf '%s\n' "$*" >> "$TMP/warn.log"; }
reload_gateway_nginx() { printf 'reload\n' >> "$TMP/reload.log"; return 0; }
# shellcheck source=../scripts/lib/secrets.sh
source "$SECRETS"
unset DROPLET_LAN_HOSTNAME

pin_of() {  # the SPKI pin the apps compute — what must survive a move
  openssl x509 -in "$1" -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | openssl dgst -sha256 -binary | base64
}
ip_sans_of() { _cert_ip_sans "$1" | sort | tr '\n' ' ' | sed 's/ $//'; }
last_warn() { tail -n1 "$TMP/warn.log" 2>/dev/null; }

# --- 1. first install: a fresh key, the box's addresses in the SAN -----------
export DROPLET_TLS_SAN_IPS="192.168.9.195 172.17.0.1"
_generate_tls_cert >/dev/null 2>&1
[ -f "$CERT" ] && [ -f "$KEY" ] \
  && ok "first install generates a self-signed pair" \
  || bad "first install did not generate the pair"
pin1="$(pin_of "$CERT")"
[ -n "$pin1" ] && ok "the served leaf has a computable SPKI pin ($pin1)" || bad "no pin from the first leaf"
case "$(ip_sans_of "$CERT")" in
  *"192.168.9.195"*"172.17.0.1"*|*"172.17.0.1"*"192.168.9.195"*) ok "the SAN names both current addresses (+ loopback: $(ip_sans_of "$CERT"))" ;;
  *) bad "the SAN does not name the current addresses: $(ip_sans_of "$CERT")" ;;
esac
[ -f "$CERT.bootstrap" ] && [ -f "$KEY.bootstrap" ] \
  && ok "the trust-anchor .bootstrap side-copy exists (ADR-023 PR-2)" \
  || bad "no .bootstrap side-copy"
_tls_pair_matches "$CERT" "$KEY" && ok "cert and key match" || bad "cert/key mismatch after first install"

# --- 2. same addresses: nothing changes ----------------------------------------
: > "$TMP/warn.log"; : > "$TMP/reload.log"
before_cert="$(sha256sum "$CERT" | cut -c1-16)"; before_key="$(sha256sum "$KEY" | cut -c1-16)"
_generate_tls_cert >/dev/null 2>&1
[ "$(sha256sum "$CERT" | cut -c1-16)" = "$before_cert" ] && [ "$(sha256sum "$KEY" | cut -c1-16)" = "$before_key" ] \
  && ok "a re-run with the same addresses leaves cert and key untouched (skip-guard)" \
  || bad "a re-run with the same addresses rewrote the pair"
[ ! -s "$TMP/reload.log" ] && ok "…and does not reload nginx" || bad "an unchanged pair reloaded nginx"

# --- 3. the box moved: the SAN follows, the KEY stays ---------------------------
: > "$TMP/warn.log"; : > "$TMP/reload.log"
export DROPLET_TLS_SAN_IPS="10.50.0.7 172.17.0.1"
_generate_tls_cert >/dev/null 2>&1
grep -q "does not name this box's current address" "$TMP/warn.log" \
  && ok "the stale address is named as the reason ($(last_warn | cut -c1-90)…)" \
  || bad "the reason for regenerating is not the stale address: $(last_warn)"
case "$(ip_sans_of "$CERT")" in
  *"10.50.0.7"*) ok "the regenerated SAN names the new address" ;;
  *) bad "the regenerated SAN does not name the new address: $(ip_sans_of "$CERT")" ;;
esac
pin3="$(pin_of "$CERT")"
[ "$pin3" = "$pin1" ] \
  && ok "the SPKI pin is UNCHANGED across the move — every pinned pairing survives" \
  || bad "the pin changed on a SAN refresh ($pin1 → $pin3): every paired app would see 'identity changed'"
[ "$(sha256sum "$KEY" | cut -c1-16)" = "$before_key" ] && ok "the key file is byte-identical" || bad "the key file was rewritten"
_tls_pair_matches "$CERT" "$KEY" && ok "the new cert still matches the key" || bad "cert/key mismatch after the move"
[ -s "$TMP/reload.log" ] && ok "nginx was reloaded so the new SAN is served at once" || bad "no nginx reload after regenerating"
[ "$(pin_of "$CERT.bootstrap")" = "$pin1" ] && ok "the .bootstrap side-copy is untouched (same key, first cert)" || bad ".bootstrap side-copy changed"
# Idempotent again at the new address.
: > "$TMP/reload.log"; before_cert="$(sha256sum "$CERT" | cut -c1-16)"
_generate_tls_cert >/dev/null 2>&1
[ "$(sha256sum "$CERT" | cut -c1-16)" = "$before_cert" ] && ok "converges: a second run at the new address is a no-op" || bad "did not converge at the new address"

# --- 4. an address the box LOST is not a reason to regenerate -------------------
export DROPLET_TLS_SAN_IPS="10.50.0.7"
before_cert="$(sha256sum "$CERT" | cut -c1-16)"
_generate_tls_cert >/dev/null 2>&1
[ "$(sha256sum "$CERT" | cut -c1-16)" = "$before_cert" ] \
  && ok "a SAN that names MORE than the current addresses is fine (a lost docker bridge is not a move)" \
  || bad "losing an address regenerated the cert"

# --- 5a. a torn pair with a .bootstrap: RESTORED to the original identity ------
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY" >/dev/null 2>&1
: > "$TMP/warn.log"
_generate_tls_cert >/dev/null 2>&1
grep -q "restoring the trust-anchor bootstrap pair" "$TMP/warn.log" && ok "a torn pair with a bootstrap copy is restored from it (ADR-023 PR-2, unchanged)" || bad "a torn pair with a bootstrap copy was not restored: $(last_warn)"
_tls_pair_matches "$CERT" "$KEY" && ok "…and converges to a matching pair" || bad "torn pair did not converge"
[ "$(pin_of "$CERT")" = "$pin1" ] && ok "…under the ORIGINAL pin — the stray key was never the identity" || bad "the restore did not return to the original pin"

# --- 5a′. a torn pair, a bootstrap copy AND a moved box: restored key, current SAN
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY" >/dev/null 2>&1
export DROPLET_TLS_SAN_IPS="10.60.0.9"
: > "$TMP/warn.log"
_generate_tls_cert >/dev/null 2>&1
grep -q "Restored bootstrap certificate does not name" "$TMP/warn.log" && ok "a restore onto a moved box does not stop at the stale bootstrap SAN" || bad "the restore stopped at the bootstrap copy's stale SAN: $(last_warn)"
case "$(ip_sans_of "$CERT")" in *"10.60.0.9"*) ok "…the served SAN names the current address" ;; *) bad "…served SAN is stale: $(ip_sans_of "$CERT")" ;; esac
[ "$(pin_of "$CERT")" = "$pin1" ] && ok "…under the original pin (regenerated around the restored key)" || bad "…pin changed after restore+move"
_tls_pair_matches "$CERT" "$KEY" && ok "…and the pair matches" || bad "…pair mismatch after restore+move"

# --- 5b. a torn pair with NO bootstrap copy: nothing genuine to keep → fresh key -
rm -f "$CERT.bootstrap" "$KEY.bootstrap"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY" >/dev/null 2>&1
: > "$TMP/warn.log"
_generate_tls_cert >/dev/null 2>&1
grep -q "do not match" "$TMP/warn.log" && ok "a torn pair without a bootstrap copy is reported as torn" || bad "torn pair (no bootstrap) not reported: $(last_warn)"
_tls_pair_matches "$CERT" "$KEY" && ok "…and converges to a matching pair" || bad "torn pair (no bootstrap) did not converge"
pin5="$(pin_of "$CERT")"
[ "$pin5" != "$pin1" ] && ok "…with a NEW key: a stray key's cert is never minted as if it were the identity" || bad "a torn pair without a bootstrap kept the old pin, which the served leaf no longer proves"

# --- 6. a public-CA leaf is never regenerated for a stale address -----------------
mkdir -p "$TMP/ca"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$TMP/ca/ca.key" -out "$TMP/ca/ca.crt" -days 2 -subj "/CN=Fixture CA" >/dev/null 2>&1
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$KEY" -out "$TMP/ca/leaf.csr" -subj "/CN=office.lan" >/dev/null 2>&1
printf 'subjectAltName=DNS:droplet-ai.lan\n' > "$TMP/ca/local-san.cnf"
openssl x509 -req -in "$TMP/ca/leaf.csr" -extfile "$TMP/ca/local-san.cnf" -CA "$TMP/ca/ca.crt" -CAkey "$TMP/ca/ca.key" -CAcreateserial -out "$CERT" -days 2 >/dev/null 2>&1
export DROPLET_TLS_SAN_IPS="192.168.77.1"
before_cert="$(sha256sum "$CERT" | cut -c1-16)"; before_key="$(sha256sum "$KEY" | cut -c1-16)"
_generate_tls_cert >/dev/null 2>&1
[ "$(sha256sum "$CERT" | cut -c1-16)" = "$before_cert" ] && [ "$(sha256sum "$KEY" | cut -c1-16)" = "$before_key" ] \
  && ok "a public-CA leaf (no IP SANs, address 'stale' by construction) is preserved, never clobbered" \
  || bad "the public-CA leaf was regenerated over"

# --- 7. the helpers themselves ---------------------------------------------------
export DROPLET_TLS_SAN_IPS="1.2.3.4 5.6.7.8"
[ "$(_current_lan_ipv4s | tr '\n' ' ')" = "1.2.3.4 5.6.7.8 " ] && ok "_current_lan_ipv4s honours the test override, one per line" || bad "_current_lan_ipv4s override broken: $(_current_lan_ipv4s | tr '\n' ' ')"
unset DROPLET_TLS_SAN_IPS
if command -v ip >/dev/null 2>&1 || command -v ifconfig >/dev/null 2>&1; then
  _current_lan_ipv4s >/dev/null 2>&1 && ok "_current_lan_ipv4s discovers without the override and never fails the caller" || bad "_current_lan_ipv4s returned non-zero without the override"
else
  ok "no ip/ifconfig here — discovery path not exercised"
fi

# --- 8. the host wrapper the device-bridge calls (outside setup.sh) --------------
WRAPPER="$REPO_ROOT_REAL/scripts/host/droplet-tls-bootstrap-refresh.sh"
export DROPLET_TLS_REFRESH_LIB_DIR="$REPO_ROOT_REAL/scripts/lib"
W="$TMP/wrapper"; mkdir -p "$W/docker/certs"
out="$(REPO_ROOT="$W" DROPLET_TLS_SAN_IPS="192.168.9.195" bash "$WRAPPER" 2>/dev/null)"
[ "$out" = '{"ok":true,"changed":false,"reason":"no certificate installed"}' ] \
  && ok "wrapper: no installed pair → honest no-op (the first install is setup.sh's)" \
  || bad "wrapper without a pair: $out"
( REPO_ROOT="$W" DROPLET_TLS_SAN_IPS="192.168.9.195" _generate_tls_cert >/dev/null 2>&1 )
wpin="$(pin_of "$W/docker/certs/droplet.crt")"
out="$(REPO_ROOT="$W" DROPLET_TLS_SAN_IPS="192.168.9.195" bash "$WRAPPER" 2>/dev/null)"
[ "$out" = "{\"ok\":true,\"changed\":false,\"pin\":\"$wpin\"}" ] \
  && ok "wrapper: same address → changed:false, reports the pin" \
  || bad "wrapper at the same address: $out"
out="$(REPO_ROOT="$W" DROPLET_TLS_SAN_IPS="10.50.0.7" bash "$WRAPPER" 2>/dev/null)"
[ "$out" = "{\"ok\":true,\"changed\":true,\"pin\":\"$wpin\"}" ] \
  && ok "wrapper: moved → changed:true under the SAME pin" \
  || bad "wrapper after a move: $out"
case "$(ip_sans_of "$W/docker/certs/droplet.crt")" in *"10.50.0.7"*) ok "wrapper: the served SAN names the new address" ;; *) bad "wrapper: SAN stale" ;; esac
out="$(REPO_ROOT="$W" DROPLET_TLS_REFRESH_DRY_RUN=1 bash "$WRAPPER" 2>/dev/null)"
[ "$out" = '{"ok":true,"changed":false,"dryRun":true}' ] && ok "wrapper: dry run touches nothing" || bad "wrapper dry run: $out"
out="$(REPO_ROOT="$W" DROPLET_TLS_REFRESH_LIB_DIR="$TMP/nowhere" bash "$WRAPPER" 2>/dev/null)"; rc=$?
[ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "helper missing" && ok "wrapper: a missing helper is a non-zero, named failure" || bad "wrapper with no helpers: rc=$rc $out"
grep -q "droplet-tls-bootstrap-refresh.sh" "$REPO_ROOT_REAL/scripts/install-device-bridge.sh" \
  && grep -q "/usr/local/sbin/droplet-tls-bootstrap-refresh.sh" "$REPO_ROOT_REAL/scripts/factory-reset.sh" \
  && ok "wrapper is installed by install-device-bridge.sh and removed by factory-reset.sh" \
  || bad "wrapper is not wired into install / factory-reset"

# --- 9. the wrapper is REFRESH ONLY: it never heals a pair and never mints a key -
dns_sans_of() { openssl x509 -in "$1" -noout -ext subjectAltName 2>/dev/null | grep -o 'DNS:[^, ]*' | sort | tr '\n' ' '; }
WCERT="$W/docker/certs/droplet.crt"; WKEY="$W/docker/certs/droplet.key"
wcert_sha="$(sha256sum "$WCERT" | cut -c1-16)"; wkey_sha="$(sha256sum "$WKEY" | cut -c1-16)"

# 9a. a key this user cannot read — the shape a `sudo ./scripts/setup.sh` leaves
# behind — must be refused, not "healed" with a fresh key.
if [ "$(id -u)" -eq 0 ]; then
  ok "running as root — the unreadable-key refusal cannot be exercised here (root reads everything)"
else
  chmod 000 "$WKEY"
  out="$(REPO_ROOT="$W" DROPLET_TLS_SAN_IPS="10.99.0.1" bash "$WRAPPER" 2>/dev/null)"; rc=$?
  chmod 600 "$WKEY"
  [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "not readable/writable" \
    && ok "wrapper: an unreadable key is a non-zero, named refusal ($out)" \
    || bad "wrapper with an unreadable key: rc=$rc $out"
  [ "$(sha256sum "$WCERT" | cut -c1-16)" = "$wcert_sha" ] && [ "$(sha256sum "$WKEY" | cut -c1-16)" = "$wkey_sha" ] \
    && ok "…and touched neither file — the pin is exactly what it was" \
    || bad "…the wrapper rewrote the pair it could not read (identity rotated on a timer)"
fi

# 9b. a torn pair (which is also what the LE issuance looks like between its
# two writes) is refused outright — setup.sh heals pairs, the timer does not.
cp "$WKEY" "$TMP/wkey.good"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$WKEY" >/dev/null 2>&1
stray_sha="$(sha256sum "$WKEY" | cut -c1-16)"
out="$(REPO_ROOT="$W" DROPLET_TLS_SAN_IPS="10.99.0.1" bash "$WRAPPER" 2>/dev/null)"; rc=$?
[ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "does not match" \
  && ok "wrapper: a torn pair is a non-zero, named refusal ($out)" \
  || bad "wrapper with a torn pair: rc=$rc $out"
[ "$(sha256sum "$WCERT" | cut -c1-16)" = "$wcert_sha" ] && [ "$(sha256sum "$WKEY" | cut -c1-16)" = "$stray_sha" ] \
  && ok "…and left both files exactly as found (no restore, no new key, nothing for an issuance to trip over)" \
  || bad "…the wrapper rewrote a torn pair unattended"
cp "$TMP/wkey.good" "$WKEY"; chmod 600 "$WKEY"

# 9c. the generator's own lock: with DROPLET_TLS_NO_NEWKEY set it refuses the
# -newkey branch even when called directly on a torn pair with no bootstrap.
L="$TMP/lock"; mkdir -p "$L/docker/certs"
( REPO_ROOT="$L" DROPLET_TLS_SAN_IPS="10.1.1.1" _generate_tls_cert >/dev/null 2>&1 )
rm -f "$L/docker/certs/droplet.crt.bootstrap" "$L/docker/certs/droplet.key.bootstrap"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$L/docker/certs/droplet.key" >/dev/null 2>&1
lkey_sha="$(sha256sum "$L/docker/certs/droplet.key" | cut -c1-16)"; lcert_sha="$(sha256sum "$L/docker/certs/droplet.crt" | cut -c1-16)"
: > "$TMP/warn.log"
( REPO_ROOT="$L" DROPLET_TLS_SAN_IPS="10.1.1.1" DROPLET_TLS_NO_NEWKEY=1 _generate_tls_cert >/dev/null 2>&1 ); rc=$?
[ "$rc" -ne 0 ] && grep -q "may not mint one" "$TMP/warn.log" \
  && ok "_generate_tls_cert under DROPLET_TLS_NO_NEWKEY refuses to mint a key (non-zero, says why)" \
  || bad "_generate_tls_cert minted or stayed silent under DROPLET_TLS_NO_NEWKEY: rc=$rc $(last_warn)"
[ "$(sha256sum "$L/docker/certs/droplet.key" | cut -c1-16)" = "$lkey_sha" ] && [ "$(sha256sum "$L/docker/certs/droplet.crt" | cut -c1-16)" = "$lcert_sha" ] \
  && ok "…and wrote nothing" || bad "…but rewrote the pair anyway"
( REPO_ROOT="$L" DROPLET_TLS_SAN_IPS="10.1.1.1" _generate_tls_cert >/dev/null 2>&1 )
[ "$(sha256sum "$L/docker/certs/droplet.key" | cut -c1-16)" != "$lkey_sha" ] \
  && ok "…while the same call WITHOUT the lock (setup.sh's path) still heals the torn pair with a fresh key" \
  || bad "…the lock leaked: setup.sh's path no longer heals a torn pair"

# 9d. a refresh keeps the internal hostname SAN (read from .env, as setup.sh does).
printf 'DROPLET_LAN_HOSTNAME="office.lan"\nADMIN_TOKEN=not-a-real-token\n' > "$W/.env"
out="$(REPO_ROOT="$W" DROPLET_TLS_SAN_IPS="10.99.0.2" bash "$WRAPPER" 2>/dev/null)"
printf '%s' "$out" | grep -q '"changed":true' && ok "wrapper: a move with a .env present still refreshes ($out)" || bad "wrapper with a .env: $out"
case "$(dns_sans_of "$WCERT")" in
  *"DNS:office.lan"*) ok "…and the regenerated SAN carries the internal hostname from .env" ;;
  *) bad "…the refresh DROPPED the internal hostname SAN: $(dns_sans_of "$WCERT")" ;;
esac
printf 'DROPLET_LAN_HOSTNAME=bad host; rm -rf /\n' > "$W/.env"
out="$(REPO_ROOT="$W" DROPLET_TLS_SAN_IPS="10.99.0.3" bash "$WRAPPER" 2>/dev/null)"
case "$(dns_sans_of "$WCERT")" in
  *"bad"*|*"rm"*) bad "…a malformed DROPLET_LAN_HOSTNAME reached the SAN" ;;
  *) ok "…a value that is not shaped like a hostname is ignored, not sourced" ;;
esac
rm -f "$W/.env"

# 9e. a public-CA leaf: the wrapper says so and stops before the generator.
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$WKEY" -out "$TMP/ca/wleaf.csr" -subj "/CN=office.lan" >/dev/null 2>&1
printf 'subjectAltName=DNS:droplet-ai.lan\n' > "$TMP/ca/wleaf-san.cnf"
openssl x509 -req -in "$TMP/ca/wleaf.csr" -extfile "$TMP/ca/wleaf-san.cnf" -CA "$TMP/ca/ca.crt" -CAkey "$TMP/ca/ca.key" -CAcreateserial -out "$WCERT" -days 2 >/dev/null 2>&1
wcert_sha="$(sha256sum "$WCERT" | cut -c1-16)"
out="$(REPO_ROOT="$W" DROPLET_TLS_SAN_IPS="10.99.0.4" bash "$WRAPPER" 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '"reason":"CA certificate for internal DNS"' && [ "$(sha256sum "$WCERT" | cut -c1-16)" = "$wcert_sha" ] \
  && ok "wrapper: a public-CA leaf is reported as such and never touched ($out)" \
  || bad "wrapper on a public-CA leaf: rc=$rc $out"

# An old fleet-only leaf is replaced without changing the pairing identity.
printf 'subjectAltName=DNS:old.devices.warp-lab.ai\n' > "$TMP/ca/wleaf-san.cnf"
openssl x509 -req -in "$TMP/ca/wleaf.csr" -extfile "$TMP/ca/wleaf-san.cnf" \
  -CA "$TMP/ca/ca.crt" -CAkey "$TMP/ca/ca.key" -CAcreateserial \
  -out "$WCERT" -days 2 >/dev/null 2>&1
legacy_key_sha="$(sha256sum "$WKEY" | cut -c1-16)"
out="$(REPO_ROOT="$W" DROPLET_TLS_SAN_IPS="10.99.0.4" bash "$WRAPPER" 2>/dev/null)"
if printf '%s' "$out" | grep -q '"changed":true' \
   && [ "$(sha256sum "$WKEY" | cut -c1-16)" = "$legacy_key_sha" ] \
   && dns_sans_of "$WCERT" | grep -q 'DNS:droplet-ai.lan'; then
  ok "wrapper cuts over a legacy fleet certificate to internal TLS with the same key"
else bad "wrapper did not cut over old fleet TLS around its current key ($out)"; fi

# --- 10. WARP-3414: `droplet-fingerprint` prints the key fingerprint the apps show
# A Droplet app confirms a self-signed box by this string; the box prints it on
# channels a LAN attacker cannot rewrite (this installer output, the front
# screen, the CLI). It must be the Mac app's format — uppercase hex, 4-char
# groups, single spaces, 16 groups — and the SAME value the orchestrator
# (lib/served-cert-pin.ts) and the panel (device-bridge.py) print, which their
# own suites pin against this very certificate.
FPCLI="$REPO_ROOT_REAL/scripts/host/usr-local-bin/droplet-fingerprint"
# The known certificate pinned in apps/orchestrator/src/lib/served-cert-pin.test.ts
# and services/oled-display/tests/test_device_bridge_pair_qr.py.
cat > "$TMP/known.pem" <<'PEM'
-----BEGIN CERTIFICATE-----
MIIDbjCCAlagAwIBAgIUAlSK5TGY8EIKhYF9BpBMUtmUHIYwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTRHJvcGxldCBFZGdlIERldmljZTAeFw0yNjA4MjQwMDE2
NTlaFw0zNjA4MjEwMDE2NTlaMB4xHDAaBgNVBAMME0Ryb3BsZXQgRWRnZSBEZXZp
Y2UwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJTowoqlgJIqh2BWAU
oeF7tWViDbPvgWkQb/GjiiDfy+3mhaYGlME1AUliZ2RFKcfUaZUWl/Hx/m0IB76U
V4sprx+RBOMGkIUQcX+7XlKuLaUsMFfoKtanTgz3QUu6DL5DZmHseODcSckF5alB
Di8JsbQ3XORbs4/k+st+rZ7ixcXq8Ew8YMBWyzRSAOTNyuBIRyubpE2ICXTev9Vt
Cgte5Gfya2XSDyQMe13zCtHQeRTENZrfiMaD6nv7jmP0MemtDUV3MGYS4MT3jONs
GkHINdp/bxCsNS1/xaw+Zsjf2k62HVnUQU6iSFYv4D2GWZ+grCcckzClS3UbbF8C
bpNPAgMBAAGjgaMwgaAwfwYDVR0RBHgwdoIJbG9jYWxob3N0ggdkcm9wbGV0gg1k
cm9wbGV0LmxvY2Fsggtkcm9wbGV0LmxhboIKZHJvcGxldC1haYIQZHJvcGxldC1h
aS5sb2NhbIIOZHJvcGxldC1haS5sYW6HBMCoCcOHBKwRAAGHBH8AAAGHBKwSAAEw
HQYDVR0OBBYEFMcORZ7r953P5iWdsn+jxt8IVQXSMA0GCSqGSIb3DQEBCwUAA4IB
AQAfOcbb8KAdhx0nQ0LAIqjr+dvJGA+aQ7iE0PGS/foH9stCNb0BYUl9u3hw8DeG
iDuqL9xslTLj59q1CXakQp9Nwcabmuz4g0ecvt/bAlp/hr1wufdwMC4sGfQFd5Mm
mdhemY5mWxsJ9qK5T0g8RUrsWVQLvA54arkBrlu1B76U94D4mD4PuqvQgjd94oSh
oBSExYAPhKI1v2xIYyMiyInzx7XLzYJai0lZA2jvzI00Lgl53Gm7OiTZtd3mXTqA
LShUlCL6TPB4psnOIT1WLAi0VRlAmMiPh9O9guVJ+Uk9NoMXFC+3ANSNebfb1KBF
uSd9DJAIdEt6/CNInKDHBh7j
-----END CERTIFICATE-----
PEM
KNOWN_FP="F017 AFA8 6AD7 8BED 4ABD E646 90F0 5B7B 8DBB E36B 26E9 C8F4 10E5 36A6 1E3D F25C"

fp_oracle() {  # independent of the CLI: openssl's own hex, then grouped
  openssl x509 -in "$1" -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | openssl dgst -sha256 -r | cut -d' ' -f1 | tr 'a-f' 'A-F' \
    | sed 's/\(....\)/\1 /g; s/ $//'
}

out="$("$FPCLI" --oneline --file "$TMP/known.pem" 2>&1)"
[ "$out" = "$KNOWN_FP" ] \
  && ok "droplet-fingerprint prints the known certificate's fingerprint in the Mac app's format" \
  || bad "droplet-fingerprint on the known certificate: '$out' (want '$KNOWN_FP')"
printf '%s' "$out" | grep -Eq '^[0-9A-F]{4}( [0-9A-F]{4}){15}$' \
  && ok "…16 groups of 4 uppercase hex characters, single-space separated" \
  || bad "…not 16 groups of 4 uppercase hex: '$out'"

block="$("$FPCLI" --file "$TMP/known.pem" 2>&1)"
[ "$(printf '%s\n' "$block" | wc -l | tr -d ' ')" = "4" ] \
  && [ "$(printf '%s\n' "$block" | tr '\n' ' ' | sed 's/ $//')" = "$KNOWN_FP" ] \
  && ok "…the default form is the same 16 groups, four to a line" \
  || bad "…the default form is not four lines of four groups: '$block'"

out="$("$FPCLI" --oneline --file "$CERT" 2>&1)"
[ "$out" = "$(fp_oracle "$CERT")" ] \
  && ok "a freshly generated bootstrap certificate: the CLI equals openssl's own SPKI hash" \
  || bad "the CLI disagrees with openssl for the generated certificate: '$out'"

cat "$TMP/known.pem" "$CERT" > "$TMP/fullchain.pem"
out="$("$FPCLI" --oneline --file "$TMP/fullchain.pem" 2>&1)"
[ "$out" = "$KNOWN_FP" ] \
  && ok "a fullchain: it is the LEAF's key (the first certificate), not a later one" \
  || bad "a fullchain printed '$out', not the leaf's fingerprint"

printf 'not a certificate\n' > "$TMP/garbage.pem"
out="$("$FPCLI" --oneline --file "$TMP/garbage.pem" 2>/dev/null)"; rc=$?
[ "$rc" -ne 0 ] && [ -z "$out" ] \
  && ok "no certificate: a non-zero exit and NO fingerprint (never the hash of nothing, E3B0 C442 …)" \
  || bad "no certificate: rc=$rc out='$out'"

# The key is never an input: the CLI only ever reads a certificate.
grep -vE '^\s*#' "$FPCLI" | grep -qiE 'droplet\.key|rsa -in|pkey -in|x509 -noout -text' \
  && bad "droplet-fingerprint touches key material" \
  || ok "droplet-fingerprint never reads the private key"

grep -q 'droplet-fingerprint' "$REPO_ROOT_REAL/scripts/host/MANIFEST" \
  && grep -q 'usr-local-bin/droplet-fingerprint' "$REPO_ROOT_REAL/scripts/lib/single-box.sh" \
  && ok "it is installed by the host integration and tracked in the manifest" \
  || bad "droplet-fingerprint is not in the manifest and the host-integration installer"

grep -q 'usr-local-bin/droplet-fingerprint' "$REPO_ROOT_REAL/scripts/setup.sh" \
  && ok "setup.sh prints the fingerprint in its completion output (a channel the LAN cannot rewrite)" \
  || bad "setup.sh does not print the fingerprint"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
