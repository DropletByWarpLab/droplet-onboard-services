#!/usr/bin/env bash
# =============================================================================
# WARP-2574 — host artefact reconciliation
#
# WARP-1829 shipped `droplet-host-units check`, which finds host units running
# STALE code. It enumerates units FROM SYSTEMD, so it can only report on
# artefacts that exist. An artefact that was NEVER INSTALLED has no unit to
# enumerate and no process to compare — invisible to it, to `systemctl status`
# and to /api/health alike.
#
# Measured 2026-08-31 on the bench box: WARP-2190 (droplet-power-restore) and
# WARP-2192 (the hardware watchdog) merged 2026-08-26, the box's checkout
# contained both, and NEITHER was installed. Both units read `not-found`,
# /dev/watchdog0 did not exist, the AC-loss policy was still `always-off` — the
# box would have stayed dark after a power cut, five days after the fix shipped.
# `check` reported everything current the whole time, correctly and uselessly.
#
# Two halves are tested here, and the second is the one that matters longest:
#
#   1. `droplet-host-units audit` — reconciles scripts/host/MANIFEST against a
#      fixture filesystem. Phase 2 replays the exact box state above.
#
#   2. THE MANIFEST GUARD — reconciles the manifest against
#      install_single_box_host_integration in BOTH directions. A hand-kept table
#      that drifts from the installer would be worse than no table: it would
#      report green for artefacts nobody installs. This is what makes the blind
#      spot unable to silently re-open, so Phase 4 mutation-tests it — every
#      assertion is shown to FAIL when the thing it guards is broken.
#
# No root, no systemd, no box: a PATH-stubbed systemctl and tmpdir filesystems.
#
# Runtime: a few seconds on Linux. The suite is fork-bound, not compute-bound —
# on a slow-fork host like Windows Git Bash the same run is ~10 minutes, nearly
# all of it in sys. If you are adding cases, keep them off the per-row path.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_UNITS="$REPO_ROOT_REAL/scripts/host/droplet-host-units.sh"
MANIFEST="$REPO_ROOT_REAL/scripts/host/MANIFEST"
SINGLE_BOX="$REPO_ROOT_REAL/scripts/lib/single-box.sh"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

PYBIN="$(command -v python3 || command -v python)"

echo ""
echo "  ================================================"
echo "  WARP-2574 — host artefact reconciliation"
echo "  ================================================"
echo ""

for f in "$HOST_UNITS" "$MANIFEST" "$SINGLE_BOX"; do
  if [ ! -f "$f" ]; then
    fail "missing: ${f#"$REPO_ROOT_REAL"/}"
    echo ""
    echo "  1 of 1 tests FAILED"
    exit 1
  fi
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# =============================================================================
# The installer parser — shared by the guard and its mutation tests
# =============================================================================
# Everything below reads ONE function, install_single_box_host_integration, and
# only that function: `close_install_mode_ssh_window` in the same file enables
# ssh.service, which is not a manifest artefact and must never be picked up.

installer_body() { # <single-box.sh path>
  awk '
    /^install_single_box_host_integration\(\) \{/ { inf = 1 }
    inf { print }
    inf && /^\}$/ { exit }
  ' "$1"
}

# Comments stripped, line continuations joined, whitespace squeezed — so a
# two-line `install -m 0644 "$host_src/x" \` + `  /etc/x` reads as one record.
installer_normalized() { # <single-box.sh path>
  installer_body "$1" \
    | sed -e 's/[[:space:]]*#.*$//' \
    | awk '{ if (sub(/\\$/, "")) { printf "%s ", $0 } else { print } }' \
    | sed -e 's/[[:space:]]\+/ /g'
}

