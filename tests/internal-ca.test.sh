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
           camera-discovery broker frigate cache nextcloud db; do
  [ -s "$WORK/data/secrets/service-tls/$svc/cert.pem" ] || fail "issue_all missed $svc"
done
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

echo "PASS tests/internal-ca.test.sh"
