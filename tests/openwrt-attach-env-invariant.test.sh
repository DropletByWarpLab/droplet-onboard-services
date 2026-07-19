#!/usr/bin/env bash
# =============================================================================
# WARP-843 SECURITY REGRESSION GUARD — no droplet-writable file may be a root
# unit's EnvironmentFile, and root consumes customer creds via a validated
# whitelist parse ONLY.
# =============================================================================
#
# THE INVARIANT (load-bearing):
#   A systemd `EnvironmentFile=` loads EVERY `KEY=VALUE` line of the target file
#   into the unit's environment. If that target is a file the unprivileged
#   device-bridge can write (droplet-owned), a compromised bridge injects
#   arbitrary keys into a ROOT unit's environment — e.g. into
#   droplet-openwrt-attach.service:
#       AP_PSK_FILE=/root/.ssh/authorized_keys
#       DROPLET_AP_PSK=ssh-ed25519 AAAA...attacker
#   whereupon resolve_ap_psk() (running AS ROOT) does
#   `printf '%s\n' "$AP_PSK" > "$AP_PSK_FILE"` → attacker-controlled
#   /root/.ssh/authorized_keys → root SSH (local privilege escalation / sandbox
#   escape). Equivalent primitives exist via OPENWRT_PASSWORD_FILE,
#   DEVICE_BRIDGE_ENV_FILE, DROPLET_RPCD_ACL, AP_PSK_FILE=/etc/cron.d/x, …
#
#   Therefore: NO droplet-writable file may be referenced by `EnvironmentFile=`
#   in ANY root unit. Root must consume the customer Wi-Fi creds (SSID / PSK /
#   guest) through the WHITELISTED, VALIDATED customer_ap_creds /
#   customer_guest_creds key-parse — which reads ONLY DROPLET_AP_SSID /
#   DROPLET_AP_PSK / DROPLET_GUEST_SSID / DROPLET_GUEST_PSK /
#   DROPLET_GUEST_ENABLED and ignores every other key — never via
#   EnvironmentFile.
#
# This guard is static + behavioral, needs no root/systemd/docker, and:
#   PART 1 (static): derives the set of paths the installer / single-box
#     provisioning hands to the droplet user (`chown droplet …` +
#     `StateDirectory=`), then asserts NO root unit shipped under
#     scripts/host/etc-systemd-system/ (+ its .d/*.conf drop-ins) has an
#     `EnvironmentFile=` pointing at any of them. FAILS on the pre-fix wiring
#     (where /etc/default/droplet-openwrt-attach was chown'd droplet AND is the
#     attach service's EnvironmentFile in TWO places) and PASSES once the
#     PR #551 split is restored.
#   PART 2 (behavioral): extracts the customer_ap_creds + customer_guest_creds
#     blocks from the attach script and proves that crafted EXTRA keys in the
#     droplet-writable creds file (AP_PSK_FILE=/root/.ssh/authorized_keys, …)
#     do NOT influence root — only the whitelisted DROPLET_AP_*/DROPLET_GUEST_*
#     keys are consumed.
#
# Runtime: < 1s.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_DIR="$REPO_ROOT/scripts/host/etc-systemd-system"
SINGLE_BOX="$REPO_ROOT/scripts/lib/single-box.sh"
BRIDGE_INSTALL="$REPO_ROOT/scripts/install-device-bridge.sh"
AUTOMOUNT_INSTALL="$REPO_ROOT/services/automount/install.sh"
BRIDGE_UNIT="$REPO_ROOT/services/oled-display/droplet-device-bridge.service"
ATTACH="$REPO_ROOT/scripts/host/usr-local-sbin/droplet-openwrt-attach"
# WARP-1338: root units that live OUTSIDE scripts/host/etc-systemd-system but
# load /etc/droplet/automount.env via EnvironmentFile= — the invariant must
# cover them too (services/automount/install.sh owns that file's provisioning
# and keeps it root:root 0644).
AUX_ROOT_UNITS=(
  "$REPO_ROOT/services/automount/droplet-automount@.service"
  "$REPO_ROOT/services/automount/droplet-automount-reconcile.service"
  "$REPO_ROOT/services/oled-display/droplet-storage-pool-apply.service"
)

TESTS=0
FAILURES=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-843 — root EnvironmentFile invariant + whitelist parse"
echo "  ================================================"
echo ""

# --- PART 1: no root unit EnvironmentFile=s a droplet-writable path -----------
echo "--- Part 1: static — root EnvironmentFile invariant ---"

