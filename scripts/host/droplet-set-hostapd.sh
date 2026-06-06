#!/usr/bin/env bash
# =============================================================================
# WARP-808 — Droplet single-box hostapd Wi-Fi write host executor
# =============================================================================
#
# The ONLY place the single-box Wi-Fi SSID/PSK is written. Repo-tracked
# (architecture-guard rule 20) and installed to
# /usr/local/sbin/droplet-set-hostapd.sh by setup.sh via
# scripts/install-device-bridge.sh — never hand-placed on a box.
#
# Invoked ONLY by the device-bridge's auth-gated POST /openwrt/wifi/hostapd,
# which the orchestrator reaches ONLY after an owner/admin session (+ the
# Tier-2 confirm on the password path). The AI can never reach this.
#
# The single-box AP is a raw `hostapd -B` in the droplet-openwrt container,
# configured from /etc/hostapd.conf, which is REGENERATED from
# DROPLET_AP_SSID / DROPLET_AP_PSK by /usr/local/sbin/droplet-openwrt-attach
# every time droplet-openwrt-attach.service runs. So writing the Wi-Fi name +
# key is: upsert those two keys in the attach service's env file, then restart
# the service (its HOSTAPD_CHANGED gate respawns hostapd with the new conf).
#
# Usage:
#   droplet-set-hostapd.sh '<json-params>'      # {"ssid": "...", "psk": "..."}
#
# HARD VALIDATION (reject BEFORE writing — a bad value bricks the AP):
#   - ssid: 1-32 characters (hostapd/IEEE 802.11 SSID limit).
#   - psk : 8-63 characters (WPA-PSK passphrase limit). A PSK outside this
#           range makes hostapd refuse to start, taking the AP offline; we must
#           never write it. Mirrors services/routing/schemas.py + the
#           InternetStep client-side check.
#
# SECRET HANDLING (architecture-guard rule 19): the PSK is a per-device secret.
# It is written to a 0600 env file and is NEVER printed to stdout/stderr — not
# in the success JSON, not in any log line.
#
# Idempotent: writing the same creds twice yields a byte-identical env file and
# (because droplet-openwrt-attach only respawns hostapd when /etc/hostapd.conf
# actually changes) no AP reload. Exactly one AP reload per changed submit.
#
# Test/dev hooks (so validation + upsert are unit-testable without root):
#   DROPLET_HOSTAPD_DRY_RUN=1     report the restart instead of running it
#   DROPLET_HOSTAPD_ENV_FILE=...  override the env-file path (default
#                                 /etc/default/droplet-openwrt-attach)
#
# Output: a single JSON object on stdout on success; a human refusal on stderr
# + a non-zero exit on any validation failure.
# =============================================================================
set -euo pipefail

PARAMS_JSON="${1:-}"

DRY_RUN="${DROPLET_HOSTAPD_DRY_RUN:-}"
ENV_FILE="${DROPLET_HOSTAPD_ENV_FILE:-/etc/default/droplet-openwrt-attach}"
ATTACH_SERVICE="${DROPLET_HOSTAPD_SERVICE:-droplet-openwrt-attach.service}"

# SSID/PSK length bounds — keep in lock-step with services/routing/schemas.py
# and apps/web-dashboard/.../InternetStep.tsx.
SSID_MIN=1
SSID_MAX=32
PSK_MIN=8
PSK_MAX=63

