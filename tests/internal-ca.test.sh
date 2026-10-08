#!/usr/bin/env bash
# WARP-236 — unit test for scripts/lib/internal-ca.sh (pure openssl, no Docker).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

log_info() { :; }; log_warn() { :; }; log_success() { :; }
# SC2097/SC2098 are the point, not a mistake: the prefix assignment must apply
# to the sourced library (so it writes into the sandbox), while the path must
# expand to the OLD value (so it sources the REAL library). `.` is a builtin, so
# the assignment does persist for the duration of the source — shellcheck's
# fork-based reasoning does not apply. Waived inline per the ship-check
# convention; it surfaced only once WARP-2647 put this suite under shellcheck.
# shellcheck disable=SC1091,SC2097,SC2098
REPO_ROOT="$WORK" . "$REPO_ROOT/scripts/lib/internal-ca.sh"

# Inspect certs with the same openssl the lib picked: LibreSSL (macOS default)
# lacks `x509 -ext`; the lib prefers a real OpenSSL 3 when present.
OSSL="${OPENSSL:-openssl}"

# 1. CA mint is idempotent
internal_ca_ensure
[ -s "$WORK/data/secrets/internal-ca/ca.key" ] || fail "ca.key missing"
[ -s "$WORK/data/secrets/internal-ca/ca.pem" ] || fail "ca.pem missing"
# GNU first, BSD fallback — the repo idiom (setup.sh:217, device-backup.sh:305,
# droplet-host-units.sh:846). The inverse order is BROKEN on Linux: GNU
# `stat -f` means "filesystem status", so it prints a block-device report for
# the file and only then errors on the format string, and the successful part
# of that output lands in the command substitution alongside the fallback's.
# The comparison then never matches. This suite ran in no workflow (WARP-2647),
# so nothing on Linux ever executed this line.
[ "$(stat -c %a "$WORK/data/secrets/internal-ca/ca.key" 2>/dev/null || stat -f %Lp "$WORK/data/secrets/internal-ca/ca.key" 2>/dev/null)" = "600" ] || fail "ca.key not 0600"
before="$(openssl x509 -in "$WORK/data/secrets/internal-ca/ca.pem" -noout -fingerprint)"
internal_ca_ensure
after="$(openssl x509 -in "$WORK/data/secrets/internal-ca/ca.pem" -noout -fingerprint)"
[ "$before" = "$after" ] || fail "CA regenerated on second ensure"

# 2. Issue a bundle: chain verifies, CN + SANs + EKU present
internal_ca_issue orchestrator "DNS:host.docker.internal"
B="$WORK/data/secrets/service-tls/orchestrator"
openssl verify -CAfile "$WORK/data/secrets/internal-ca/ca.pem" "$B/cert.pem" >/dev/null || fail "chain"
subj="$(openssl x509 -in "$B/cert.pem" -noout -subject)"
echo "$subj" | grep -q "CN *= *orchestrator" || fail "CN: $subj"
sans="$("$OSSL" x509 -in "$B/cert.pem" -noout -ext subjectAltName)"
echo "$sans" | grep -q "DNS:orchestrator"          || fail "SAN service: $sans"
echo "$sans" | grep -q "DNS:localhost"             || fail "SAN localhost"
echo "$sans" | grep -q "DNS:host.docker.internal"  || fail "SAN extra"
echo "$sans" | grep -q "IP Address:127.0.0.1"      || fail "SAN loopback"
eku="$("$OSSL" x509 -in "$B/cert.pem" -noout -ext extendedKeyUsage)"
echo "$eku" | grep -q "TLS Web Server Authentication" || fail "EKU serverAuth"
echo "$eku" | grep -q "TLS Web Client Authentication" || fail "EKU clientAuth"
cmp -s "$B/ca.pem" "$WORK/data/secrets/internal-ca/ca.pem" || fail "bundle ca.pem != CA cert"

# 3. Re-issue is a no-op unless forced
fp1="$(openssl x509 -in "$B/cert.pem" -noout -fingerprint)"
internal_ca_issue orchestrator "DNS:host.docker.internal"
fp2="$(openssl x509 -in "$B/cert.pem" -noout -fingerprint)"
[ "$fp1" = "$fp2" ] || fail "reissued a fresh cert"
INTERNAL_CA_FORCE=1 internal_ca_issue orchestrator "DNS:host.docker.internal"
fp3="$(openssl x509 -in "$B/cert.pem" -noout -fingerprint)"
[ "$fp1" != "$fp3" ] || fail "force did not reissue"

# 4. issue_all covers the canonical list incl. broker + frigate + cache (WARP-234)
internal_ca_issue_all
for svc in orchestrator gateway ai-gateway mcp-server voice-io email-indexer rag-eval \
           ops-console file-indexer routing switch oled-display matter-controller \
           camera-discovery broker frigate cache nextcloud db media-gen doc-render web-fetch sandbox; do
  [ -s "$WORK/data/secrets/service-tls/$svc/cert.pem" ] || fail "issue_all missed $svc"