# Collect the set of paths the provisioning scripts hand to the droplet user.
#   (a) `chown droplet[:group] <path|"$VAR">` in single-box.sh / installer, with
#       one level of same-file $VAR resolution;
#   (b) `StateDirectory=<name>` in any shipped unit -> /var/lib/<name>.
collect_droplet_writable() {
  local f line target var val u
  for f in "$SINGLE_BOX" "$BRIDGE_INSTALL" "$AUTOMOUNT_INSTALL"; do
    [ -f "$f" ] || continue
    while IFS= read -r line; do
      target="$(printf '%s\n' "$line" \
        | sed -E 's/.*\bchown[[:space:]]+(-[A-Za-z]+[[:space:]]+)*droplet(:[A-Za-z0-9_]+)?[[:space:]]+//' \
        | sed -E 's/[[:space:]].*$//' | tr -d '"')"
      case "$target" in
        \$*)
          var="$(printf '%s' "$target" | sed -E 's/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?.*$/\1/')"
          val="$(grep -E "^[[:space:]]*${var}=" "$f" 2>/dev/null | head -1 \
                 | sed -E "s/^[[:space:]]*${var}=//" | tr -d '"')"
          [ -n "$val" ] && printf '%s\n' "$val"
          ;;
        /*) printf '%s\n' "$target" ;;
      esac
    done < <(grep -E '\bchown[[:space:]]+(-[A-Za-z]+[[:space:]]+)*droplet(:|[[:space:]])' "$f" 2>/dev/null || true)
  done
  for u in "$BRIDGE_UNIT" "$UNIT_DIR"/*.service "$UNIT_DIR"/*.path "$UNIT_DIR"/*.timer; do
    [ -f "$u" ] || continue
    grep -E '^StateDirectory=' "$u" 2>/dev/null | sed -E 's#^StateDirectory=#/var/lib/#' || true
  done
}

DW_PATHS="$(collect_droplet_writable | sed '/^$/d' | sort -u)"
if [ -n "$DW_PATHS" ]; then
  pass "derived the droplet-writable path set from provisioning ($(printf '%s' "$DW_PATHS" | tr '\n' ' '))"
else
  fail "could not derive any droplet-writable paths — detection is broken (test would false-pass)"
fi

# A unit is "root" unless it declares a non-root User=.
is_root_unit() {
  local usr
  usr="$(grep -E '^User=' "$1" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
  case "$usr" in
    ""|root|0) return 0 ;;
    *) return 1 ;;
  esac
}

path_conflict() { # $1=env target $2=droplet-writable path -> 0 if same or under
  [ "$1" = "$2" ] && return 0
  case "$1" in "$2"/*) return 0 ;; esac
  return 1
}

violations=0
checked=0
for u in "$UNIT_DIR"/*.service "$UNIT_DIR"/*.path "$UNIT_DIR"/*.timer "$UNIT_DIR"/*.d/*.conf "${AUX_ROOT_UNITS[@]}"; do
  [ -f "$u" ] || continue
  # Root check: for a .d/*.conf drop-in, honor BOTH its own and the main unit's
  # User=; skip if either runs as a non-root user.
  case "$u" in
    */*.d/*.conf)
      is_root_unit "$u" || continue
      main_unit="$(dirname "$u")"; main_unit="${main_unit%.d}"
      [ -f "$main_unit" ] && { is_root_unit "$main_unit" || continue; }
      ;;
    *)
      is_root_unit "$u" || continue
      ;;
  esac
  while IFS= read -r envline; do
    tgt="$(printf '%s' "$envline" | sed -E 's/^EnvironmentFile=-?//' | tr -d '[:space:]')"
    [ -n "$tgt" ] || continue
    checked=$((checked + 1))
    while IFS= read -r dw; do
      [ -n "$dw" ] || continue
      if path_conflict "$tgt" "$dw"; then
        fail "root unit $(basename "$u") loads EnvironmentFile=$tgt which provisioning makes droplet-writable ($dw) — LPE vector"
        violations=$((violations + 1))
      fi
    done <<EOF
$DW_PATHS
EOF
  done < <(grep -E '^EnvironmentFile=' "$u" 2>/dev/null || true)
done

if [ "$checked" -eq 0 ]; then
  fail "scanned no EnvironmentFile= lines at all — unit discovery is broken"
elif [ "$violations" -eq 0 ]; then
  pass "no root unit EnvironmentFile= references a droplet-writable path ($checked EnvironmentFile targets checked)"
fi

# Belt-and-braces: the canonical attach env file specifically must NOT be both
# droplet-writable AND a root EnvironmentFile (this is the exact regression).
ATTACH_ENV="/etc/default/droplet-openwrt-attach"
attach_dw=0
while IFS= read -r dw; do [ "$dw" = "$ATTACH_ENV" ] && attach_dw=1; done <<EOF
$DW_PATHS
EOF
attach_envfile=0
if grep -rqE "^EnvironmentFile=-?${ATTACH_ENV}\$" "$UNIT_DIR"/droplet-openwrt-attach.service "$UNIT_DIR"/droplet-openwrt-attach.service.d/*.conf 2>/dev/null; then
  attach_envfile=1
fi
if [ "$attach_dw" -eq 1 ] && [ "$attach_envfile" -eq 1 ]; then
  fail "$ATTACH_ENV is BOTH droplet-writable AND a root EnvironmentFile — the WARP-843 LPE"
else
  pass "$ATTACH_ENV is not simultaneously droplet-writable and a root EnvironmentFile"
fi

# WARP-1338 belt-and-braces: /etc/droplet/automount.env feeds three ROOT units
# (the AUX_ROOT_UNITS above). It must (a) actually be referenced there — so
# this scan is never vacuous — and (b) never be droplet-writable.
AUTOMOUNT_ENV="/etc/droplet/automount.env"
am_env_refs=0
for u in "${AUX_ROOT_UNITS[@]}"; do
  [ -f "$u" ] || continue
  grep -qE "^EnvironmentFile=-?${AUTOMOUNT_ENV}\$" "$u" && am_env_refs=$((am_env_refs + 1))
done
if [ "$am_env_refs" -ge 3 ]; then
  pass "all 3 automount/storage-pool root units load $AUTOMOUNT_ENV (scan is not vacuous)"
else
  fail "expected 3 root units to load $AUTOMOUNT_ENV, found $am_env_refs — the WARP-1338 wiring moved; update AUX_ROOT_UNITS"
fi
am_env_dw=0
while IFS= read -r dw; do [ "$dw" = "$AUTOMOUNT_ENV" ] && am_env_dw=1; done <<EOF
$DW_PATHS
EOF
if [ "$am_env_dw" -eq 1 ]; then
  fail "$AUTOMOUNT_ENV is droplet-writable AND a root EnvironmentFile — the WARP-843 LPE, reintroduced via WARP-1338's wiring"
else
  pass "$AUTOMOUNT_ENV is not droplet-writable (root:root per services/automount/install.sh)"
fi

# --- PART 2: root parses ONLY the whitelisted keys from the creds file --------
echo "--- Part 2: behavioral — customer_ap_creds / customer_guest_creds whitelist ---"

if [ -f "$ATTACH" ]; then
  pass "attach script present"
else
  fail "attach script missing at $ATTACH"
  echo ""; echo "  $((TESTS - FAILURES))/$TESTS checks passed"; exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SNIP="$WORK/creds.sh"
{
  sed -n '/# >>> customer_ap_creds/,/# <<< customer_ap_creds/p' "$ATTACH"
  sed -n '/# >>> customer_guest_creds/,/# <<< customer_guest_creds/p' "$ATTACH"
} > "$SNIP"

if [ -s "$SNIP" ]; then
  pass "extracted customer_ap_creds + customer_guest_creds parse blocks"
else
  fail "could not extract the creds parse blocks (sentinel markers moved?)"
  echo ""; echo "  $((TESTS - FAILURES))/$TESTS checks passed"; exit 1
fi

# A hostile creds file: valid whitelisted customer keys PLUS attacker keys that,
# if root ever sourced/EnvironmentFile-loaded this file, would redirect the
# AS-ROOT writes (resolve_ap_psk / password/ACL provisioning) at root-owned
# targets. The whitelist parse must consume ONLY the DROPLET_AP_*/DROPLET_GUEST_*
# keys and ignore the rest entirely.
CREDS="$WORK/openwrt-attach.env"
cat > "$CREDS" <<'EOF'
DROPLET_AP_SSID=CustomerNet
DROPLET_AP_PSK=customerhorse9
DROPLET_GUEST_SSID=GuestNet
DROPLET_GUEST_PSK=guestpass1234
DROPLET_GUEST_ENABLED=1
AP_PSK_FILE=/root/.ssh/authorized_keys
DEVICE_BRIDGE_ENV_FILE=/root/.ssh/authorized_keys
OPENWRT_PASSWORD_FILE=/etc/shadow
DROPLET_RPCD_ACL=/etc/cron.d/pwn
DROPLET_AP_PHY=phyEVIL
DROPLET_PUBLIC_FQDN=attacker.example.com
EOF