err() { printf 'droplet-set-hostapd: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

[ -n "$PARAMS_JSON" ] || die "no params given (expected JSON {ssid, psk})"

# --- JSON field extraction (python3 is a host dep; see install-device-bridge) -
# Reads one top-level string field from $PARAMS_JSON. Never evals; pure
# json.loads. Exits non-zero (and prints a marker the caller treats as missing)
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

# Fail closed on malformed JSON: run the extractor once; a non-zero exit means
# the body wasn't valid JSON at all.
if ! SSID="$(json_field ssid)"; then
  die "invalid JSON params"
fi
PSK="$(json_field psk)"

# --- Validation (BEFORE any write) -------------------------------------------
# Length is measured in characters. We never echo the PSK value in any message.
ssid_len=${#SSID}
psk_len=${#PSK}

# SECURITY (WARP-808): reject any control character (byte < 0x20, plus DEL) in
# the SSID or PSK BEFORE writing. The value is written verbatim as a `KEY=VALUE`
# line in the systemd EnvironmentFile; an embedded newline would inject a SECOND
# assignment (e.g. an SSID of "foo\nDROPLET_AP_PSK=attacker" would override the
# AP key — an env-file injection). Length validation alone does NOT catch this:
# a newline counts as one "character". Control chars are never valid in an
# 802.11 SSID or a WPA passphrase either, so this can't reject a legitimate
# value (a UTF-8 SSID's multi-byte printable runs are NOT in [[:cntrl:]], which
# resolves to the ASCII control range in both the C and UTF-8 locales).
if [[ "$SSID" == *[[:cntrl:]]* ]]; then
  die "network name (SSID) must not contain control characters (e.g. line breaks)"
fi
if [[ "$PSK" == *[[:cntrl:]]* ]]; then
  # Never echo the value — only the reason.
  die "Wi-Fi password must not contain control characters (e.g. line breaks)"
fi

if [ "$ssid_len" -lt "$SSID_MIN" ] || [ "$ssid_len" -gt "$SSID_MAX" ]; then
  die "network name (SSID) must be ${SSID_MIN}-${SSID_MAX} characters (got ${ssid_len})"
fi
if [ "$psk_len" -lt "$PSK_MIN" ] || [ "$psk_len" -gt "$PSK_MAX" ]; then
  # Report only the length, never the value.
  die "Wi-Fi password must be ${PSK_MIN}-${PSK_MAX} characters (got ${psk_len})"
fi

# --- Idempotent upsert of the attach-service env file ------------------------
# Update DROPLET_AP_SSID / DROPLET_AP_PSK in place, preserving every other key
# (DROPLET_AP_PHY / DROPLET_AP_IFACE etc. — the operator's hardware pinning).
# Done atomically via a temp file in the same dir + mv, so a concurrent reader
# (the systemd EnvironmentFile load) never sees a half-written file. The temp
# file is created 0600 so the PSK is never briefly group/world-readable.

ENV_DIR="$(dirname "$ENV_FILE")"
mkdir -p "$ENV_DIR"

# upsert_kv <key> <value> — write to $TMP (built from the current $ENV_FILE).
# Uses python for the rewrite so the value is treated as an opaque literal (no
# shell/sed metacharacter surprises in an SSID/PSK).
upsert_env_file() {
  ENV_FILE="$ENV_FILE" UP_SSID="$SSID" UP_PSK="$PSK" python3 - <<'PY'
import os, sys
path = os.environ["ENV_FILE"]
ssid = os.environ["UP_SSID"]
psk  = os.environ["UP_PSK"]
# Defense in depth (WARP-808): the bash validation above already rejects control
# characters, but this is the layer that actually builds the `KEY=VALUE` lines —
# fail closed here too so a control char can never be written into the
# EnvironmentFile (a newline would inject a second assignment / override another
# key). Never print the value.
for label, value in (("SSID", ssid), ("PSK", psk)):
    if any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in value):
        sys.stderr.write(
            "droplet-set-hostapd: {} must not contain control characters\n".format(label))
        sys.exit(2)
updates = {"DROPLET_AP_SSID": ssid, "DROPLET_AP_PSK": psk}
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
    # Replace an existing (or commented-out) assignment in place.
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
# Append any key that wasn't already present.
for key, val in updates.items():
    if key not in seen:
        out.append("{}={}".format(key, val))
# Always LF-terminate; one trailing newline.
sys.stdout.reconfigure(newline="\n")
sys.stdout.write("\n".join(out) + "\n")
PY
}

TMP="$(mktemp "${ENV_DIR}/.droplet-openwrt-attach.XXXXXX")"
# Lock perms before any secret is written into it.
chmod 0600 "$TMP"
trap 'rm -f "$TMP"' EXIT
upsert_env_file > "$TMP"
# Atomic replace; re-assert 0600 on the final file (mktemp gave us the temp).
mv "$TMP" "$ENV_FILE"
trap - EXIT
chmod 0600 "$ENV_FILE"

emit_ok() {
  # Single-line JSON the bridge parses with json.loads. NEVER include the PSK.
  printf '{"ok": true, "ssid": %s, "restarted": %s, "dry_run": %s}\n' \
    "$(SSID="$SSID" python3 -c 'import json,os;print(json.dumps(os.environ["SSID"]))')" \
    "$([ -n "$DRY_RUN" ] && echo false || echo true)" \
    "$([ -n "$DRY_RUN" ] && echo true || echo false)"
}

# --- Restart the attach service to apply -------------------------------------
# droplet-openwrt-attach regenerates /etc/hostapd.conf from the env file and,
# via its HOSTAPD_CHANGED gate, respawns hostapd ONLY when the conf actually
# changed — so an identical re-submit causes no AP reload (AC4).
if [ -n "$DRY_RUN" ]; then
  err "dry-run: wrote ${ENV_FILE}; would run: systemctl restart ${ATTACH_SERVICE}"
  emit_ok
  exit 0
fi

systemctl restart "$ATTACH_SERVICE"
emit_ok