# "<repo-relative source> <destination> <mode>" for every file the installer
# copies OUT OF scripts/host/.
installer_host_src_installs() { # <single-box.sh path>
  installer_normalized "$1" \
    | grep -oE 'install -m [0-7]{3,4} "\$host_src/[^"]+" /[^ ]+' \
    | awk '{
        src = $4; dst = $5; mode = $3
        sub(/^"\$host_src\//, "scripts/host/", src)
        sub(/"$/, "", src)
        print src, dst, mode
      }' \
    | sort -u
}

# Destinations of `install -m` lines whose source is NOT under scripts/host/
# (the arch-gated xvf payload, the egress-audit *.py glob). Each must be
# accounted for by a `skip` row — never simply unmentioned.
installer_foreign_installs() { # <single-box.sh path>
  installer_normalized "$1" \
    | grep -E 'install -m [0-7]{3,4} ' \
    | grep -v '"\$host_src/' \
    | awk '{ print $NF }' \
    | sort -u
}

installer_dirs() { # <single-box.sh path>
  installer_normalized "$1" \
    | grep -oE 'install -d [^;]*' \
    | awk '{ print $NF }' \
    | grep -E '^/' \
    | sort -u
}

# `systemctl enable [--now] <unit>`. Deliberately anchored on `enable` so the
# WARP-869 migration's `systemctl disable --now droplet-wifi-watchdog.timer`
# never lands in the expectation set.
installer_enables() { # <single-box.sh path>
  installer_normalized "$1" \
    | grep -oE 'systemctl enable (--now )?[A-Za-z0-9@._-]+' \
    | awk '{ print $NF }' \
    | sort -u
}

# --- manifest readers --------------------------------------------------------
manifest_rows() { # <manifest> <kind>
  awk -v want="$2" '
    /^[[:space:]]*#/ { next }
    NF == 0 { next }
    $1 == want { print }
  ' "$1"
}

manifest_files() { # <manifest>  -> "<src> <dst> <mode>"
  manifest_rows "$1" file | awk '{ print $2, $3, $4 }' | sort -u
}
manifest_dirs() { manifest_rows "$1" dir | awk '{ print $3 }' | sort -u; }
manifest_units() { manifest_rows "$1" unit | awk '{ print $3 }' | sort -u; }
manifest_skips() { manifest_rows "$1" skip | awk '{ print $3 }' | sort -u; }

# =============================================================================
# THE GUARD — manifest vs installer, both directions.
# Prints one `FAIL: <reason>` line per problem and returns 1 if there were any.
# A function so Phase 4 can run it against deliberately-broken copies and prove
# each assertion actually fires.
# =============================================================================
reconcile() { # <manifest> <single-box.sh> <repo root>
  local man="$1" sb="$2" root="$3" problems=0 line

  # A parser that silently matches nothing would pass every assertion below and
  # guard exactly nothing. Fail closed on an empty parse FIRST — that is the
  # failure mode a renamed function or a reformatted installer produces.
  if [ -z "$(installer_body "$sb")" ]; then
    echo "FAIL: install_single_box_host_integration not found in $sb — this guard is not reading anything"
    return 1
  fi

  # Each set is computed ONCE. Re-deriving them inside the loops below turned a
  # sub-second guard into a multi-minute one on a slow-fork host, and a check
  # too slow to run is a check that gets skipped.
  local inst_files inst_dirs inst_units inst_foreign
  local man_files man_dirs man_units man_skips man_sources
  inst_files="$(installer_host_src_installs "$sb")"
  inst_dirs="$(installer_dirs "$sb")"
  inst_units="$(installer_enables "$sb")"
  inst_foreign="$(installer_foreign_installs "$sb")"
  man_files="$(manifest_files "$man")"
  man_dirs="$(manifest_dirs "$man")"
  man_units="$(manifest_units "$man")"
  man_skips="$(manifest_skips "$man")"
  man_sources="$(manifest_rows "$man" file | awk '{ print $2 }' | sort -u)"

  if [ "$(printf '%s\n' "$inst_files" | grep -c .)" -lt 20 ]; then
    echo "FAIL: parsed fewer than 20 scripts/host installs from $sb — the installer's shape changed and this guard has gone blind"
    problems=1
  fi

  # `grep -qxF <needle> <<< <haystack>`, wrapped so the direction never gets
  # accidentally inverted in one of the eight call sites below.
  _has() { printf '%s\n' "$2" | grep -qxF "$1"; }

  # 1. installer → manifest. THE load-bearing direction: a host artefact added
  #    to the installer without a manifest row is exactly WARP-2574 re-opening.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _has "$line" "$man_files" || {
      echo "FAIL: installer places '$line' but scripts/host/MANIFEST has no matching file row (src dst mode must all agree — a mode mismatch would make the audit report permanent false drift)"
      problems=1
    }
  done <<< "$inst_files"

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _has "$line" "$man_dirs" || {
      echo "FAIL: installer creates directory '$line' with no dir row in scripts/host/MANIFEST"
      problems=1
    }
  done <<< "$inst_dirs"

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _has "$line" "$man_units" || {
      echo "FAIL: installer enables '$line' with no unit row in scripts/host/MANIFEST"
      problems=1
    }
  done <<< "$inst_units"

  # Installs from outside scripts/host/ cannot be content-compared, but they
  # must still be NAMED — an unmentioned artefact is an unchecked artefact.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _has "$line" "$man_skips" || {
      echo "FAIL: installer places '$line' from outside scripts/host/ and no skip row in scripts/host/MANIFEST accounts for it"
      problems=1
    }
  done <<< "$inst_foreign"

  # 2. manifest → installer. Catches a row left behind by a retired artefact,
  #    which would report `missing` forever on every healthy box and train
  #    people to ignore the check.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _has "$line" "$inst_files" || {
      echo "FAIL: scripts/host/MANIFEST declares file row '$line' that install_single_box_host_integration does not install"
      problems=1
    }
  done <<< "$man_files"

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _has "$line" "$inst_dirs" || {
      echo "FAIL: scripts/host/MANIFEST declares dir '$line' that the installer does not create"
      problems=1
    }
  done <<< "$man_dirs"

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _has "$line" "$inst_units" || {
      echo "FAIL: scripts/host/MANIFEST declares unit '$line' that the installer does not enable"
      problems=1
    }
  done <<< "$man_units"

  # 3. every declared source must actually be in the repo.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [ ! -f "$root/$line" ]; then
      echo "FAIL: scripts/host/MANIFEST names source '$line' which does not exist in the repo"
      problems=1
    fi
  done <<< "$man_sources"

  # 4. you may not opt out of content checking without writing down why.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "FAIL: scripts/host/MANIFEST row has policy=presence or kind=skip with no note explaining why: $line"
    problems=1
  done < <(awk '
    /^[[:space:]]*#/ { next }
    NF == 0 { next }
    ($1 == "file" && $5 == "presence" && NF < 7) { print; next }
    ($1 == "skip" && NF < 7) { print }
  ' "$man")

  # 5. kinds and policies must be spelled the way the auditor reads them.
  #    audit_row_file treats anything that is not exactly `presence` as `track`,
  #    so `presense` would silently turn on content checking for a file whose
  #    author meant to turn it OFF — a permanent red nobody can explain.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "FAIL: scripts/host/MANIFEST row has an unknown kind or policy (the auditor would silently mis-handle it): $line"
    problems=1
  done < <(awk '
    /^[[:space:]]*#/ { next }
    NF == 0 { next }
    $1 == "file" && $5 != "track" && $5 != "presence" { print; next }
    $1 == "dir"  && $5 != "present"                   { print; next }
    $1 == "unit" && $5 != "enabled"                   { print; next }
    $1 != "file" && $1 != "dir" && $1 != "unit" && $1 != "skip" { print }
  ' "$man")

  unset -f _has
  [ "$problems" -eq 0 ]
}

# =============================================================================
# Fixture builders
# =============================================================================

# systemctl stub. `is-enabled` reads $WORK/enabled/<unit>; `list-units`/`show`
# serve the repo-root-discovery case in Phase 3.
mk_systemctl_stub() {
  mkdir -p "$WORK/bin" "$WORK/enabled" "$WORK/enabled.pristine" "$WORK/show"
  : > "$WORK/units"
  cat > "$WORK/bin/systemctl" <<EOF
#!/usr/bin/env bash
enabled="$WORK/enabled"
showdir="$WORK/show"
units="$WORK/units"
verb=""
for a in "\$@"; do
  case "\$a" in -*) ;; *) [ -z "\$verb" ] && verb="\$a" ;; esac