# Run the extracted parse with the whitelisted vars pre-seeded exactly as the
# attach body seeds them, pointing CUSTOMER_AP_ENV at the hostile file. Echo the
# post-parse values of BOTH the whitelisted keys and the attacker keys.
RESULT="$(
  DROPLET_CUSTOMER_AP_ENV="$CREDS" bash -c '
    AP_SSID="${DROPLET_AP_SSID:-Droplet}"
    AP_PSK="${DROPLET_AP_PSK:-}"
    GUEST_SSID="${DROPLET_GUEST_SSID:-}"
    GUEST_PSK="${DROPLET_GUEST_PSK:-}"
    GUEST_ENABLED="${DROPLET_GUEST_ENABLED:-0}"
    # These MUST stay empty — a whitelist parse never imports them.
    AP_PSK_FILE=""
    DEVICE_BRIDGE_ENV_FILE=""
    OPENWRT_PASSWORD_FILE=""
    DROPLET_RPCD_ACL=""
    AP_PHY=""
    PUBLIC_FQDN=""
    # shellcheck disable=SC1090
    . "'"$SNIP"'"
    printf "AP_SSID=%s\n" "$AP_SSID"
    printf "AP_PSK=%s\n" "$AP_PSK"
    printf "GUEST_SSID=%s\n" "$GUEST_SSID"
    printf "GUEST_PSK=%s\n" "$GUEST_PSK"
    printf "GUEST_ENABLED=%s\n" "$GUEST_ENABLED"
    printf "AP_PSK_FILE=%s\n" "${AP_PSK_FILE:-}"
    printf "DEVICE_BRIDGE_ENV_FILE=%s\n" "${DEVICE_BRIDGE_ENV_FILE:-}"
    printf "OPENWRT_PASSWORD_FILE=%s\n" "${OPENWRT_PASSWORD_FILE:-}"
    printf "DROPLET_RPCD_ACL=%s\n" "${DROPLET_RPCD_ACL:-}"
    printf "AP_PHY=%s\n" "${AP_PHY:-}"
    printf "PUBLIC_FQDN=%s\n" "${PUBLIC_FQDN:-}"
  ' 2>/dev/null
)"

