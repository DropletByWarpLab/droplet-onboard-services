#!/usr/bin/env bash
# =============================================================================
# WARP-826 — unit tests for the OpenWrt-container READINESS POLL inside
# scripts/lib/single-box.sh::provision_single_box_openwrt.
#
# Bug (static analysis, ADR-018 / WARP-578 lineage): the provisioner waited
# only for `docker inspect .State.Running == true` (≤60s) and then kicked the
# attach. `.State.Running` flips true the instant the container's PID 1 starts —
# seconds BEFORE OpenWrt's procd/ubus are actually up. On a freshly (re)created
# container (e.g. after factory-reset wiped openwrt-config/overlay) the attach
# then docker-exec'd against a not-yet-ready rootfs (ubus not answering), so the
# AP/RPC bootstrap raced and the router came up offline. And because the attach
# systemd unit is a oneshot/RemainAfterExit, it does NOT re-run on a container
# recreate on its own — the provisioner is the ONLY thing that re-kicks it.
#
# The fix: poll a real READINESS signal — the container is Running AND its ubus
# is answering (`ubus list` / `board_info` inside the container) — before
# kicking the attach, so attach always runs against a ready, freshly-recreated
# container.
#
# These tests do NOT require Docker or a real container. The readiness logic is
# a self-contained POSIX function delimited by sentinel markers; we extract it
# and run it against a stub `docker` whose readiness can be scripted via env, so
# we can assert: (a) it waits past "Running but ubus not ready", (b) it returns
# success once ubus answers, and (c) it gives up cleanly on a never-ready
# container without hanging. Mirrors tests/openwrt-attach-firewall.test.sh.
#
# Runtime: < 5 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB="$REPO_ROOT_REAL/scripts/lib/single-box.sh"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-826 — single-box.sh OpenWrt readiness poll"
echo "  ================================================"
echo ""

echo "--- Phase 1: function present + sentinel-delimited + no bare Running-only gate ---"

if [ -f "$LIB" ]; then
  pass "single-box.sh exists"
else
  fail "single-box.sh missing at $LIB"; echo "FAILURES=$FAILURES"; exit 1
fi

START_MARK="# >>> wait_for_openwrt_ready (WARP-826)"
END_MARK="# <<< wait_for_openwrt_ready (WARP-826)"

if grep -qF "$START_MARK" "$LIB" && grep -qF "$END_MARK" "$LIB"; then
  pass "wait_for_openwrt_ready sentinel markers present"
else
  fail "wait_for_openwrt_ready sentinel markers ('$START_MARK' .. '$END_MARK') missing"
fi

if grep -qE "^[[:space:]]*wait_for_openwrt_ready\b" "$LIB"; then
  pass "wait_for_openwrt_ready is invoked by provision_single_box_openwrt"
else
  fail "wait_for_openwrt_ready is never called in provision_single_box_openwrt"
fi

# Guardrail: the readiness function must probe ubus inside the container, not
# only `.State.Running`. We require an `ubus` probe via `docker exec`.
START_LINE=$(grep -nF "$START_MARK" "$LIB" | head -1 | cut -d: -f1)
END_LINE=$(grep -nF "$END_MARK" "$LIB" | head -1 | cut -d: -f1)
if [ -n "$START_LINE" ] && [ -n "$END_LINE" ]; then
  BODY="$(sed -n "${START_LINE},${END_LINE}p" "$LIB")"
  if printf '%s' "$BODY" | grep -q 'docker exec' && printf '%s' "$BODY" | grep -q 'ubus'; then
    pass "readiness probes ubus inside the container (docker exec ... ubus), not just .State.Running"
  else
    fail "readiness does not probe ubus via docker exec — Running-only is the bug being fixed"
  fi
else
  fail "could not locate the function body to inspect the ubus probe"
fi

echo "--- Phase 2: behavioral run with a scriptable stub docker ---"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Extract the function body.
sed -n "/$(printf '%s' "$START_MARK" | sed 's/[][\\.*^$/]/\\&/g')/,/$(printf '%s' "$END_MARK" | sed 's/[][\\.*^$/]/\\&/g')/p" \
  "$LIB" > "$WORK/func.sh"
if [ -s "$WORK/func.sh" ]; then
  pass "extracted wait_for_openwrt_ready function body"
else
  fail "could not extract function body — skipping behavioral asserts"
  echo ""; echo "  $((TESTS - FAILURES))/$TESTS passed"; echo "FAILURES=$FAILURES"
  [ "$FAILURES" -eq 0 ] || exit 1
  exit 0
fi

mkdir -p "$WORK/bin"

# Stub `docker`. Readiness is scripted by two counter files in $WORK:
#   running_after  — `docker inspect .State.Running` returns "true" once the
#                    call count reaches this threshold (simulates a container
#                    that takes a couple of polls to come up).
#   ubus_after     — `docker exec ... ubus ...` succeeds (exit 0) once the call
#                    count reaches this threshold (simulates ubus/procd starting
#                    AFTER the container is Running).
# A threshold of 0 means "always". A huge threshold means "never".
cat > "$WORK/bin/docker" <<'DOCKERSTUB'
#!/usr/bin/env bash
STATE_DIR="${DOCKER_STUB_STATE:?DOCKER_STUB_STATE unset}"
running_after="$(cat "$STATE_DIR/running_after" 2>/dev/null || echo 0)"
ubus_after="$(cat "$STATE_DIR/ubus_after" 2>/dev/null || echo 0)"

