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
  # intent.d/ is the container-writable half; the parent holds root-owned
  # `state` and is bind-mounted read-only into the orchestrator.
  mkdir -p "$DROPLET_SSH_ACCESS_DIR/intent.d" "$WORK/bin"
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
  printf '%s' "$1" >"$DROPLET_SSH_ACCESS_DIR/intent.d/intent"
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
printf 'DROPLET_SSH_ACCESS=on\n' >"$DROPLET_SSH_ACCESS_DIR/intent.d/intent"
cat >"$WORK/bin/systemctl" <<'STUB'
#!/bin/sh
exit 1
STUB
chmod +x "$WORK/bin/systemctl"
/bin/sh "$SCRIPT" >/dev/null 2>&1
[ ! -f "$DROPLET_SSH_ACCESS_DIR/state" ]
check "no ssh unit: writes no state, so the UI stays 'unknown'" $? "state file written anyway"
teardown

# --- 7. The parser stops READING at the first match --------------------------
# The intent file is container-writable input to a ROOT process, so the read
# itself must be bounded, not just the acting. The old `sed ... | head -n1`
# bounded the MATCHES only: head can SIGPIPE sed solely after a printed line
# arrives, so sed kept reading an arbitrarily large file long after it had
# the one value it needed. The `{s//\1/p;q}` form quits the moment the key
# line matches — proved here by feeding the intent as a fifo that never
# reaches EOF. The old pipeline blocks on it forever (timeout ⇒ FAIL); the
# fixed parser exits as soon as it has its value.
setup
FIFO="$DROPLET_SSH_ACCESS_DIR/intent.d/intent"
mkfifo "$FIFO"
# Open read-write so neither end blocks, then feed exactly one valid line.
# The fd stays open, so a reader that insists on EOF never gets one.
exec 3<>"$FIFO"
printf 'DROPLET_SSH_ACCESS=on\n' >&3
timeout 10 /bin/sh "$SCRIPT" >/dev/null 2>&1
RC=$?
exec 3>&-
LOG="$(cat "$SYSTEMCTL_LOG" 2>/dev/null)"
[ "$RC" != "124" ] && [ "$RC" != "137" ]
check "first match: parser exits without waiting for EOF" $? "rc=$RC (timed out reading past the match)"
echo "$LOG" | grep -q '^start ssh.service$'
check "first match: the value read this way still applies" $? "log=[$LOG]"
teardown

# --- 8. The boot reset (droplet-ssh-access-boot-reset) -----------------------
# The applier `start`s sshd without enabling it, so sshd is down after every
# reboot — deliberate. But PathModified= does NOT fire when the path unit
# starts against a pre-existing unchanged file, so without a reset nothing
# re-ran the applier at boot: `state` kept saying on from before the reboot —
# a green toggle over a box nobody can reach. At boot this script rewrites
# the INTENT to off; the already-watching path unit sees a real modification
# and the applier records the truth. It must never re-apply the stored intent
# (a standing open door across reboots) and never drive systemd itself.
RESET="$HERE/../scripts/host/usr-local-sbin/droplet-ssh-access-boot-reset"

if command -v dash >/dev/null 2>&1; then
  dash -n "$RESET" 2>/tmp/ssh-access-reset-dash-err
  check "boot reset: parses under dash" $? "$(cat /tmp/ssh-access-reset-dash-err 2>/dev/null)"
else
  sh -n "$RESET" 2>/tmp/ssh-access-reset-dash-err
  check "boot reset: parses under sh (dash unavailable)" $? "$(cat /tmp/ssh-access-reset-dash-err 2>/dev/null)"
fi

# The owner had SSH on before the reboot. The reset must flip the intent to
# off — the literal, not the stored value — without touching systemd.
setup
printf 'DROPLET_SSH_ACCESS=on\n' >"$DROPLET_SSH_ACCESS_DIR/intent.d/intent"
/bin/sh "$RESET" >/dev/null 2>&1
RC=$?
[ "$RC" = "0" ]
check "boot reset: exits 0" $? "rc=$RC"
grep -q '^DROPLET_SSH_ACCESS=off$' "$DROPLET_SSH_ACCESS_DIR/intent.d/intent"
check "boot reset: rewrites the intent to off" $? \
  "intent=[$(cat "$DROPLET_SSH_ACCESS_DIR/intent.d/intent" 2>/dev/null)]"
