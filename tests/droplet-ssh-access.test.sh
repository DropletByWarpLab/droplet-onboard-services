#!/bin/bash
# WARP-1984 — droplet-ssh-access, exercised against a PATH-stubbed systemctl.
# No root, no systemd, no box: every case runs in a tmpdir.
#
# WHY THIS EXISTS ALONGSIDE THE VITEST GUARD. The orchestrator suite
# (ssh-access.host-script.guard.test.ts) reads this script as TEXT — it can
# prove `iptables` does not appear and that the on|off case arm is present, but
# it cannot prove the parser actually REFUSES `DROPLET_SSH_ACCESS=$(id)`. Only
# running it can. So: that file guards what must never appear, this one proves
# what actually happens.
#
# AND WHY IT RUNS UNDER dash. The appliance is Ubuntu, where /bin/sh is dash.
# Developer shells (Git Bash, macOS) provide bash-as-sh, which accepts
# constructs dash rejects outright — a script that only ever ran under bash can
# fail on the box at the first `local` or `[[`. Every invocation below is
# explicitly `/bin/sh`, and the syntax check is explicitly dash.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../scripts/host/usr-local-sbin/droplet-ssh-access"
PASS=0
FAIL=0

setup() {
  WORK="$(mktemp -d)"
  export DROPLET_SSH_ACCESS_DIR="$WORK/state"
  mkdir -p "$DROPLET_SSH_ACCESS_DIR" "$WORK/bin"
  # Pretend `ssh.service` exists; record every invocation.
  cat >"$WORK/bin/systemctl" <<'STUB'
#!/bin/sh
echo "$@" >>"$SYSTEMCTL_LOG"
case "$1" in
  list-unit-files) case "$2" in ssh.service) exit 0 ;; *) exit 1 ;; esac ;;
  cat)             case "$2" in ssh.service) exit 0 ;; *) exit 1 ;; esac ;;
esac
exit 0
STUB
  chmod +x "$WORK/bin/systemctl"
  # Stub `logger` so we test the real path, not its absent-logger fallback.
  printf '#!/bin/sh\nexit 0\n' >"$WORK/bin/logger"
  chmod +x "$WORK/bin/logger"
  export SYSTEMCTL_LOG="$WORK/systemctl.log"
  : >"$SYSTEMCTL_LOG"
  export PATH="$WORK/bin:$PATH"
}

teardown() { rm -rf "$WORK"; }

check() { # check <label> <rc> [detail]
  if [ "$2" = "0" ]; then
    PASS=$((PASS + 1))
    echo "  PASS  $1"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL  $1 -- ${3:-}"
  fi
}

run_case() { # run_case <intent-file-contents>
  setup
  printf '%s' "$1" >"$DROPLET_SSH_ACCESS_DIR/intent"
  /bin/sh "$SCRIPT" >/dev/null 2>&1
  RC=$?
  LOG="$(cat "$SYSTEMCTL_LOG" 2>/dev/null)"
  STATE="$(cat "$DROPLET_SSH_ACCESS_DIR/state" 2>/dev/null || echo '<none>')"
}

echo "== droplet-ssh-access (/bin/sh -> $(readlink -f /bin/sh 2>/dev/null || echo sh)) =="

# --- 1. It must parse under dash, not merely under bash ---------------------
if command -v dash >/dev/null 2>&1; then
  dash -n "$SCRIPT" 2>/tmp/ssh-access-dash-err
  check "parses under dash" $? "$(cat /tmp/ssh-access-dash-err 2>/dev/null)"
else
  sh -n "$SCRIPT" 2>/tmp/ssh-access-dash-err
  check "parses under sh (dash unavailable)" $? "$(cat /tmp/ssh-access-dash-err 2>/dev/null)"
fi

# --- 2. The two values that mean something ----------------------------------
run_case 'DROPLET_SSH_ACCESS=on
'
echo "$LOG" | grep -q '^start ssh.service$'
check "on: starts ssh.service" $? "log=[$LOG]"
echo "$STATE" | grep -q '^state=on$'
check "on: records state=on" $? "state=[$STATE]"
teardown

run_case 'DROPLET_SSH_ACCESS=off
'
echo "$LOG" | grep -q '^stop ssh.service$'
check "off: stops ssh.service" $? "log=[$LOG]"
# A stopped service with a live socket still accepts the next connection —
# the toggle would read "off" over an open port.
echo "$LOG" | grep -q '^stop ssh.socket$'
check "off: also stops ssh.socket" $? "log=[$LOG]"
echo "$STATE" | grep -q '^state=off$'
check "off: records state=off" $? "state=[$STATE]"
teardown

# --- 3. Hostile input -------------------------------------------------------
# The intent file is droplet-writable and this script runs as root. These are
# the payloads that matter: none may reach systemctl, none may write state,
# and none may execute. `$(touch /tmp/...)` is checked directly afterwards.
PWNED="/tmp/droplet-ssh-access-pwned-$$"
for bad in \
  "DROPLET_SSH_ACCESS=on; rm -rf /
" \
  "DROPLET_SSH_ACCESS=\$(touch $PWNED)
" \
  "DROPLET_SSH_ACCESS=\`touch $PWNED\`
" \
  "DROPLET_SSH_ACCESS=on extra
" \
  "DROPLET_SSH_ACCESS=yes
" \
  "DROPLET_SSH_ACCESS=ON
" \
  "SOMETHING_ELSE=on
" \
  ""; do
  run_case "$bad"
  label="$(printf '%s' "$bad" | head -c 32 | tr '\n' ' ')"
  if echo "$LOG" | grep -qE '^(start|stop) '; then
    check "refuses [$label]: issues no start/stop" 1 "log=[$LOG]"
  else
    check "refuses [$label]: issues no start/stop" 0
  fi
  [ "$STATE" = '<none>' ]
  check "refuses [$label]: records no state" $? "state=[$STATE]"
  teardown
done

[ ! -e "$PWNED" ]
check "no command substitution ever executed" $? "$PWNED was created"
rm -f "$PWNED"

# --- 4. Extra keys are inert (the EnvironmentFile failure mode, in file form) -
run_case 'EVIL=/root/.ssh/authorized_keys
DROPLET_SSH_ACCESS=on
ALSO_EVIL=yes
'
echo "$LOG" | grep -q '^start ssh.service$'
check "extra keys: the one real key is still read" $? "log=[$LOG]"
if echo "$LOG" | grep -qi 'evil'; then
  check "extra keys: they are never acted on" 1 "log=[$LOG]"
else
  check "extra keys: they are never acted on" 0
fi
teardown

# --- 5. Absent intent file --------------------------------------------------
setup
/bin/sh "$SCRIPT" >/dev/null 2>&1
RC=$?
LOG="$(cat "$SYSTEMCTL_LOG")"
[ "$RC" = "0" ] && [ -z "$LOG" ]
check "absent intent file: exits 0 and does nothing" $? "rc=$RC log=[$LOG]"
teardown

# --- 6. No ssh unit on this host --------------------------------------------
# Must not write state: the dashboard's honest "unknown" depends on it.
setup
printf 'DROPLET_SSH_ACCESS=on\n' >"$DROPLET_SSH_ACCESS_DIR/intent"
cat >"$WORK/bin/systemctl" <<'STUB'
#!/bin/sh
exit 1
STUB
chmod +x "$WORK/bin/systemctl"
/bin/sh "$SCRIPT" >/dev/null 2>&1
[ ! -f "$DROPLET_SSH_ACCESS_DIR/state" ]
check "no ssh unit: writes no state, so the UI stays 'unknown'" $? "state file written anyway"
teardown

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
