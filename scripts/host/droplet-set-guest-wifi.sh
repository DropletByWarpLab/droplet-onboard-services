#!/usr/bin/env bash
# =============================================================================
# Droplet single-box guest Wi-Fi host executor
# =============================================================================
#
# The ONLY place the single-box GUEST Wi-Fi (a second hostapd BSS on the same
# radio) is written. Repo-tracked (architecture-guard rule 20) and installed to
# /usr/local/sbin/droplet-set-guest-wifi.sh by setup.sh via
# scripts/install-device-bridge.sh — never hand-placed on a box.
#
# Sibling of droplet-set-hostapd.sh (WARP-808): that script writes the PRIMARY
# (home) AP's SSID/PSK; this one writes the optional, isolated GUEST network.
# Both upsert keys in the SAME droplet-openwrt-attach env file and restart that
# one service — droplet-openwrt-attach regenerates /etc/hostapd.conf (now with a
# second `bss=` stanza for the guest SSID), stands up the guest L3 subnet
# (192.168.30.0/24) + a dedicated dnsmasq-guest + an isolated `droplet_guest`
# firewall zone, and respawns hostapd. The bridge sandbox can't touch hostapd /
# systemctl beyond that one polkit-granted unit restart, so this is the whole
# privileged surface.
#
# Invoked ONLY by the device-bridge's auth-gated POST/DELETE /openwrt/wifi/guest,
# which the orchestrator reaches ONLY after an owner/admin session (+ the Tier-2
# confirm on create). The AI can never reach this.
#
# Usage:
#   droplet-set-guest-wifi.sh '{"ssid":"...","psk":"..."}'   # create / enable
#   droplet-set-guest-wifi.sh '{"action":"remove"}'           # tear down
#
# HARD VALIDATION (reject BEFORE writing — a bad value bricks hostapd, taking the
# WHOLE radio down, home AP included):
#   - ssid: 1-32 characters (hostapd/IEEE 802.11 SSID limit).
#   - psk : 8-63 characters (WPA-PSK passphrase limit).
#   - no control characters in either (env-file injection guard, mirrors
#     droplet-set-hostapd.sh — a newline would inject a second KEY=VALUE line).
# Remove needs no creds: it clears DROPLET_GUEST_SSID/PSK and sets
# DROPLET_GUEST_ENABLED=0, so guest_status reads back configured:false.
#
# SECRET HANDLING (architecture-guard rule 19): the guest PSK is a per-device
# secret. It is written to a 0600 env file and is NEVER printed to stdout/stderr.
#
# Idempotent: writing the same creds twice yields a byte-identical env file and
# (because droplet-openwrt-attach only respawns hostapd when /etc/hostapd.conf
# actually changes) no reload. Exactly one reload per changed submit.
#
# Test/dev hooks (so validation + upsert are unit-testable without root):
#   DROPLET_GUEST_DRY_RUN=1      report the restart instead of running it
#   DROPLET_GUEST_ENV_FILE=...   override the env-file path. In production the
#                                device-bridge pins it (falls back to
#                                DROPLET_HOSTAPD_ENV_FILE so the guest + home AP
#                                writes land in the SAME attach env file) —
#                                default /etc/default/droplet-openwrt-attach.
#
# Output: a single JSON object on stdout on success; a human refusal on stderr
# + a non-zero exit on any validation failure.
# =============================================================================
set -euo pipefail

PARAMS_JSON="${1:-}"

DRY_RUN="${DROPLET_GUEST_DRY_RUN:-}"
# Write to the SAME attach env file the home-AP write uses, so a single restart
# applies both. Prefer an explicit guest override, then the hostapd env file the
# bridge already pins, then the root default.
ENV_FILE="${DROPLET_GUEST_ENV_FILE:-${DROPLET_HOSTAPD_ENV_FILE:-/etc/default/droplet-openwrt-attach}}"
ATTACH_SERVICE="${DROPLET_GUEST_SERVICE:-droplet-openwrt-attach.service}"

# SSID/PSK length bounds — keep in lock-step with droplet-set-hostapd.sh,
# services/routing/schemas.py, and the GuestWifiCard client-side check.
SSID_MIN=1
SSID_MAX=32
PSK_MIN=8
PSK_MAX=63