[ -z "$(cat "$SYSTEMCTL_LOG" 2>/dev/null)" ]
check "boot reset: never calls systemctl itself" $? "log=[$(cat "$SYSTEMCTL_LOG" 2>/dev/null)]"
leftover="$(ls "$DROPLET_SSH_ACCESS_DIR/intent.d" | grep -v '^intent$' || true)"
[ -z "$leftover" ]
check "boot reset: leaves no temp litter next to the watched path" $? "leftover=[$leftover]"

# ...and the applier, run on that modification as the path unit would run it,
# ends the reboot sequence with sshd stopped and an honest state=off.
/bin/sh "$SCRIPT" >/dev/null 2>&1
LOG="$(cat "$SYSTEMCTL_LOG" 2>/dev/null)"
STATE="$(cat "$DROPLET_SSH_ACCESS_DIR/state" 2>/dev/null || echo '<none>')"
echo "$LOG" | grep -q '^stop ssh.service$'
check "reboot sequence: the applier stops sshd" $? "log=[$LOG]"
echo "$STATE" | grep -q '^state=off$'
check "reboot sequence: state reads off — readback and reality agree" $? "state=[$STATE]"
teardown

# A wiped intent.d must not defeat the reset: recreate and write.
setup
rm -rf "$DROPLET_SSH_ACCESS_DIR/intent.d"
/bin/sh "$RESET" >/dev/null 2>&1
grep -q '^DROPLET_SSH_ACCESS=off$' "$DROPLET_SSH_ACCESS_DIR/intent.d/intent" 2>/dev/null
check "boot reset: recreates a missing intent.d and still lands" $? \
  "intent=[$(cat "$DROPLET_SSH_ACCESS_DIR/intent.d/intent" 2>/dev/null || echo '<none>')]"
teardown

# --- 9. Install mode (WARP-2142) ---------------------------------------------
# The autoinstall seed plants an epoch-stamped marker at
# $STATE_DIR/install-mode — the ROOT-owned half of the state dir, never the
# container-writable intent.d/, so nothing in a container can mint or extend
# an install window. While the marker is FRESH (<48h) the boot reset stamps
# the intent ON instead of off: the path unit fires, the applier starts sshd,
# and a box that is still being commissioned comes back reachable after every
# reboot (last night's dead-ends — WARP-2100/2122/2133 — all reduced to "the
# box hung and nobody could get in"). The moment the marker is absent,
# malformed, or expired, the reset stamps off and DELETES it: fail-open for
# commissioning, fail-closed for everything else.

# Fresh marker → intent ON; the marker survives (the window spans reboots
# until setup.sh completes or the 48h backstop expires it).
setup
date +%s >"$DROPLET_SSH_ACCESS_DIR/install-mode"
printf 'DROPLET_SSH_ACCESS=off\n' >"$DROPLET_SSH_ACCESS_DIR/intent.d/intent"
/bin/sh "$RESET" >/dev/null 2>&1
RC=$?
[ "$RC" = "0" ]
check "install mode: exits 0 with a fresh marker" $? "rc=$RC"
grep -q '^DROPLET_SSH_ACCESS=on$' "$DROPLET_SSH_ACCESS_DIR/intent.d/intent"
check "install mode: a fresh marker stamps the intent ON" $? \
  "intent=[$(cat "$DROPLET_SSH_ACCESS_DIR/intent.d/intent" 2>/dev/null)]"
[ -f "$DROPLET_SSH_ACCESS_DIR/install-mode" ]
check "install mode: a fresh marker survives the boot (window spans reboots)" $?
[ -z "$(cat "$SYSTEMCTL_LOG" 2>/dev/null)" ]
check "install mode: the boot reset still never calls systemctl itself" $? \
  "log=[$(cat "$SYSTEMCTL_LOG" 2>/dev/null)]"
