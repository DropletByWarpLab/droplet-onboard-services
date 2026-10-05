#!/usr/bin/env bash
# WARP-3740: the focused host re-apply must preserve runtime DNS configuration.
# Execute only the installer's DNS block, with every destination redirected into
# a disposable fixture. No setup, sudo, systemd, packages or production writes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
SINGLE_BOX="${1:-$REPO_ROOT_REAL/scripts/lib/single-box.sh}"
TEST_TMP_BASE="$(cd "${TMPDIR:-/tmp}" && pwd)"
WORK="$(mktemp -d "$TEST_TMP_BASE/droplet-host-dns-reapply.XXXXXXXX")"
cleanup() {
  case "$WORK" in
    "$TEST_TMP_BASE"/droplet-host-dns-reapply.*) rm -rf -- "$WORK" ;;
    *) printf 'Refusing cleanup outside the DNS fixture: %s\n' "$WORK" >&2 ;;
  esac
}
trap cleanup EXIT

# Keep the production copy decision intact. Only the literal destination is
# remapped; the template source and REAPPLY_HOST_INTEGRATION flag are unchanged.
awk '
  /^  # --- \/etc\/droplet-host-net\// { in_dns = 1; seen_start = 1 }
  in_dns && /^  # --- relay DNS origin/ { seen_end = 1; exit }
  in_dns { print }
  END { if (!seen_start || !seen_end) exit 1 }
' "$SINGLE_BOX" | sed 's|/etc/droplet-host-net|"$DNS_TEST_ROOT"/etc/droplet-host-net|g' \
  > "$WORK/install-dns.sh"
if ! grep -q 'sudo install -m 0644' "$WORK/install-dns.sh"; then
  printf 'FAIL: installer DNS block was not extracted\n' >&2
  exit 1
fi

host_src="$REPO_ROOT_REAL/scripts/host"
DNS_TEST_ROOT="$WORK/root"
conf="$DNS_TEST_ROOT/etc/droplet-host-net/lan-dhcp.conf"
template="$host_src/etc-droplet-host-net/lan-dhcp.conf"
mkdir -p "$(dirname "$conf")"

# This replaces sudo locally and rejects any destination other than the two
# fixture paths. It can never invoke elevated commands or touch a live config.
sudo() {
  local destination="${!#}"
  if [ "$1" != install ] || { [ "$destination" != "$(dirname "$conf")" ] && [ "$destination" != "$conf" ]; }; then
    printf 'FAIL: unexpected installer command or destination\n' >&2
    return 1
  fi
  command "$@"
}

FAILURES=0
assert_bytes() {
  if cmp -s "$1" "$conf"; then
    printf 'PASS: %s\n' "$2"
  else
    printf 'FAIL: %s\n' "$2" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

# A healthy presence-policy file legitimately differs from the template.
cp "$template" "$conf"
cat >> "$conf" <<'DNS'

# ADR-023 managed host-record (split-horizon FQDN) — do not edit by hand
host-record=fixture.devices.warp-lab.ai,192.0.2.42
# WARP-2189 managed relay DNS listener
listen-address=192.0.2.42
DNS
cp "$conf" "$WORK/existing.conf"
REAPPLY_HOST_INTEGRATION=true
source "$WORK/install-dns.sh"
assert_bytes "$WORK/existing.conf" 'focused re-apply preserves the complete existing DNS file'

rm -- "$conf"
source "$WORK/install-dns.sh"
assert_bytes "$template" 'focused re-apply installs the template when config is absent'

cp "$WORK/existing.conf" "$conf"
REAPPLY_HOST_INTEGRATION=false
source "$WORK/install-dns.sh"
assert_bytes "$template" 'ordinary full setup still replaces config with the template'

cp "$WORK/existing.conf" "$conf"
unset REAPPLY_HOST_INTEGRATION
source "$WORK/install-dns.sh"
assert_bytes "$template" 'ordinary full setup with an unset flag still installs the template'

# Presence includes an empty regular file; focused re-apply must not treat it as
# permission to discard existing state. Full setup remains the repair path.
: > "$conf"
cp "$conf" "$WORK/empty.conf"
REAPPLY_HOST_INTEGRATION=true
source "$WORK/install-dns.sh"
assert_bytes "$WORK/empty.conf" 'focused re-apply preserves an existing empty regular file'

[ "$FAILURES" -eq 0 ]