done

# An OTA bundle ships docker/ but not the current scripts/ identity list.
# Exercise its additive issuer against an installed host library and CA.
OTA_BOX="$WORK/ota-box"
mkdir -p "$OTA_BOX/scripts/lib" "$OTA_BOX/data/secrets/internal-ca"
cp "$REPO_ROOT/scripts/lib/internal-ca.sh" "$OTA_BOX/scripts/lib/internal-ca.sh"
cp "$WORK/data/secrets/internal-ca/ca.pem" "$WORK/data/secrets/internal-ca/ca.key" "$OTA_BOX/data/secrets/internal-ca/"
printf 'DROPLET_INTERNAL_TLS=1\n' > "$OTA_BOX/.env"
OTA_TLS="$REPO_ROOT/docker/ota/reconcile-service-tls.sh"
bash "$OTA_TLS" "$OTA_BOX" >/dev/null 2>&1 || fail "OTA service identity reconciliation"
ota_ca_before="$(openssl x509 -in "$OTA_BOX/data/secrets/internal-ca/ca.pem" -noout -fingerprint)"
ota_leaf_before="$(openssl x509 -in "$OTA_BOX/data/secrets/service-tls/media-gen/cert.pem" -noout -fingerprint)"
for svc in media-gen doc-render web-fetch sandbox; do
  openssl verify -CAfile "$OTA_BOX/data/secrets/internal-ca/ca.pem" "$OTA_BOX/data/secrets/service-tls/$svc/cert.pem" >/dev/null || fail "OTA $svc certificate chain"
  [ "$(stat -c %a "$OTA_BOX/data/secrets/service-tls/$svc/key.pem" 2>/dev/null || stat -f %Lp "$OTA_BOX/data/secrets/service-tls/$svc/key.pem" 2>/dev/null)" = "600" ] || fail "OTA $svc key permission"
done
bash "$OTA_TLS" "$OTA_BOX" >/dev/null 2>&1 || fail "OTA identity reconcile re-run"
[ "$ota_ca_before" = "$(openssl x509 -in "$OTA_BOX/data/secrets/internal-ca/ca.pem" -noout -fingerprint)" ] || fail "OTA replaced the device CA"
[ "$ota_leaf_before" = "$(openssl x509 -in "$OTA_BOX/data/secrets/service-tls/media-gen/cert.pem" -noout -fingerprint)" ] || fail "OTA rotated a fresh leaf"
OTA_EMPTY="$WORK/ota-empty"; mkdir -p "$OTA_EMPTY"
printf 'DROPLET_INTERNAL_TLS=0\n' > "$OTA_EMPTY/.env"
bash "$OTA_TLS" "$OTA_EMPTY" >/dev/null 2>&1 || fail "plaintext box without CA must remain a no-op"
[ ! -e "$OTA_EMPTY/data/secrets/internal-ca" ] || fail "OTA minted a new CA"
printf 'export DROPLET_INTERNAL_TLS = "1" # enabled\n' > "$OTA_EMPTY/.env"
if bash "$OTA_TLS" "$OTA_EMPTY" >/dev/null 2>&1; then fail "mTLS box without CA must refuse before swaps"; fi
# 5. rotate-internal-certs.sh --service reissues exactly that bundle
fp_orch="$(openssl x509 -in "$WORK/data/secrets/service-tls/orchestrator/cert.pem" -noout -fingerprint)"
fp_ai="$(openssl x509 -in "$WORK/data/secrets/service-tls/ai-gateway/cert.pem" -noout -fingerprint)"
REPO_ROOT_OVERRIDE="$WORK" bash "$REPO_ROOT/scripts/rotate-internal-certs.sh" --service orchestrator
[ "$fp_orch" != "$(openssl x509 -in "$WORK/data/secrets/service-tls/orchestrator/cert.pem" -noout -fingerprint)" ] || fail "rotate did not reissue orchestrator"
[ "$fp_ai"   = "$(openssl x509 -in "$WORK/data/secrets/service-tls/ai-gateway/cert.pem"   -noout -fingerprint)" ] || fail "rotate touched ai-gateway"

# 6. --rebuild-ca mints a new CA and every bundle chains to it
ca_fp="$(openssl x509 -in "$WORK/data/secrets/internal-ca/ca.pem" -noout -fingerprint)"
REPO_ROOT_OVERRIDE="$WORK" bash "$REPO_ROOT/scripts/rotate-internal-certs.sh" --rebuild-ca
[ "$ca_fp" != "$(openssl x509 -in "$WORK/data/secrets/internal-ca/ca.pem" -noout -fingerprint)" ] || fail "CA not rebuilt"
openssl verify -CAfile "$WORK/data/secrets/internal-ca/ca.pem" \
  "$WORK/data/secrets/service-tls/broker/cert.pem" >/dev/null || fail "broker not reissued under new CA"