done
target=""
for a in "\$@"; do target="\$a"; done
case "\$target" in -*) target="" ;; esac
[ "\$target" = "\$verb" ] && target=""

case "\$verb" in
  is-enabled)
    if [ -f "\$enabled/\$target" ]; then
      state="\$(cat "\$enabled/\$target")"
      printf '%s\n' "\$state"
      case "\$state" in enabled|enabled-runtime|static) exit 0 ;; *) exit 1 ;; esac
    fi
    # Real systemctl writes the not-found diagnostic to stderr and prints
    # NOTHING on stdout — the caller must derive "not-found" itself.
    echo "Failed to get unit file state for \$target: No such file or directory" >&2
    exit 1 ;;
  list-units)
    while IFS= read -r u; do
      [ -n "\$u" ] || continue
      printf '%s loaded active running fixture unit\n' "\$u"
    done < "\$units"
    exit 0 ;;
  show)
    [ -f "\$showdir/\$target" ] || exit 0
    cat "\$showdir/\$target"
    exit 0 ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$WORK/bin/systemctl"
}

# Materialize the manifest onto a fixture filesystem root, exactly as a
# successful install_single_box_host_integration run would leave it.
#
# Built ONCE into a pristine tree; every later fixture is a `cp -a` of it.
# Re-installing ~40 files per case turned this suite into a multi-minute run on
# a slow-fork host, and a suite too slow to run locally is a suite that only
# ever runs in CI — which is not where you want to first see it fail.
PRISTINE="$WORK/root.pristine"

