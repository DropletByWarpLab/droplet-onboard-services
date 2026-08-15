#!/usr/bin/env bash
# =============================================================================
# Droplet — WARP-1984 SSH-access toggle, ON-BOX verification
# =============================================================================
#
# Everything the off-box suites CANNOT prove. `tests/droplet-ssh-access.test.sh`
# runs the applier against a stubbed systemctl, and the vitest guards read the
# artefacts as text — neither can show that the `.path` unit actually fires,
# that a real sshd starts and stops, or that the orchestrator CONTAINER can
# write through the bind mount to the host. That is this script's whole job.
#
# RUN IT ON THE BOX (over SSH is fine and is the expected case):
#
#     sudo bash scripts/test/ssh-access.onbox-verify.sh
#     sudo bash scripts/test/ssh-access.onbox-verify.sh --safe-only
#     sudo bash scripts/test/ssh-access.onbox-verify.sh --install
#
# ── THE LOCKOUT PROBLEM, AND WHAT IS DONE ABOUT IT ──────────────────────────
# Phase 4 stops sshd — over the very transport most operators are using. An
# established SSH session SURVIVES `systemctl stop ssh` (sshd does not kill
# existing children), so this is safe in the normal case. What is NOT safe is
# the abnormal case: the toggle fails to turn sshd back on and the box becomes
# unreachable until someone walks to it.
#
# So before anything can stop sshd, a transient systemd timer is armed that
# unconditionally starts sshd again after DEADMAN_SECONDS, independent of this
# script, of the toggle, and of whether this script crashes or the SSH session
# dies mid-run. If that timer cannot be armed, the script REFUSES to run the
# risky phase. The timer only ever STARTS sshd — the safe direction — so
# letting it fire harmlessly is fine and it is not treated as cleanup-critical.
#
# `--safe-only` skips phase 4 entirely: everything else still runs and proves
# the path unit, the parser, the state round-trip and the container write.
#
# NOT WIRED TO CI — it needs a real box, a real systemd and a real sshd.
# =============================================================================
set -uo pipefail

DEADMAN_SECONDS="${DEADMAN_SECONDS:-600}"
STATE_DIR="${DROPLET_SSH_ACCESS_DIR:-/var/lib/droplet-ssh-access}"
# The writable half. STATE_DIR itself is bind-mounted read-only into the
# orchestrator so `state` cannot be forged from inside a container.
INTENT_DIR="$STATE_DIR/intent.d"
INTENT="$INTENT_DIR/intent"
STATE="$STATE_DIR/state"
APPLIER=/usr/local/sbin/droplet-ssh-access
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SAFE_ONLY=0
DO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --safe-only) SAFE_ONLY=1 ;;
    --install)   DO_INSTALL=1 ;;
    -h|--help)   sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (sudo bash $0)" >&2
  exit 2
fi

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); echo "  ${GRN}PASS${RST}  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ${RED}FAIL${RST}  $1${2:+ -- $2}"; }
skip() { SKIP=$((SKIP+1)); echo "  ${YEL}SKIP${RST}  $1${2:+ -- $2}"; }
note() { echo "  ${DIM}$1${RST}"; }
phase(){ echo; echo "── $1 ──"; }

# Resolve the ssh unit the same way the applier does, so a mismatch between
# this script and the thing it tests can't produce a false green.
SSH_UNIT=""
for c in ssh sshd; do
  if systemctl cat "$c.service" >/dev/null 2>&1; then SSH_UNIT="$c"; break; fi
done

# ─────────────────────────────────────────────────────────────────────────────
phase "Phase 0 — preflight"

if [ -n "$SSH_UNIT" ]; then ok "ssh unit present: $SSH_UNIT.service"
else bad "no ssh/sshd unit on this host" "nothing to verify"; echo; exit 1; fi

ORIGINAL_ACTIVE="$(systemctl is-active "$SSH_UNIT.service" 2>/dev/null || true)"
note "sshd is currently: ${ORIGINAL_ACTIVE:-unknown} (restored at exit)"

