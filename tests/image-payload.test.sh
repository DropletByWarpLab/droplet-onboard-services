#!/usr/bin/env bash
# =============================================================================
# tests/image-payload.test.sh — the ISO client-app payload is a TWO-PART
# contract, and this reconciles the halves (WARP-2666).
#
#   scripts/image/build-iso.sh          bakes data/app-downloads onto the ISO
#   scripts/image/autoinstall/user-data copies it off /cdrom into the checkout
#
# Either half alone is useless, and silently so:
#   - bake without copy  → bytes ride the ISO and never reach the box, because
#     data/app-downloads is git-ignored and the box gets its code from a fresh
#     `git clone`. /downloads stays exactly as blank as before.
#   - copy without bake  → the copy finds nothing and (deliberately) says so
#     without failing the install.
#
# Neither half breaks a build, a boot or any other test when it drifts. The
# only thing that would notice is a customer opening "Get the app" on a
# shipped box — which is precisely the feedback loop that let this ship empty
# in the first place. So the paths are pinned here, in both directions.
#
# Static: greps and a YAML parse. No docker, no xorriso, no ISO, no network.
# Runtime: < 2 seconds. Requires: bash, python3 (+ PyYAML).
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_ISO="$REPO_ROOT_REAL/scripts/image/build-iso.sh"
USER_DATA="$REPO_ROOT_REAL/scripts/image/autoinstall/user-data"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  image payload — build-iso.sh ↔ autoinstall"
echo "  ================================================"
echo ""

for f in "$BUILD_ISO" "$USER_DATA"; do
  if [ -f "$f" ]; then pass "exists: ${f#"$REPO_ROOT_REAL"/}"
  else fail "missing: ${f#"$REPO_ROOT_REAL"/}"; echo "FAILURES=$FAILURES"; exit 1; fi
done
command -v python3 >/dev/null 2>&1 || { fail "python3 is required"; echo "FAILURES=$FAILURES"; exit 1; }

# --- 1. the builder half -----------------------------------------------------
if grep -qE '^[[:space:]]+-v "\$\{APP_DOWNLOADS_DIR\}:/payload:ro"' "$BUILD_ISO"; then
  pass "build-iso.sh bind-mounts the staging root at /payload (read-only)"
else
  fail "build-iso.sh does not mount \$APP_DOWNLOADS_DIR at /payload:ro"
fi

# The ISO-side destination, read out of the xorriso -map rather than assumed.
ISO_PATH="$(grep -oE '\-map /payload [^ ]+' "$BUILD_ISO" | awk '{print $3}' | head -1)"
if [ -n "$ISO_PATH" ]; then
  pass "build-iso.sh maps /payload onto the ISO at $ISO_PATH"
else
  fail "build-iso.sh has no '-map /payload <iso-path>' argument"
fi

# The pre-flight and the payload MUST read the same directory, or the gate
# audits one tree while the build bakes another — a green build that ships
# something nobody checked.
if grep -qE 'bash "\$AUDIT_SH" --dir "\$APP_DOWNLOADS_DIR"' "$BUILD_ISO"; then
  pass "the step-0 audit and the payload read the SAME directory"
else
  fail "the pre-flight audits a different path than the one baked onto the ISO"
fi

# --- 2. the autoinstall half -------------------------------------------------
# Pull the copy step out of the parsed YAML, so a change to the file's shape
# cannot make these assertions quietly stop applying.
PAYLOAD_STEP="$(python3 - "$USER_DATA" <<'PY'
import sys, yaml
with open(sys.argv[1], encoding="utf-8") as fh:
    doc = yaml.safe_load(fh)
for cmd in doc["autoinstall"]["late-commands"]:
    if isinstance(cmd, str) and "app-downloads" in cmd:
        print(cmd)
        break
PY
)"

if [ -n "$PAYLOAD_STEP" ]; then
  pass "user-data has a late-command that handles the app-downloads payload"
else
  fail "no late-command in user-data mentions app-downloads"
  echo "FAILURES=$FAILURES"; exit 1
fi

# THE load-bearing one. Every other late-command is `curtin in-target`, which
# chroots into /target where /cdrom does not exist. Converting this step to
# in-target "for consistency" would copy nothing, forever, silently.
if printf '%s' "$PAYLOAD_STEP" | grep -q 'in-target'; then
  fail "the payload copy runs under 'curtin in-target' — /cdrom is NOT visible there, so it would copy nothing"
