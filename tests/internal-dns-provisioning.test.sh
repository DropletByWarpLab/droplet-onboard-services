#!/usr/bin/env bash
# Internal hostname provisioning on the host DNS plane, without external services.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
TESTS=0; FAILURES=0
ok() { TESTS=$((TESTS+1)); printf 'PASS %s\n' "$1"; }
bad() { TESTS=$((TESTS+1)); FAILURES=$((FAILURES+1)); printf 'FAIL %s\n' "$1"; }
log_info() { :; }; log_success() { :; }; log_error() { :; }
log_warn() { printf '%s\n' "$*" >> "$WORK/warnings"; }
LOG_FILE="$WORK/setup.log"
DROPLET_LAN_HOSTNAME=office.lan
DROPLET_PUBLIC_FQDN=old.devices.warp-lab.ai
DROPLET_HOST_DNSMASQ_CONF="$WORK/lan-dhcp.conf"
# shellcheck source=../scripts/lib/local-dns.sh
source "$REPO_ROOT/scripts/lib/local-dns.sh"
ip() {
  case "$*" in
    *'addr show dev br-lan'*) printf '7: br-lan inet 192.168.20.1/24 scope global br-lan\n' ;;
    *'route get'*) printf 'local 127.0.0.1 dev lo src 127.0.0.1\n' ;;
  esac
}
if [ "$(OPENWRT_HOST=127.0.0.1 _discover_host_lan_ip)" = 192.168.20.1 ]; then
  ok 'single-box DNS uses the LAN gateway instead of loopback'
else bad 'single-box DNS selected an unreachable loopback address'; fi
ip() { printf 'local 127.0.0.1 dev lo src 127.0.0.1\n'; }
hostname() { printf '127.0.0.1 169.254.10.1 0.0.0.0 192.168.9.250\n'; }
if [ "$(OPENWRT_HOST=192.168.9.1 _discover_host_lan_ip)" = 192.168.9.250 ]; then
  ok 'external-router DNS ignores unusable addresses in route and hostname output'
else bad 'external-router DNS selected an unusable address'; fi
unset -f ip hostname
sudo() { [ "$1" != -n ] || return 0; "$@"; }
systemctl() { :; }
_rerender_gateway_llm_access() { :; }
_discover_host_lan_ip() { printf '%s' "${TEST_LAN_IP:-192.168.9.250}"; }
cat > "$WORK/lan-dhcp.conf" <<'EOF'
listen-address=192.168.20.1
host-record=printer.lan,192.168.9.20
# ADR-023 managed host-record (split-horizon FQDN) — do not edit by hand
host-record=old.devices.warp-lab.ai,192.168.9.250
EOF
setup_host_dns
if grep -qx 'host-record=office.lan,192.168.9.250' "$WORK/lan-dhcp.conf" \
   && ! grep -q 'old.devices' "$WORK/lan-dhcp.conf"; then
  ok 'host DNS replaces the old managed fleet name with internal DNS'
else bad 'host DNS kept the old fleet record or missed the internal record'; fi
if grep -qx 'host-record=printer.lan,192.168.9.20' "$WORK/lan-dhcp.conf"; then
  ok 'unrelated DNS records remain intact'
else bad 'unrelated DNS record changed'; fi
TEST_LAN_IP=192.168.9.195 setup_host_dns
if [ "$(grep -c '^host-record=office.lan,' "$WORK/lan-dhcp.conf")" -eq 1 ] \
   && grep -qx 'host-record=office.lan,192.168.9.195' "$WORK/lan-dhcp.conf"; then
  ok 'address changes replace the managed record without duplicates'
else bad 'address changes left duplicate or stale internal records'; fi
cp "$WORK/lan-dhcp.conf" "$WORK/before"
TEST_LAN_IP=192.168.9.195 setup_host_dns
cmp -s "$WORK/before" "$WORK/lan-dhcp.conf" \
  && ok 'unchanged DNS setup is idempotent' || bad 'unchanged DNS setup rewrote the file'
sudo() { return 1; }
TEST_LAN_IP=192.168.9.200 setup_host_dns
if cmp -s "$WORK/before" "$WORK/lan-dhcp.conf" && grep -q 'deferred' "$WORK/warnings"; then
  ok 'unprivileged DNS setup defers without changing the host configuration'
else bad 'unprivileged setup wrote configuration or failed silently'; fi
printf '%s checks, %s failures\n' "$TESTS" "$FAILURES"
[ "$FAILURES" -eq 0 ]