err() { printf 'droplet-set-guest-wifi: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

[ -n "$PARAMS_JSON" ] || die "no params given (expected JSON {ssid, psk} or {action: remove})"

# --- JSON field extraction (python3 is a host dep; see install-device-bridge) -
# Reads one top-level string field. Never evals; pure json.loads. Exits non-zero
# when the JSON is malformed so we fail closed on garbage input.
json_field() {
  PARAMS_JSON="$PARAMS_JSON" python3 - "$1" <<'PY'
import json, os, sys
key = sys.argv[1]
try:
    data = json.loads(os.environ.get("PARAMS_JSON") or "")
except Exception:
    sys.exit(3)                       # bad JSON -> non-zero, no output
val = data.get(key) if isinstance(data, dict) else None
# Always end with a bare \n (never \r\n) so a CRLF host (Git-Bash) doesn't
# inherit a trailing \r into the SSID/PSK.
sys.stdout.reconfigure(newline="\n")
if val is not None:
    sys.stdout.write(str(val))
PY
}

# Fail closed on malformed JSON: a non-zero exit from the first extraction means
# the body wasn't valid JSON at all.
if ! ACTION="$(json_field action)"; then
  die "invalid JSON params"
fi

ENV_DIR="$(dirname "$ENV_FILE")"
mkdir -p "$ENV_DIR"

# upsert_guest_env_file <enabled> <ssid> <psk> — rewrite $ENV_FILE in place,
# updating ONLY the three DROPLET_GUEST_* keys and preserving every other key
# (DROPLET_AP_SSID/PSK, DROPLET_AP_PHY/IFACE — the home AP creds + operator
# hardware pinning). python builds the KEY=VALUE lines so the value is an opaque
# literal (no shell/sed metacharacter surprises) and fails closed on control
# characters (defense in depth — the bash guard already rejected them).
upsert_guest_env_file() {
  ENV_FILE="$ENV_FILE" UP_ENABLED="$1" UP_SSID="$2" UP_PSK="$3" python3 - <<'PY'
import os, sys
path = os.environ["ENV_FILE"]
enabled = os.environ["UP_ENABLED"]
ssid    = os.environ["UP_SSID"]
psk     = os.environ["UP_PSK"]
for label, value in (("SSID", ssid), ("PSK", psk)):
    if any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in value):
        sys.stderr.write(
            "droplet-set-guest-wifi: {} must not contain control characters\n".format(label))
        sys.exit(2)
updates = {
    "DROPLET_GUEST_ENABLED": enabled,
    "DROPLET_GUEST_SSID": ssid,
    "DROPLET_GUEST_PSK": psk,
}
try:
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
except FileNotFoundError:
    lines = []
seen = set()
out = []
for line in lines:
    stripped = line.lstrip()
    replaced = False
    for key, val in updates.items():
        if stripped == key + "=" or stripped.startswith(key + "=") \
           or stripped.startswith("#" + key + "=") \
           or stripped.startswith("# " + key + "="):
            out.append("{}={}".format(key, val))
            seen.add(key)
            replaced = True
            break
    if not replaced:
        out.append(line)
for key, val in updates.items():
    if key not in seen:
        out.append("{}={}".format(key, val))
sys.stdout.reconfigure(newline="\n")
sys.stdout.write("\n".join(out) + "\n")
PY
}

write_env() {
  # write_env <enabled> <ssid> <psk> — atomic 0600 replace (the temp file is
  # created 0600 so the PSK is never briefly group/world-readable).
  local enabled="$1" ssid="$2" psk="$3"
  local tmp
  tmp="$(mktemp "${ENV_DIR}/.droplet-openwrt-attach.XXXXXX")"
  chmod 0600 "$tmp"
  trap 'rm -f "$tmp"' EXIT
  upsert_guest_env_file "$enabled" "$ssid" "$psk" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  trap - EXIT
  chmod 0600 "$ENV_FILE"
}

apply_restart() {
  # Restart the attach service to regenerate hostapd.conf + the guest subnet.
  # droplet-openwrt-attach only respawns hostapd / reapplies when the conf
  # actually changed, so an identical re-submit causes no reload.
  if [ -n "$DRY_RUN" ]; then
    err "dry-run: wrote ${ENV_FILE}; would run: systemctl restart ${ATTACH_SERVICE}"
    return 0
  fi
  systemctl restart "$ATTACH_SERVICE"
}

# --- Teardown path -----------------------------------------------------------
# {"action":"remove"} clears the guest creds and disables the second BSS. No
# validation needed; the attach script's customer_guest_creds gate treats an
# empty/disabled guest as "tear it all down" (BSS, subnet, dnsmasq, firewall).
if [ "$ACTION" = "remove" ]; then
  write_env "0" "" ""
  printf '{"ok": true, "enabled": false, "removed": true, "restarted": %s, "dry_run": %s}\n' \
    "$([ -n "$DRY_RUN" ] && echo false || echo true)" \
    "$([ -n "$DRY_RUN" ] && echo true || echo false)"
  apply_restart
  exit 0
fi

# --- Create / enable path ----------------------------------------------------
SSID="$(json_field ssid)"
PSK="$(json_field psk)"

# Validation (BEFORE any write). Length is measured in characters; we never echo
# the PSK value in any message.
ssid_len=${#SSID}
psk_len=${#PSK}

if [[ "$SSID" == *[[:cntrl:]]* ]]; then
  die "guest network name (SSID) must not contain control characters (e.g. line breaks)"
fi
if [[ "$PSK" == *[[:cntrl:]]* ]]; then
  die "guest Wi-Fi password must not contain control characters (e.g. line breaks)"
fi
if [ "$ssid_len" -lt "$SSID_MIN" ] || [ "$ssid_len" -gt "$SSID_MAX" ]; then
  die "guest network name (SSID) must be ${SSID_MIN}-${SSID_MAX} characters (got ${ssid_len})"
fi
if [ "$psk_len" -lt "$PSK_MIN" ] || [ "$psk_len" -gt "$PSK_MAX" ]; then
  # Report only the length, never the value.
  die "guest Wi-Fi password must be ${PSK_MIN}-${PSK_MAX} characters (got ${psk_len})"
fi

write_env "1" "$SSID" "$PSK"

# Single-line JSON the bridge parses with json.loads. NEVER include the PSK.
printf '{"ok": true, "enabled": true, "ssid": %s, "restarted": %s, "dry_run": %s}\n' \
  "$(SSID="$SSID" python3 -c 'import json,os;print(json.dumps(os.environ["SSID"]))')" \
  "$([ -n "$DRY_RUN" ] && echo false || echo true)" \
  "$([ -n "$DRY_RUN" ] && echo true || echo false)"

apply_restart