get() { printf '%s\n' "$RESULT" | grep -m1 "^$1=" | cut -d= -f2-; }

# Whitelisted keys ARE consumed (the customer's Wi-Fi actually applies).
[ "$(get AP_SSID)" = "CustomerNet" ] \
  && pass "whitelisted DROPLET_AP_SSID is consumed (customer SSID applies)" \
  || fail "DROPLET_AP_SSID not consumed (got '$(get AP_SSID)')"
[ "$(get AP_PSK)" = "customerhorse9" ] \
  && pass "whitelisted DROPLET_AP_PSK is consumed" \
  || fail "DROPLET_AP_PSK not consumed (got '$(get AP_PSK)')"
[ "$(get GUEST_SSID)" = "GuestNet" ] \
  && pass "whitelisted DROPLET_GUEST_SSID is consumed" \
  || fail "DROPLET_GUEST_SSID not consumed (got '$(get GUEST_SSID)')"
[ "$(get GUEST_PSK)" = "guestpass1234" ] \
  && pass "whitelisted DROPLET_GUEST_PSK is consumed" \
  || fail "DROPLET_GUEST_PSK not consumed (got '$(get GUEST_PSK)')"
[ "$(get GUEST_ENABLED)" = "1" ] \
  && pass "whitelisted DROPLET_GUEST_ENABLED is consumed" \
  || fail "DROPLET_GUEST_ENABLED not consumed (got '$(get GUEST_ENABLED)')"

# Attacker keys are IGNORED — a crafted extra key can never influence root.
for k in AP_PSK_FILE DEVICE_BRIDGE_ENV_FILE OPENWRT_PASSWORD_FILE DROPLET_RPCD_ACL AP_PHY PUBLIC_FQDN; do
  v="$(get "$k")"
  if [ -z "$v" ]; then
    pass "non-whitelisted key '$k' from the creds file is IGNORED (stays empty)"
  else
    fail "non-whitelisted key '$k' leaked into root's environment ('$v') — arbitrary-key injection"
  fi
done

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
if [ "$FAILURES" -ne 0 ]; then
  echo "  RESULT: FAIL ($FAILURES failing)"
  exit 1
fi
echo "  RESULT: PASS"