# ...and the applier, run on that modification as the path unit would run it,
# STARTS sshd — the outcome the ticket demands: sshd running after every boot
# while install mode lasts.
/bin/sh "$SCRIPT" >/dev/null 2>&1
LOG="$(cat "$SYSTEMCTL_LOG" 2>/dev/null)"
STATE="$(cat "$DROPLET_SSH_ACCESS_DIR/state" 2>/dev/null || echo '<none>')"
echo "$LOG" | grep -q '^start ssh.service$'
check "install mode: the applier starts sshd from the stamped intent" $? "log=[$LOG]"
echo "$STATE" | grep -q '^state=on$'
check "install mode: state reads on — the readback stays honest" $? "state=[$STATE]"
teardown

# A marker whose write lost its trailing newline still counts (read hits EOF
# with the value already assigned).
setup
printf '%s' "$(date +%s)" >"$DROPLET_SSH_ACCESS_DIR/install-mode"
/bin/sh "$RESET" >/dev/null 2>&1
grep -q '^DROPLET_SSH_ACCESS=on$' "$DROPLET_SSH_ACCESS_DIR/intent.d/intent"
check "install mode: a marker without a trailing newline still reads" $? \
  "intent=[$(cat "$DROPLET_SSH_ACCESS_DIR/intent.d/intent" 2>/dev/null)]"
teardown

# A FUTURE timestamp (installer clock ahead of the first-boot clock — a box
# with no RTC sync yet) is treated as fresh: fail OPEN for commissioning. The
# backstop still bounds the window once the clock passes stamp+48h.
setup
echo "$(( $(date +%s) + 3600 ))" >"$DROPLET_SSH_ACCESS_DIR/install-mode"
/bin/sh "$RESET" >/dev/null 2>&1
grep -q '^DROPLET_SSH_ACCESS=on$' "$DROPLET_SSH_ACCESS_DIR/intent.d/intent"
check "install mode: clock skew (future stamp) fails open, not closed" $? \
  "intent=[$(cat "$DROPLET_SSH_ACCESS_DIR/intent.d/intent" 2>/dev/null)]"
teardown

# An EXPIRED marker (>48h) → off, and the marker is DELETED so an abandoned
# box closes its window for good on the first boot after expiry.
setup
echo "$(( $(date +%s) - 172801 ))" >"$DROPLET_SSH_ACCESS_DIR/install-mode"
/bin/sh "$RESET" >/dev/null 2>&1
grep -q '^DROPLET_SSH_ACCESS=off$' "$DROPLET_SSH_ACCESS_DIR/intent.d/intent"
check "install mode: an expired marker stamps off (48h backstop)" $? \
  "intent=[$(cat "$DROPLET_SSH_ACCESS_DIR/intent.d/intent" 2>/dev/null)]"
[ ! -f "$DROPLET_SSH_ACCESS_DIR/install-mode" ]
check "install mode: an expired marker is deleted — the window cannot reopen" $?
teardown

# Malformed markers → off, deleted, and NOTHING ever executes. The marker is
# root-owned, but this script must stay paranoid anyway: the same strict-parse
# posture as the applier, with no code path from file contents to a command.
PWNED2="/tmp/droplet-ssh-access-marker-pwned-$$"
for badmark in \
  "not-a-number" \
  "1234abc" \
  "\$(touch $PWNED2)" \
  "\`touch $PWNED2\`" \
  "" \
  "12345678901234567890123"; do
  setup
  printf '%s\n' "$badmark" >"$DROPLET_SSH_ACCESS_DIR/install-mode"
  /bin/sh "$RESET" >/dev/null 2>&1
  RC=$?
  label="$(printf '%s' "$badmark" | head -c 24)"
  [ "$RC" = "0" ]
  check "install mode: refuses [$label] without failing the boot" $? "rc=$RC"
  grep -q '^DROPLET_SSH_ACCESS=off$' "$DROPLET_SSH_ACCESS_DIR/intent.d/intent"
  check "install mode: refuses [$label]: stamps off" $? \
    "intent=[$(cat "$DROPLET_SSH_ACCESS_DIR/intent.d/intent" 2>/dev/null)]"
  [ ! -f "$DROPLET_SSH_ACCESS_DIR/install-mode" ]
  check "install mode: refuses [$label]: deletes the bad marker" $?
  teardown
done
[ ! -e "$PWNED2" ]
check "install mode: no marker content was ever executed" $? "$PWNED2 was created"
rm -f "$PWNED2"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