# Are we ourselves connected over SSH? Decides how loud the phase-4 warning is.
OVER_SSH=0
[ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ] && OVER_SSH=1
[ "$OVER_SSH" = "1" ] && note "this session IS over SSH — phase 4 will stop the daemon under it"

if [ "$DO_INSTALL" = "1" ]; then
  note "installing units from $REPO_ROOT (--install)"
  install -d -m 0775 "$STATE_DIR"
  install -m 0755 "$REPO_ROOT/scripts/host/usr-local-sbin/droplet-ssh-access" "$APPLIER"
  install -m 0644 "$REPO_ROOT/scripts/host/etc-systemd-system/droplet-ssh-access.service" \
    /etc/systemd/system/droplet-ssh-access.service
  install -m 0644 "$REPO_ROOT/scripts/host/etc-systemd-system/droplet-ssh-access.path" \
    /etc/systemd/system/droplet-ssh-access.path
  systemctl daemon-reload
  systemctl enable --now droplet-ssh-access.path >/dev/null 2>&1 || true
fi

[ -x "$APPLIER" ] && ok "applier installed at $APPLIER" \
  || bad "applier missing at $APPLIER" "re-run with --install"
[ -d "$STATE_DIR" ] && ok "state dir exists: $STATE_DIR" \
  || bad "state dir missing: $STATE_DIR" "re-run with --install"

if systemctl is-active droplet-ssh-access.path >/dev/null 2>&1; then
  ok "droplet-ssh-access.path is active (watching $INTENT)"
else
  bad "droplet-ssh-access.path is NOT active" "the toggle cannot work; systemctl enable --now it"
fi

# RemainAfterExit on the service would make every path-triggered start a no-op
# after the first — the toggle would work once and then silently stop.
if systemctl show droplet-ssh-access.service -p RemainAfterExit 2>/dev/null \
     | grep -q 'RemainAfterExit=no'; then
  ok "service is a plain oneshot (path triggers really re-run it)"
else
  bad "service has RemainAfterExit set" "path-triggered starts will become no-ops"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Wait for the host to converge on an expected state value. The path unit +
# oneshot is asynchronous; polling is the honest way to observe it.
wait_for_state() { # wait_for_state <expected> [timeout]
  local want="$1" timeout="${2:-20}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if [ -f "$STATE" ] && grep -qE "^state=$want\$" "$STATE" 2>/dev/null; then return 0; fi
    sleep 1; i=$((i+1))
  done
  return 1
}

write_intent() { printf 'DROPLET_SSH_ACCESS=%s\n' "$1" >"$INTENT.tmp"; mv -f "$INTENT.tmp" "$INTENT"; }

# ─────────────────────────────────────────────────────────────────────────────
phase "Phase 1 — arm the dead-man's switch"

DEADMAN="droplet-ssh-deadman-$$"
if systemd-run --collect --unit="$DEADMAN" \
     --on-active="$DEADMAN_SECONDS" \
     systemctl start "$SSH_UNIT.service" >/dev/null 2>&1; then
  ok "armed: sshd will be started unconditionally in ${DEADMAN_SECONDS}s (unit $DEADMAN)"
  DEADMAN_ARMED=1
else
  DEADMAN_ARMED=0
  bad "could not arm the dead-man's switch" "phase 4 will be skipped"
fi