build_pristine_root() {
  local kind src dst mode policy note
  # policy/note are read only to consume their columns — a 4-field read would
  # fold the whole remainder of the line into `mode`.
  # shellcheck disable=SC2034
  while read -r kind src dst mode policy note; do
    case "$kind" in '' | \#*) continue ;; esac
    case "$kind" in
      file)
        mkdir -p "$PRISTINE$(dirname "$dst")"
        install -m "$mode" "$REPO_ROOT_REAL/$src" "$PRISTINE$dst" 2>/dev/null \
          || { cp "$REPO_ROOT_REAL/$src" "$PRISTINE$dst"; chmod "$mode" "$PRISTINE$dst"; }
        ;;
      dir) mkdir -p "$PRISTINE$dst" ;;
      unit) printf 'enabled' > "$WORK/enabled.pristine/$dst" ;;
    esac
  done < "$MANIFEST"
}

# A box with the whole host integration installed and every unit enabled.
reset_installed_box() {
  rm -rf "$ROOT" "$WORK/enabled"
  cp -a "$PRISTINE" "$ROOT"
  cp -a "$WORK/enabled.pristine" "$WORK/enabled"
}

run_audit() { # <extra VAR=val ...> -- <args>
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  env PATH="$WORK/bin:$PATH" \
      DROPLET_HOST_UNITS_REPO_ROOT="$REPO_ROOT_REAL" \
      ${envs[@]+"${envs[@]}"} \
      bash "$HOST_UNITS" "$@" 2>&1
}

# =============================================================================
# Phase 0: static
# =============================================================================
echo "--- Phase 0: static checks ---"

if bash -n "$HOST_UNITS" 2>/dev/null; then
  pass "droplet-host-units.sh passes bash -n"
else
  fail "droplet-host-units.sh fails bash -n"
  exit 1
fi

if grep -qE 'while[[:space:]]+true|while[[:space:]]*:' "$HOST_UNITS"; then
  fail "droplet-host-units.sh contains a while-true loop (architecture-guard rule 9)"
else
  pass "no while-true scheduler (architecture-guard rule 9)"
fi

# The manifest must be read from the CHECKOUT, never from an installed copy —
# an installed copy is stale in exactly the case the audit exists to catch.
if grep -qE 'install .*scripts/host/MANIFEST|MANIFEST.*(/usr/local|/etc/)' "$SINGLE_BOX"; then
  fail "single-box.sh installs MANIFEST to the box — the audit must read the CHECKOUT's copy, or a pulled-but-uninstalled artefact reads as fine"
else
  pass "MANIFEST is never installed to the box (the audit reads the checkout)"
fi

# Standing detection rides the existing timer (rule 9: one scheduler, not two).
if grep -q 'host_artefacts' "$REPO_ROOT_REAL/scripts/host/droplet-watchdog.sh"; then
  pass "droplet-watchdog.sh carries the host_artefacts check"
else
  fail "droplet-watchdog.sh has no host_artefacts check — nothing surfaces the audit on a box"
fi
if grep -q 'host_artefacts' "$REPO_ROOT_REAL/scripts/host/etc-systemd-system/droplet-watchdog.timer" 2>/dev/null; then
  fail "host_artefacts must NOT have its own timer — it rides droplet-watchdog.timer"
else
  pass "host_artefacts has no scheduler of its own"
fi

# The provision must verify its own work — the bench box's installer never
# re-ran, and nothing ever asked whether the last run had actually landed.
if grep -q 'droplet-host-units audit' "$REPO_ROOT_REAL/scripts/setup.sh"; then
  pass "setup.sh audits the host integration it just installed"
else
  fail "setup.sh never runs 'droplet-host-units audit' — a provision does not verify its own install"
fi

# =============================================================================
# Phase 1: the manifest guard against the real repo
# =============================================================================
echo "--- Phase 1: manifest vs install_single_box_host_integration ---"

if out="$(reconcile "$MANIFEST" "$SINGLE_BOX" "$REPO_ROOT_REAL")"; then
  pass "scripts/host/MANIFEST and install_single_box_host_integration agree, both directions"
else
  fail "manifest/installer reconciliation found problems:"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

n_files="$(manifest_files "$MANIFEST" | wc -l | tr -d ' ')"
if [ "$n_files" -ge 20 ]; then
  pass "manifest declares $n_files files (a manifest that shrank to nothing would pass every other assertion)"
else
  fail "manifest declares only $n_files files — expected the full host integration"
fi

# The two artefacts that were live-broken on the bench box must be covered, by
# name. This is the regression pin for the incident itself.
for artefact in \
  /usr/local/sbin/droplet-power-restore \
  /etc/systemd/system/droplet-power-restore.service \
  /etc/systemd/system/droplet-power-restore.timer \
  /etc/modules-load.d/droplet-watchdog-hw.conf \
  /etc/systemd/system.conf.d/droplet-watchdog.conf; do
  if manifest_files "$MANIFEST" | awk '{ print $2 }' | grep -qxF "$artefact"; then
    pass "manifest covers $artefact"
  else
    fail "manifest does not cover $artefact — the exact artefact missing on the bench box 2026-08-31"
  fi