# 7. WARP-3653: the daily host renewal pass (scripts/host/droplet-renew-internal-certs.sh).
RENEW="$REPO_ROOT/scripts/host/droplet-renew-internal-certs.sh"
# 7a. no CA on the box: a clear no-op, never mints one.
EMPTY="$(mktemp -d)"
out="$(REPO_ROOT_OVERRIDE="$EMPTY" bash "$RENEW" 2>&1)" || fail "renew with no CA must exit 0: $out"
echo "$out" | grep -q "nothing to renew" || fail "no-CA log line missing: $out"
[ ! -e "$EMPTY/data/secrets/internal-ca" ] || fail "renew minted a CA on a box without one"
rm -rf "$EMPTY"

# 7b. healthy bundles: nothing due, nothing touched, nothing restarted.
fp_before="$(openssl x509 -in "$WORK/data/secrets/service-tls/db/cert.pem" -noout -fingerprint)"
out="$(REPO_ROOT_OVERRIDE="$WORK" RENEW_NO_RESTART=1 bash "$RENEW" 2>&1)" || fail "healthy renew pass failed: $out"
echo "$out" | grep -q "nothing to do" || fail "healthy pass should report nothing to do: $out"
[ "$fp_before" = "$(openssl x509 -in "$WORK/data/secrets/service-tls/db/cert.pem" -noout -fingerprint)" ] || fail "healthy pass reissued db"

# 7c. bundles near expiry (issued for 1 day, so inside the one-third window of
# the 90-day lifetime = the box 'clock set forward'): renewed without setup.sh.
INTERNAL_CERT_DAYS=1 INTERNAL_CA_FORCE=1 internal_ca_issue_all
openssl x509 -in "$WORK/data/secrets/service-tls/db/cert.pem" -noout -checkend 2592000 >/dev/null 2>&1 \
  && fail "test setup: db cert should be inside the renewal window"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
# compose stub: two services running; log every restart.
case " $* " in
  *" ps "*) printf 'orchestrator\ndb\n' ;;
  *" restart "*) echo "${*: -1}" >> "$DOCKER_STUB_LOG" ;;
esac
STUB
chmod +x "$WORK/bin/docker"
: > "$WORK/restarts.log"
out="$(PATH="$WORK/bin:$PATH" DOCKER_STUB_LOG="$WORK/restarts.log" REPO_ROOT_OVERRIDE="$WORK" bash "$RENEW" 2>&1)" \
  || fail "renewal pass failed: $out"
for svc in orchestrator db broker cache; do
  openssl x509 -in "$WORK/data/secrets/service-tls/$svc/cert.pem" -noout -checkend $((80 * 86400)) >/dev/null 2>&1 \
    || fail "$svc was not renewed to a full lifetime"
  openssl verify -CAfile "$WORK/data/secrets/internal-ca/ca.pem" "$WORK/data/secrets/service-tls/$svc/cert.pem" >/dev/null \
    || fail "$svc renewed cert does not chain to the CA"
done
# only running compose services are restarted, each once; markers all cleared
sort "$WORK/restarts.log" | tr '\n' ' ' | grep -qx "db orchestrator " || fail "unexpected restarts: $(cat "$WORK/restarts.log")"
[ -z "$(find "$WORK/data/secrets/service-tls" -name .restart-pending)" ] || fail "restart markers left behind"
# and the next pass is a no-op
out="$(PATH="$WORK/bin:$PATH" DOCKER_STUB_LOG="$WORK/restarts.log" REPO_ROOT_OVERRIDE="$WORK" bash "$RENEW" 2>&1)" || fail "follow-up pass failed"
echo "$out" | grep -q "nothing to do" || fail "follow-up pass should be a no-op: $out"
[ "$(wc -l < "$WORK/restarts.log" | tr -d ' ')" = "2" ] || fail "follow-up pass restarted something"

# 7d. a failed restart is remembered and retried (the certs are already fresh).
INTERNAL_CERT_DAYS=1 INTERNAL_CA_FORCE=1 internal_ca_issue orchestrator "DNS:host.docker.internal"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
case " $* " in
  *" ps "*) printf 'orchestrator\n' ;;
  *" restart "*) exit 1 ;;
esac
STUB
rc=0; PATH="$WORK/bin:$PATH" REPO_ROOT_OVERRIDE="$WORK" bash "$RENEW" >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail "a failed restart must fail the pass"
[ -e "$WORK/data/secrets/service-tls/orchestrator/.restart-pending" ] || fail "failed restart lost its pending marker"

echo "PASS tests/internal-ca.test.sh"