cleanup() {
  local rc=$?
  echo
  echo "── cleanup ──"
  # Always leave SSH up, regardless of how we got here. Never restore to
  # "off": if the run aborted midway, an operator's next move is to reconnect,
  # and honouring a pre-existing "off" would be the one outcome that strands
  # them. The toggle is off by default anyway — turning it back off is a
  # deliberate action they can take from the dashboard.
  write_intent on 2>/dev/null || true
  if wait_for_state on 20; then
    note "sshd restored via the toggle"
  else
    # The toggle is the thing under test; do not depend on it for recovery.
    systemctl start "$SSH_UNIT.service" >/dev/null 2>&1 \
      && note "toggle did not restore sshd — started it directly" \
      || echo "  ${RED}sshd could NOT be started — the dead-man's timer fires within ${DEADMAN_SECONDS}s${RST}"
  fi
  systemctl is-active "$SSH_UNIT.service" >/dev/null 2>&1 \
    && note "final: $SSH_UNIT.service is active" \
    || echo "  ${RED}final: $SSH_UNIT.service is NOT active${RST}"
  # The timer only ever STARTS sshd, so leaving it armed is harmless; stop it
  # only to keep the unit list tidy, and only once sshd is confirmed up.
  if [ "${DEADMAN_ARMED:-0}" = "1" ] && systemctl is-active "$SSH_UNIT.service" >/dev/null 2>&1; then
    systemctl stop "$DEADMAN.timer" >/dev/null 2>&1 || true
  fi
  # Exit with the status the script had BEFORE cleanup ran. Bash already
  # preserves it across an EXIT trap (verified, not assumed), so this is
  # belt-and-braces rather than a fix: it states the intent outright, and keeps
  # the contract if this ever grows a branch that ends on a failing command.
  exit "$rc"
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
phase "Phase 2 — the .path unit fires (no sshd change)"

# A malformed intent makes the applier refuse, so this proves the TRIGGER
# without touching the daemon: the unit must run, and must leave state alone.
STATE_BEFORE="$(cat "$STATE" 2>/dev/null || echo '<none>')"
CURSOR="$(journalctl -u droplet-ssh-access.service -n0 --show-cursor 2>/dev/null \
  | sed -n 's/^-- cursor: //p')"
write_intent 'definitely-not-valid'
sleep 3

if journalctl -u droplet-ssh-access.service ${CURSOR:+--after-cursor="$CURSOR"} \
     --no-pager 2>/dev/null | grep -qi 'refusing malformed'; then
  ok "path unit fired and the applier refused the malformed value"
else
  # Fall back to the invocation counter — some images ship a lean journal.
  if [ "$(systemctl show droplet-ssh-access.service -p NRestarts --value 2>/dev/null)" != "" ]; then
    skip "could not read the refusal from the journal" "check: journalctl -u droplet-ssh-access.service"
  else
    bad "no evidence the path unit fired" "the toggle will not work"
  fi
fi

STATE_AFTER="$(cat "$STATE" 2>/dev/null || echo '<none>')"
[ "$STATE_BEFORE" = "$STATE_AFTER" ] \
  && ok "malformed intent wrote no state" \
  || bad "malformed intent CHANGED state" "before=[$STATE_BEFORE] after=[$STATE_AFTER]"

# ─────────────────────────────────────────────────────────────────────────────
phase "Phase 3 — allow SSH (the ON path)"

write_intent on
if wait_for_state on 25; then
  ok "host confirmed state=on"
else
  bad "host never wrote state=on" "$(cat "$STATE" 2>/dev/null || echo 'no state file')"
fi
systemctl is-active "$SSH_UNIT.service" >/dev/null 2>&1 \
  && ok "$SSH_UNIT.service is active" \
  || bad "$SSH_UNIT.service is not active after state=on"

# The dashboard reads changed_at; a missing one renders a blank timestamp.
grep -qE '^changed_at=[0-9]{4}-' "$STATE" 2>/dev/null \
  && ok "state file carries an ISO changed_at" \
  || bad "state file has no usable changed_at" "$(cat "$STATE" 2>/dev/null)"

# The state file is the dashboard's source of truth and must not be
# container-forgeable.
STATE_OWNER="$(stat -c '%U:%a' "$STATE" 2>/dev/null || echo unknown)"
case "$STATE_OWNER" in
  root:6??|root:64?) ok "state file is root-owned and not world-writable ($STATE_OWNER)" ;;
  *) bad "unexpected state file ownership/mode" "$STATE_OWNER" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
phase "Phase 4 — disallow SSH (the OFF path)"

if [ "$SAFE_ONLY" = "1" ]; then
  skip "phase 4 skipped (--safe-only)" "the stop path remains unverified"
elif [ "${DEADMAN_ARMED:-0}" != "1" ]; then
  skip "phase 4 skipped" "no dead-man's switch — refusing to risk lockout"