done
for unit in droplet-power-restore.service droplet-power-restore.timer; do
  if manifest_units "$MANIFEST" | grep -qxF "$unit"; then
    pass "manifest expects $unit to be enabled"
  else
    fail "manifest does not expect $unit enabled — it read not-found on the bench box"
  fi
done

# =============================================================================
# Phase 2: the auditor against fixture filesystems
# =============================================================================
echo "--- Phase 2: audit behaviour ---"

mk_systemctl_stub
ROOT="$WORK/root"
build_pristine_root
reset_installed_box

out="$(run_audit DROPLET_HOST_UNITS_ROOT_PREFIX="$ROOT" -- audit)"; rc=$?
if [ "$rc" -eq 0 ]; then
  pass "a fully-installed box audits clean (exit 0)"
else
  fail "fully-installed box: expected exit 0, got $rc"
  printf '%s\n' "$out" | grep -vE '^  ok|^  skip' | sed 's/^/      /'
fi

# --- the 2026-08-31 bench box, replayed --------------------------------------
# Everything present EXCEPT what WARP-2190 and WARP-2192 shipped. That box's
# `droplet-host-units check` reported every unit current; this must not.
rm -f "$ROOT/usr/local/sbin/droplet-power-restore" \
      "$ROOT/etc/systemd/system/droplet-power-restore.service" \
      "$ROOT/etc/systemd/system/droplet-power-restore.timer" \
      "$ROOT/etc/default/droplet-power-restore" \
      "$ROOT/etc/modules-load.d/droplet-watchdog-hw.conf" \
      "$ROOT/etc/systemd/system.conf.d/droplet-watchdog.conf"
rm -f "$WORK/enabled/droplet-power-restore.service" \
      "$WORK/enabled/droplet-power-restore.timer"

out="$(run_audit DROPLET_HOST_UNITS_ROOT_PREFIX="$ROOT" -- audit)"; rc=$?
if [ "$rc" -eq 1 ]; then
  pass "the 2026-08-31 bench-box state fails the audit (exit 1)"
else
  fail "bench-box state: expected exit 1, got $rc"
fi
for expected in /usr/local/sbin/droplet-power-restore \
                /etc/modules-load.d/droplet-watchdog-hw.conf \
                /etc/systemd/system.conf.d/droplet-watchdog.conf; do
  if printf '%s\n' "$out" | grep -q "^  MISSING .*$expected"; then
    pass "audit names $expected as MISSING"
  else
    fail "audit did not report $expected as MISSING"
  fi
done
if printf '%s\n' "$out" | awk '$1 == "NOT-ENABLED" { print $2 }' | grep -qxF droplet-power-restore.timer; then
  pass "audit reports droplet-power-restore.timer as NOT-ENABLED (is-enabled=not-found)"
else
  fail "audit did not report droplet-power-restore.timer as not enabled"
fi
if printf '%s\n' "$out" | grep -q 'setup.sh'; then
  pass "audit output names the fix (sudo ./scripts/setup.sh)"
else
  fail "audit reports a problem without naming the fix"
fi

# --- the report's column contract (the watchdog awks this) -------------------
# The watchdog names the offending artefacts by awking column 2 of the audit's
# human report, keyed on the label in column 1. Two ways that silently breaks:
# the auditor renames a label (the watchdog then reports nothing while the box
# is broken), or a label gains a space (the watchdog then prints the wrong
# field). Pin BOTH sets and compare them.
# Scoped to report_audit_human: report_human (the `check` report) has labels of
# its own — STALE, FAILED — that this contract has nothing to do with.
audit_labels="$(awk '/^report_audit_human\(\)/, /^}/' "$HOST_UNITS" \
  | grep -oE "printf '  [A-Z][A-Z-]+ " \
  | sed -e "s/^printf '  //" -e 's/ *$//' | sort -u)"
watchdog_labels="$(awk '/wd_check_host_artefacts\(\)/, /^}/' \
  "$REPO_ROOT_REAL/scripts/host/droplet-watchdog.sh" \
  | grep -oE '\$1 == "[A-Z][A-Z-]*"' \
  | sed -e 's/.*"\(.*\)"/\1/' | sort -u)"
if [ -n "$audit_labels" ] && [ "$audit_labels" = "$watchdog_labels" ]; then
  pass "the audit's failure labels and the watchdog's awk keys are the same set ($(printf '%s' "$audit_labels" | tr '\n' ' '))"