case "$1" in
  inspect)
    # docker inspect -f '{{.State.Running}}' droplet-openwrt
    n=$(( $(cat "$STATE_DIR/inspect_calls" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$STATE_DIR/inspect_calls"
    if [ "$n" -ge "$running_after" ]; then echo "true"; else echo "false"; fi
    exit 0
    ;;
  exec)
    # docker exec droplet-openwrt <ubus probe ...>
    n=$(( $(cat "$STATE_DIR/exec_calls" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$STATE_DIR/exec_calls"
    if [ "$n" -ge "$ubus_after" ]; then exit 0; else exit 1; fi
    ;;
  *) exit 0 ;;
esac
DOCKERSTUB
chmod +x "$WORK/bin/docker"

# Provide a no-op `sleep` so the poll loop doesn't actually wait wall-clock time
# in-test (the function should sleep between polls in production).
cat > "$WORK/bin/sleep" <<'SLEEPSTUB'
#!/usr/bin/env bash
exit 0
SLEEPSTUB
chmod +x "$WORK/bin/sleep"

# Run the readiness function with scripted thresholds. Returns its exit code.
run_ready() {
  local running_after="$1" ubus_after="$2"
  local sd="$WORK/state"
  rm -rf "$sd"; mkdir -p "$sd"
  printf '%s' "$running_after" > "$sd/running_after"
  printf '%s' "$ubus_after"   > "$sd/ubus_after"
  PATH="$WORK/bin:$PATH" \
  DOCKER_STUB_STATE="$sd" \
  OPENWRT_READY_TRIES="${OPENWRT_READY_TRIES:-8}" \
  OPENWRT_READY_INTERVAL=0 \
  bash -c "
    set +e
    # logging shims the function may call
    log_info() { :; }; log_warn() { :; }; log_success() { :; }; log_error() { :; }
    # shellcheck disable=SC1090
    . '$WORK/func.sh'
    wait_for_openwrt_ready
  "
}

# --- Case A: ready almost immediately (Running on poll 1, ubus on poll 1) -----
if run_ready 1 1 >/dev/null 2>&1; then
  pass "returns success when container is Running AND ubus answers"
else
  fail "did not return success for an immediately-ready container"
fi

# --- Case B: Running early but ubus only after a few polls (THE fix) ----------
# Running from poll 1, but ubus not until poll 3. The OLD Running-only gate would
# have returned after poll 1 (container "ready" but ubus down). The new poll must
# keep waiting until ubus answers, then succeed.
if run_ready 1 3 >/dev/null 2>&1; then
  pass "waits past 'Running but ubus not ready' and succeeds once ubus answers (core fix)"
else
  fail "gave up before ubus became ready — Running-only behavior not fixed"
fi

# --- Case C: container never becomes ready — give up cleanly, non-zero --------
# ubus_after huge → never ready within OPENWRT_READY_TRIES. Must return non-zero
# (so the caller can warn + skip) and must NOT hang.
OPENWRT_READY_TRIES=4
if run_ready 1 9999 >/dev/null 2>&1; then
  fail "returned success for a never-ready container — should give up non-zero"
else
  pass "gives up cleanly (non-zero) when readiness never arrives (no hang)"
fi
unset OPENWRT_READY_TRIES

echo "--- Phase 3: provision_single_box_openwrt still re-kicks attach on recreate ---"

# The provisioner must still systemctl-restart the attach unit AFTER readiness,
# because the boot-time oneshot does not re-run on a container recreate. Assert
# the restart call survives the refactor (static check on the function body).
PROV_START=$(grep -nF "provision_single_box_openwrt()" "$LIB" | head -1 | cut -d: -f1)
if [ -n "$PROV_START" ]; then
  PROV_BODY="$(sed -n "${PROV_START},$((PROV_START + 60))p" "$LIB")"
  if printf '%s' "$PROV_BODY" | grep -q 'systemctl restart droplet-openwrt-attach'; then
    pass "provision still systemctl-restarts droplet-openwrt-attach (re-runs on recreate)"
  else
    fail "provision no longer restarts the attach unit — it would not re-run on a fresh container"
  fi
  if printf '%s' "$PROV_BODY" | grep -q 'wait_for_openwrt_ready'; then
    pass "provision gates the attach behind wait_for_openwrt_ready (readiness, not Running-only)"
  else
    fail "provision does not call wait_for_openwrt_ready before kicking attach"
  fi
else
  fail "could not find provision_single_box_openwrt to verify the attach re-kick"
fi

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
if [ "$FAILURES" -ne 0 ]; then
  echo "  RESULT: FAIL ($FAILURES failing)"
  exit 1
fi
echo "  RESULT: PASS"