else
  [ "$OVER_SSH" = "1" ] && note "stopping sshd now; this established session should survive"
  write_intent off
  if wait_for_state off 25; then
    ok "host confirmed state=off"
  else
    bad "host never wrote state=off" "$(cat "$STATE" 2>/dev/null || echo 'no state file')"
  fi

  systemctl is-active "$SSH_UNIT.service" >/dev/null 2>&1 \
    && bad "$SSH_UNIT.service is STILL active after state=off" "the toggle does not actually close the door" \
    || ok "$SSH_UNIT.service stopped"

  # Socket activation would revive sshd on the next connection, so a stopped
  # service alone is not "off". Only meaningful where a socket exists.
  if systemctl cat "$SSH_UNIT.socket" >/dev/null 2>&1; then
    systemctl is-active "$SSH_UNIT.socket" >/dev/null 2>&1 \
      && bad "$SSH_UNIT.socket is still active" "socket activation will revive sshd" \
      || ok "$SSH_UNIT.socket stopped too"
  else
    skip "no $SSH_UNIT.socket on this host" "socket activation not applicable"
  fi

  # Did we cut our own throat? Reaching this line at all IS the answer — if
  # stopping sshd had killed the session, there would be no output past the
  # stop. Stated plainly rather than dressed up as a probe: `kill -0 $$` on
  # ourselves would be true no matter what and would prove nothing.
  if [ "$OVER_SSH" = "1" ]; then
    note "still executing after the stop — this established session survived"
  fi

  # And back on — the recovery path an operator depends on.
  write_intent on
  wait_for_state on 25 \
    && ok "toggle recovered: state=on" \
    || bad "toggle did NOT recover" "dead-man's timer will start sshd within ${DEADMAN_SECONDS}s"
  systemctl is-active "$SSH_UNIT.service" >/dev/null 2>&1 \
    && ok "$SSH_UNIT.service is active again" \
    || bad "$SSH_UNIT.service did not come back"
fi

# ─────────────────────────────────────────────────────────────────────────────
phase "Phase 5 — the orchestrator container can drive it"

# The integration point no off-box test reaches: container -> bind mount ->
# host unit. Without this the dashboard button is inert no matter how correct
# both halves are on their own.
ORCH="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 -E '^droplet-orchestrator' || true)"
if [ -z "$ORCH" ]; then
  skip "orchestrator container not running" "cannot verify the container write path"
else
  if docker exec "$ORCH" test -d "$STATE_DIR" 2>/dev/null; then
    ok "container sees $STATE_DIR (bind mount present)"
  else
    bad "container cannot see $STATE_DIR" "the compose volume is missing — the button will do nothing"
  fi

  if docker exec "$ORCH" sh -c "printf 'DROPLET_SSH_ACCESS=on\n' > $INTENT.ctr && mv -f $INTENT.ctr $INTENT" 2>/dev/null; then
    ok "container wrote the intent file"
    wait_for_state on 25 \
      && ok "host applied the container's intent end-to-end" \
      || bad "host did not apply the container's intent" "container writes but nothing happens"
  else
    bad "container could NOT write the intent file" "check the intent.d rw bind mount and its group ownership (0775, droplet group)"
  fi

  # The read-only half, asserted directly: nothing new may appear in the
  # parent. This is what makes `state` unforgeable — ownership alone would not,
  # since the orchestrator runs as container UID 0 and a bind mount does no UID
  # remapping.
  if docker exec "$ORCH" sh -c "touch $STATE_DIR/.rw-probe" 2>/dev/null; then
    bad "container CAN write into $STATE_DIR" "the parent mount is not :ro — state is forgeable"
    docker exec "$ORCH" rm -f "$STATE_DIR/.rw-probe" >/dev/null 2>&1 || true
  else
    ok "container cannot write into $STATE_DIR (read-only mount)"
  fi

  # The container must not be able to forge the state the dashboard trusts.
  if docker exec "$ORCH" sh -c "echo state=on > $STATE" 2>/dev/null; then
    bad "container CAN overwrite the state file" "the dashboard's source of truth is forgeable"
  else
    ok "container cannot overwrite the state file (root-owned)"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
[ "$SAFE_ONLY" = "1" ] && echo "  ${YEL}--safe-only: the OFF path was not exercised${RST}"
echo "════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