else
  fail "audit labels and watchdog awk keys disagree — the watchdog would report nothing on a broken box"
  printf '    audit:    %s\n' "$(printf '%s' "$audit_labels" | tr '\n' ' ')"
  printf '    watchdog: %s\n' "$(printf '%s' "$watchdog_labels" | tr '\n' ' ')"
fi

# ...and each label really is one whitespace-free token followed by the
# destination, on live output.
for label in MISSING NOT-ENABLED; do
  if printf '%s\n' "$out" | awk -v l="$label" '$1 == l { print $2 }' | grep -q '^[/A-Za-z]'; then
    pass "$label rows put the destination in column 2"
  else
    fail "$label rows do not put the destination in column 2 — the watchdog's message would name the wrong thing"
  fi
done

# --- content drift ------------------------------------------------------------
reset_installed_box
printf '\n# stale build\n' >> "$ROOT/usr/local/sbin/droplet-watchdog"
out="$(run_audit DROPLET_HOST_UNITS_ROOT_PREFIX="$ROOT" -- audit)"; rc=$?
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | awk '$1 == "DRIFT" { print $2 }' | grep -qxF /usr/local/sbin/droplet-watchdog; then
  pass "an installed copy older than the repo source reports DRIFT (exit 1)"
else
  fail "content drift on /usr/local/sbin/droplet-watchdog was not reported (exit $rc)"
fi

# --- mode drift ---------------------------------------------------------------
# A 0644 /usr/local/sbin script is byte-identical to the repo and never runs.
reset_installed_box
chmod 0644 "$ROOT/usr/local/sbin/droplet-power-restore"
out="$(run_audit DROPLET_HOST_UNITS_ROOT_PREFIX="$ROOT" -- audit)"; rc=$?
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | awk '$1 == "DRIFT" { print $2 }' | grep -qxF /usr/local/sbin/droplet-power-restore; then
  pass "a byte-identical file installed 0644 instead of 0755 reports DRIFT"
else
  # chmod is a no-op on some filesystems (Windows/CIFS); don't fail the suite
  # on the host's inability to hold a mode, but never silently claim a pass.
  if [ "$(stat -c '%a' "$ROOT/usr/local/sbin/droplet-power-restore" 2>/dev/null)" = "644" ]; then
    fail "mode drift on /usr/local/sbin/droplet-power-restore was not reported (exit $rc)"
  else
    pass "mode drift check skipped — this filesystem does not preserve modes"
  fi
fi

# --- policy=presence: content is deliberately not compared --------------------
reset_installed_box
printf '\nDROPLET_WATCHDOG_CHECKS="wifi"\n' >> "$ROOT/etc/default/droplet-watchdog"
out="$(run_audit DROPLET_HOST_UNITS_ROOT_PREFIX="$ROOT" -- audit)"; rc=$?
if [ "$rc" -eq 0 ]; then
  pass "an operator-edited install-once file (policy=presence) does not report drift"
else
  fail "policy=presence file reported a problem after an operator edit (exit $rc)"
  printf '%s\n' "$out" | grep -vE '^  ok|^  skip' | sed 's/^/      /'
fi
# ...but it must still be reported when it is GONE.
rm -f "$ROOT/etc/default/droplet-watchdog"
out="$(run_audit DROPLET_HOST_UNITS_ROOT_PREFIX="$ROOT" -- audit)"; rc=$?
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | awk '$1 == "MISSING" { print $2 }' | grep -qxF /etc/default/droplet-watchdog; then
  pass "policy=presence still means PRESENCE — a deleted one reports MISSING"
else
  fail "a deleted policy=presence file was not reported missing (exit $rc)"
fi

# --- a unit that exists but is disabled --------------------------------------
reset_installed_box
printf 'disabled' > "$WORK/enabled/droplet-watchdog.timer"
out="$(run_audit DROPLET_HOST_UNITS_ROOT_PREFIX="$ROOT" -- audit)"; rc=$?
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'NOT-ENABLED.*droplet-watchdog.timer.*is-enabled=disabled'; then
  pass "an installed-but-disabled unit reports NOT-ENABLED with its real state"
else
  fail "a disabled droplet-watchdog.timer was not reported (exit $rc)"
fi
printf 'enabled' > "$WORK/enabled/droplet-watchdog.timer"

# --- a torn checkout is unverifiable, not fine -------------------------------
rm -rf "$WORK/tornrepo"; reset_installed_box
mkdir -p "$WORK/tornrepo"
cp -r "$REPO_ROOT_REAL/scripts" "$WORK/tornrepo/scripts"
rm -f "$WORK/tornrepo/scripts/host/usr-local-sbin/droplet-power-restore"
out="$(run_audit DROPLET_HOST_UNITS_REPO_ROOT="$WORK/tornrepo" \
                DROPLET_HOST_UNITS_ROOT_PREFIX="$ROOT" -- audit)"; rc=$?