else
  pass "the payload copy runs BARE, not under curtin in-target (/cdrom is only in the installer env)"
fi

# It must write through to /target, since it is not chrooted.
if printf '%s' "$PAYLOAD_STEP" | grep -q '/target/home/droplet/edge-platform/data/app-downloads'; then
  pass "the copy writes through to /target/home/droplet/edge-platform/data/app-downloads"
else
  fail "the copy does not write to the /target-prefixed checkout path"
fi

# --- 3. the two halves agree -------------------------------------------------
WANT_SRC="/cdrom${ISO_PATH}"
if printf '%s' "$PAYLOAD_STEP" | grep -qF "$WANT_SRC"; then
  pass "autoinstall reads $WANT_SRC — matches build-iso.sh's -map destination"
else
  fail "PATH DRIFT: build-iso.sh maps to $ISO_PATH, so autoinstall must read $WANT_SRC"
  printf '%s\n' "$PAYLOAD_STEP" | sed 's/^/      | /'
fi

# --- 4. ordering -------------------------------------------------------------
# The copy must land after the clone (which creates the directory) and before
# the chown (which is what makes the copied files operator-writable).
ORDER="$(python3 - "$USER_DATA" <<'PY'
import sys, yaml
with open(sys.argv[1], encoding="utf-8") as fh:
    doc = yaml.safe_load(fh)
clone = payload = chown = -1
for i, cmd in enumerate(doc["autoinstall"]["late-commands"]):
    s = str(cmd)
    if "git clone" in s and clone < 0: clone = i
    if "app-downloads" in s and payload < 0: payload = i
    if "chown -R droplet:droplet" in s and chown < 0: chown = i
print(clone, payload, chown)
PY
)"
read -r I_CLONE I_PAYLOAD I_CHOWN <<< "$ORDER"
if [ "$I_CLONE" -ge 0 ] && [ "$I_PAYLOAD" -gt "$I_CLONE" ]; then
  pass "the copy runs AFTER the clone that creates the checkout (#$I_CLONE → #$I_PAYLOAD)"
else
  fail "the copy does not run after the clone (clone=#$I_CLONE payload=#$I_PAYLOAD)"
fi
if [ "$I_CHOWN" -gt "$I_PAYLOAD" ]; then
  pass "the chown runs AFTER the copy, so root-owned ISO files end up operator-owned (#$I_PAYLOAD → #$I_CHOWN)"
else
  fail "the chown runs BEFORE the copy — copied files stay root-owned and the operator cannot re-stage (payload=#$I_PAYLOAD chown=#$I_CHOWN)"
fi

# --- 5. it must not be able to brick an install ------------------------------
# The clone is deliberately fatal; this is deliberately not. A box with no
# client installers has an honest empty page the audit reports; aborting an
# otherwise good install over it is the wrong trade.
if printf '%s' "$PAYLOAD_STEP" | grep -qE 'set \+e|\|\| true|^ *true$|2>/dev/null'; then
  pass "the copy is guarded, so a missing or unreadable payload cannot abort the install"
else
  fail "the copy is unguarded — a failure here would abort an otherwise good install"
fi

# --- 6. mutation: prove the drift guard can actually fail --------------------
MUT="$(printf '%s' "$PAYLOAD_STEP" | sed "s#${WANT_SRC}#/cdrom/somewhere-else#")"
if printf '%s' "$MUT" | grep -qF "$WANT_SRC"; then
  fail "the drift guard still matches after the source path was changed — it cannot fail"
else
  pass "the drift guard goes red when the autoinstall source path is changed (mutation)"
fi
MUT_INTARGET="curtin in-target --target=/target -- cp -a /cdrom/droplet/app-downloads/. /dst/"
if printf '%s' "$MUT_INTARGET" | grep -q 'in-target'; then
  pass "the in-target guard recognises a converted step (mutation)"
else
  fail "the in-target guard would not notice the step being chrooted"
fi

echo ""
echo "  ------------------------------------------------"
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mAll %d checks passed\033[0m\n\n" "$TESTS"
else
  printf "  \033[31m%d of %d checks FAILED\033[0m\n\n" "$FAILURES" "$TESTS"
fi
echo "FAILURES=$FAILURES"
[ "$FAILURES" -eq 0 ]