if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | awk '$1 == "UNVERIFIABLE" { print $2 }' | grep -qxF /usr/local/sbin/droplet-power-restore; then
  pass "a repo source missing from the checkout reports UNVERIFIABLE, not ok"
else
  fail "a torn checkout was not reported as unverifiable (exit $rc)"
fi

# --- no manifest: exit 4, never 0 --------------------------------------------
# "I could not look" and "I looked and everything is fine" must never share an
# exit code — that silence is the whole bug.
out="$(run_audit DROPLET_HOST_UNITS_REPO_ROOT="$WORK/nope" \
                DROPLET_HOST_UNITS_MANIFEST="$WORK/nope/MANIFEST" -- audit)"; rc=$?
if [ "$rc" -eq 4 ]; then
  pass "an unlocatable manifest exits 4 (no verdict), never 0"
else
  fail "unlocatable manifest: expected exit 4, got $rc"
fi

# --- --json ------------------------------------------------------------------
reset_installed_box
rm -f "$ROOT/usr/local/sbin/droplet-power-restore"
run_audit DROPLET_HOST_UNITS_ROOT_PREFIX="$ROOT" -- audit --json > "$WORK/audit.json" 2>/dev/null
if "$PYBIN" -c 'import json,sys; json.load(open(sys.argv[1]))' "$WORK/audit.json" 2>/dev/null; then
  pass "audit --json emits parseable JSON"
  # The destination is embedded in the source, NOT passed as argv: MSYS rewrites
  # anything argv-shaped like an absolute POSIX path, so on a Windows dev box
  # "/usr/local/sbin/..." would arrive as "C:/Program Files/Git/usr/local/...",
  # match nothing, and report a phantom failure.
  got="$("$PYBIN" -c '
import json, sys
doc = json.load(open(sys.argv[1]))
want = "/usr/local/sbin/droplet-power-restore"
rows = [a for a in doc["artefacts"] if a["destination"] == want]
state = rows[0]["state"] if rows else "ABSENT"
print(str(doc["missing_count"]) + ":" + state)
' "$WORK/audit.json")"
  if [ "$got" = "1:missing" ]; then
    pass "audit --json reports missing_count and the artefact's state"
  else
    fail "audit --json: expected '1:missing', got '$got'"
  fi
else
  fail "audit --json did not emit parseable JSON"
  head -5 "$WORK/audit.json" | sed 's/^/      /'
fi

# =============================================================================
# Phase 3: finding the checkout with nothing installed
# =============================================================================
echo "--- Phase 3: checkout discovery ---"

# The box this exists for has NO manifest artefacts installed, so repo-root
# discovery cannot depend on any of them. droplet.service names the checkout in
# its own ExecStart, which is why that is where we look.
mkdir -p "$WORK/fakerepo/.git" "$WORK/fakerepo/scripts/host" "$WORK/fakerepo/docker"
printf 'x\n' > "$WORK/fakerepo/docker/docker-compose.yml"
cat > "$WORK/fakerepo/scripts/host/MANIFEST" <<'MANEOF'
dir  -  /etc/droplet  -  present  fixture
MANEOF
printf 'droplet.service\n' > "$WORK/units"
cat > "$WORK/show/droplet.service" <<EOF
Id=droplet.service
Type=oneshot
RemainAfterExit=yes
ActiveState=active
SubState=running
MainPID=0
FragmentPath=/etc/systemd/system/droplet.service
DropInPaths=
ExecMainStartTimestamp=@1000
ExecStart={ path=/usr/bin/docker ; argv[]=/usr/bin/docker compose -f $WORK/fakerepo/docker/docker-compose.yml up -d ; ignore_errors=no }
EOF
mkdir -p "$ROOT/etc/droplet"
out="$(env PATH="$WORK/bin:$PATH" DROPLET_HOST_UNITS_ROOT_PREFIX="$ROOT" \
       bash "$HOST_UNITS" audit 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -qF "$WORK/fakerepo/scripts/host/MANIFEST"; then
  pass "the checkout is found from droplet.service's ExecStart with nothing else installed"
else
  fail "checkout discovery from systemd failed (exit $rc)"
  printf '%s\n' "$out" | sed 's/^/      /'
fi
: > "$WORK/units"

# =============================================================================
# Phase 4: mutation tests — prove the guard can FAIL
# =============================================================================
# A guard nobody has watched fail is a guard nobody knows works. Each case
# breaks exactly one thing and asserts the guard says so.
echo "--- Phase 4: mutation tests ---"

MUT="$WORK/mut"
mkdir -p "$MUT"

mutate_check() { # <label> <manifest> <single-box> <expected substring>
  local label="$1" man="$2" sb="$3" want="$4" out
  if out="$(reconcile "$man" "$sb" "$REPO_ROOT_REAL" 2>&1)"; then
    fail "$label — the guard PASSED on a deliberately broken input"
  elif printf '%s\n' "$out" | grep -qF "$want"; then
    pass "$label"
  else
    fail "$label — guard failed, but not for the expected reason"
    printf '%s\n' "$out" | sed 's/^/      /'
  fi
}

# 1. A host artefact added to the installer with no manifest row. THE case:
#    this is WARP-2190 shipping again.
sed -e 's|^install_single_box_host_integration() {|&\n  sudo install -m 0755 "$host_src/usr-local-sbin/droplet-host-net" /usr/local/sbin/droplet-brand-new|' \
  "$SINGLE_BOX" > "$MUT/single-box-added.sh"
mutate_check "a new installer artefact with no manifest row is caught" \
  "$MANIFEST" "$MUT/single-box-added.sh" "/usr/local/sbin/droplet-brand-new"

# 2. A manifest row deleted for something the installer still places.
grep -v '^file  scripts/host/usr-local-sbin/droplet-power-restore ' "$MANIFEST" > "$MUT/manifest-dropped"
mutate_check "a deleted manifest row for a live artefact is caught" \
  "$MUT/manifest-dropped" "$SINGLE_BOX" "/usr/local/sbin/droplet-power-restore"

# 3. A manifest row whose mode disagrees with the installer's `install -m`
#    (which would make the audit report permanent, unfixable false drift).
sed -e 's|\(^file  scripts/host/usr-local-sbin/droplet-power-restore .*\)0755  track|\10644  track|' \
  "$MANIFEST" > "$MUT/manifest-badmode"
mutate_check "a manifest mode that disagrees with the installer is caught" \
  "$MUT/manifest-badmode" "$SINGLE_BOX" "no matching file row"

# 4. A manifest row naming a source that is not in the repo.
{ cat "$MANIFEST"; printf 'file  scripts/host/usr-local-sbin/droplet-imaginary  /usr/local/sbin/droplet-imaginary  0755  track\n'; } > "$MUT/manifest-ghost"
mutate_check "a manifest row naming a nonexistent repo source is caught" \
  "$MUT/manifest-ghost" "$SINGLE_BOX" "does not exist in the repo"

# 5. A `presence` row with no note — opting out of content checking silently.
sed -e 's|^\(file  scripts/host/etc-default/droplet-watchdog .*presence\).*$|\1|' \
  "$MANIFEST" > "$MUT/manifest-nonote"
mutate_check "a policy=presence row with no reason is caught" \
  "$MUT/manifest-nonote" "$SINGLE_BOX" "no note explaining why"

# 6. The installer's function renamed — the parser must fail closed, not
#    silently reconcile an empty set against an empty set.
sed -e 's|^install_single_box_host_integration() {|install_host_integration_v2() {|' \
  "$SINGLE_BOX" > "$MUT/single-box-renamed.sh"
mutate_check "a renamed installer function fails the guard closed" \
  "$MANIFEST" "$MUT/single-box-renamed.sh" "this guard is not reading anything"

# 7. A unit the installer enables with no unit row.
sed -e 's|^\(  sudo systemctl enable droplet-host-net.service.*\)$|\1\n  sudo systemctl enable droplet-something-new.service >/dev/null 2>\&1|' \
  "$SINGLE_BOX" > "$MUT/single-box-enable.sh"
mutate_check "a newly-enabled unit with no manifest row is caught" \
  "$MANIFEST" "$MUT/single-box-enable.sh" "droplet-something-new.service"

# 8. A misspelled policy. The auditor reads anything that is not exactly
#    `presence` as `track`, so this typo would turn content checking back ON
#    for a file whose author meant to turn it off — a red nobody can explain
#    and everybody learns to ignore.
sed -e 's|\(^file  scripts/host/etc-default/droplet-watchdog .*\)presence|\1presense|' \
  "$MANIFEST" > "$MUT/manifest-typo-policy"
mutate_check "a misspelled policy is caught, not silently treated as track" \
  "$MUT/manifest-typo-policy" "$SINGLE_BOX" "unknown kind or policy"

# =============================================================================
echo ""
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mAll %d tests passed\033[0m\n\n" "$TESTS"
  exit 0
fi
printf "  \033[31m%d of %d tests FAILED\033[0m\n\n" "$FAILURES" "$TESTS"
exit 1
