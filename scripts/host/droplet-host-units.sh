#!/usr/bin/env bash
# =============================================================================
# WARP-1829 — droplet-host-units: keep running host units matched to the tree
# =============================================================================
#
# Host systemd units on a Droplet execute their source straight out of the git
# working tree:
#
#   droplet-device-bridge.service
#     ExecStart=/usr/bin/python3 /home/droplet/edge-platform/services/oled-display/device-bridge.py
#
# Python reads that file ONCE, at process start. The refresh flow pulls main
# and restarts CONTAINERS — nothing restarts host units — so the bridge keeps
# running whatever the file said when it launched, across every subsequent
# pull, forever.
#
# It is silent by construction. The code on disk is correct, so reading the
# repo confirms the fix is present. `systemctl status` says active (running).
# Only the running process disagrees, and until this script nothing reported
# it. Measured live on 2026-08-09: droplet-device-bridge.service had run
# 5d20h (PID 5602, started 2026-08-03 22:22:39 UTC) on a file with mtime
# 2026-08-08 02:37:27 UTC. Same file, same env, new process → /openwrt/qr
# flipped from ok:false to ok=true. Blast radius: every host-service fix
# merged since 2026-08-03 (WARP-1800 sat inert two days and caused a full
# misdiagnosis; WARP-1830 was inert the hour it merged).
#
# ── SUBCOMMANDS ──────────────────────────────────────────────────────────────
#   check    Read-only. For every matching host unit, compare its
#            ExecMainStartTimestamp against the mtime of the sources it
#            executes and report any unit older than its own code.
#            Exit 0 = every running unit is at or ahead of its code.
#            Exit 1 = at least one unit is running stale code.
#            This is the piece that turns the next occurrence from a
#            multi-hour misdiagnosis into a one-line answer. It stands on its
#            own — it never restarts anything, and it is correct whether or
#            not the auto-refresh below ever ran.
#
#   refresh  Restart exactly the units `check` calls stale, in a deliberate
#            order, one attempt each, verifying every one came back.
#            Exit 0 = nothing stale, or everything restarted and verified.
#            Exit 1 = at least one unit did not come back (CRITICAL logged).
#
#   Both accept --json (machine-readable report on stdout).
#   `refresh` accepts --force (retry units suspended after a failed restart).
#
# ── WHICH UNITS ARE IN SCOPE (enumerated, never hardcoded) ───────────────────
# Units come from systemd itself (`systemctl list-units --all` filtered by
# DROPLET_HOST_UNITS_MATCH, default `droplet-*`), so a host unit added
# tomorrow is covered the day it lands. A unit is a RESTART CANDIDATE only if
# ALL of these hold:
#
#   1. it has a live main process — ActiveState=active and MainPID != 0;
#   2. its Type is a long-running type (simple/exec/notify/notify-reload/
#      forking/dbus/idle). A `oneshot` re-executes its source on EVERY
#      activation, so it can never be stale — restarting it would be pure
#      churn (droplet-watchdog, droplet-net-selfheal, the panel units, …);
#   3. RemainAfterExit is not yes. This is the load-bearing one:
#      droplet.service is a RemainAfterExit oneshot whose ExecStop is
#      `docker compose down`. "Restarting" it would take the entire box down.
#      Rule 2 already excludes it; rule 3 and the deny-list below are belt
#      and braces because the cost of being wrong is the whole appliance;
#   4. we resolved at least one source file for it;
#   5. it is not in DROPLET_HOST_UNITS_NEVER_RESTART (default: droplet.service
#      and this script's own unit — a unit that restarts itself mid-run is a
#      truncated run, not a refresh).
#
# Everything else is reported `skipped` WITH A REASON. Nothing is silently
# absent from the report (architecture-guard: explicit enums, never inferred
# from absence).
#
# On today's box that resolves to exactly three long-running host units —
# droplet-device-bridge (tree), droplet-host-net and droplet-egress-audit
# (installed copies). None of them touch the management NIC the box is
# reached on: host-net owns br-lan (192.168.20.0/24) DHCP + the /32 route to
# the switch, egress-audit only reads conntrack. Restarting them cannot drop
# SSH. ANY NEW long-running host unit joins this set automatically, which is
# the point — and is why `check` prints the resolved set: whoever adds one
# must confirm its blast radius (a unit that reconfigures the management NIC
# belongs in DROPLET_HOST_UNITS_NEVER_RESTART).
#
# ── WHAT COUNTS AS "SOURCE" ──────────────────────────────────────────────────
# mtime of the files the unit ACTUALLY EXECUTES, confirmed by a content
# digest — not a git diff of the pulled range. Reasons: the box's checkout
# moves by pull, bundle apply, rsync and the occasional hand-edit, so "the
# pulled range" is often undefined; and the question being asked is not "what
# changed in git" but "is this process older than its own code" — which is
# exactly what the standalone check in AC4 must answer. Git only rewrites
# files whose content actually changed, so checkout mtime is a faithful
# signal for "this pull touched this file".
#
# mtime is the cheap TRIGGER; the digest is the CONFIRMATION. setup.sh
# rewrites unit files and /usr/local/sbin copies UNCONDITIONALLY, so their
# mtime moves on every provision whether or not a byte changed — mtime alone
# would restart droplet-host-net on every setup.sh run for nothing. See the
# "Content digest" section below for when a digest may honestly be recorded.
#
#   sources(unit) =
#     FragmentPath + DropInPaths                 (a changed unit definition
#                                                 means the loaded ExecStart
#                                                 may differ from disk)
#   ∪ every ExecStartPre/ExecStart/ExecStartPost argv token that is an
#     existing regular file                      (catches both
#                                                 `/usr/bin/python3 <repo>/x.py`
#                                                 and `/usr/local/sbin/foo`)
#   ∪ for a *.py entry: every *.py under its directory, recursively
#                                                (an ExecStart names ONE file
#                                                 that imports many siblings
#                                                 from the same tree; a change
#                                                 to an imported module is
#                                                 just as stale-making)
#   ∪ for a shell entry: paths under DROPLET_HOST_UNITS_PAYLOAD_ROOTS that the
#     script references and that exist           (droplet-egress-audit is a
#                                                 launcher whose real payload
#                                                 is /usr/local/lib/droplet-
#                                                 egress-audit/collector.py —
#                                                 invisible from argv alone)
#
# EnvironmentFile is deliberately NOT a source. A restart does make a process
# see a changed env file, but droplet-device-bridge WRITES its own
# /var/lib/droplet-bridge/openwrt-attach.env — counting it would have the
# bridge restart itself every time it rotated a key. Credential rotation has
# its own restart path (droplet-openwrt-attach.path).
#
# LIMITATION: argv tokens are split on spaces, so a source path CONTAINING a
# space is not resolved. systemd renders `argv[]=` as a plain space-joined list
# with no quoting, so there is no way to disambiguate one from the outside; the
# unit would report `no source files resolved from its Exec lines` rather than
# claiming a false verdict. No path on the appliance has a space, and a new one
# that did would show up in `check` output as an unresolved unit.
#
# ── INSTALL DRIFT (reported, never restarted for) ────────────────────────────
# A unit executing /usr/local/sbin/<name> runs a COPY installed by setup.sh.
# If the repo pulled but setup.sh has not re-run, the copy is behind the tree
# and the process matches the copy — so it is not "stale", but it is not
# running the merged fix either. That is the same misdiagnosis trap one step
# earlier, so it is reported as `install_drift` with the repo path. It does
# NOT set a failing exit code and does NOT trigger a restart: drift is the
# expected state between a pull and the next setup.sh, and a restart cannot
# fix it (the fix is re-running setup.sh). Making it red would only teach
# people to ignore the check.
#
# ── BOUNDS (no restart loop, no thundering herd) ─────────────────────────────
#   * Restarts are SEQUENTIAL with a settle wait, never parallel.
#   * ONE attempt per unit per invocation.
#   * Order: alphabetical, except DROPLET_HOST_UNITS_RESTART_LAST goes last.
#     droplet-device-bridge is last by default and on purpose — it owns the
#     rack panel's data feed and the console-handback path (WARP-1639), so
#     restarting it briefly blanks panel data. Doing it last means every
#     other unit is already verified back up when the one visible blip
#     happens, and droplet-panel-deadman.timer is the safety net if the
#     bridge does not return.
#   * A unit that does not come back is logged CRITICAL, recorded in
#     $STATE_DIR/suspended, and SKIPPED on subsequent invocations — a
#     restarter that keeps retrying a unit that cannot start IS the restart
#     loop. The suspension lifts by itself as soon as the unit's sources
#     change again (new code may be the fix) or with --force.
#   * The whole thing is self-terminating: a successful restart moves
#     ExecMainStartTimestamp past the source mtime, so the very next run has
#     nothing to do.
#   * No scheduler of its own. `refresh` runs from setup.sh and from
#     droplet-host-units.service (oneshot, on demand); the standing detection
#     ride-along is a check inside the existing droplet-watchdog.timer pass.
#
# Repo-tracked (architecture-guard rule 20): this file installs to
# /usr/local/sbin/droplet-host-units via setup.sh (scripts/lib/single-box.sh)
# — never hand-placed on a box.
#
# ── TEST HOOKS (tests/droplet-host-units.test.sh — no root, no systemd) ──────
#   DROPLET_HOST_UNITS_MATCH             unit glob (default `droplet-*`)
#   DROPLET_HOST_UNITS_STATE_DIR         suspension ledger root
#   DROPLET_HOST_UNITS_NEVER_RESTART     space-separated deny-list
#   DROPLET_HOST_UNITS_RESTART_LAST      space-separated, restarted last
#   DROPLET_HOST_UNITS_SETTLE_SECONDS    post-restart settle wait
#   DROPLET_HOST_UNITS_PAYLOAD_ROOTS     roots a shell launcher may exec from
#   DROPLET_HOST_UNITS_REPO_ROOT         checkout used for install-drift
#   (systemctl is resolved via PATH, so a stub earlier on PATH intercepts it)
# =============================================================================
# Deliberately NOT `set -e`: one unresolvable unit must never abort the sweep
# — every unit gets a verdict. Errors are handled per call.
set -uo pipefail

# --- configuration (no host-specific defaults; everything overridable) -------
HU_MATCH="${DROPLET_HOST_UNITS_MATCH:-droplet-*}"
HU_STATE_DIR="${DROPLET_HOST_UNITS_STATE_DIR:-/var/lib/droplet/host-units}"
HU_NEVER_RESTART="${DROPLET_HOST_UNITS_NEVER_RESTART:-droplet.service droplet-host-units.service}"
HU_RESTART_LAST="${DROPLET_HOST_UNITS_RESTART_LAST:-droplet-device-bridge.service}"
HU_SETTLE="${DROPLET_HOST_UNITS_SETTLE_SECONDS:-3}"
HU_PAYLOAD_ROOTS="${DROPLET_HOST_UNITS_PAYLOAD_ROOTS:-/usr/local/lib /usr/local/share /opt/droplet}"
HU_REPO_ROOT="${DROPLET_HOST_UNITS_REPO_ROOT:-}"

SUSPENDED_FILE="$HU_STATE_DIR/suspended"
DIGEST_DIR="$HU_STATE_DIR/digests"

# Hasher for the content-confirmation step below. sha256sum ships in coreutils
# on every appliance; the fallbacks exist so a stripped host degrades to
# "mtime only" (conservative — more restarts, never fewer) instead of crashing.
HU_HASHER=""
for _h in sha256sum shasum cksum; do
  if command -v "$_h" >/dev/null 2>&1; then HU_HASHER="$_h"; break; fi
done
unset _h

# --- logging ----------------------------------------------------------------
now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log()      { printf '[host-units] %s %s\n' "$(now_iso)" "$*" >&2; }
log_crit() { printf '[host-units] %s CRITICAL: %s\n' "$(now_iso)" "$*" >&2; }

usage() {
  cat <<'USAGE'
Usage: droplet-host-units <check|refresh> [--json] [--force]

  check     Report every host systemd unit whose running process started
            BEFORE the sources it executes were last modified. Read-only.
            Exit 0 = all current, 1 = at least one stale, 2 = usage error.

  refresh   Restart exactly those units — ordered, one attempt each,
            verified. Exit 0 = nothing to do or all verified back up,
            1 = at least one did not come back, 2 = usage error.

  --json    Machine-readable report on stdout.
  --force   (refresh) Retry units suspended after a failed restart.

Why this exists: host units execute their source out of the git working
tree, and the box's refresh restarts containers only — so a merged fix can
sit inert in a running process indefinitely while the repo, the file on
disk and `systemctl status` all look correct. See WARP-1829.
USAGE
}

# =============================================================================
# systemd interrogation
# =============================================================================

# All matching units systemd currently knows about. Some systemd versions
# decorate the first column with a status marker (`●` for a unit that is not
# running) even with --plain, so strip anything before the first unit-name
# character — otherwise the marker becomes the "unit name" and the whole sweep
# silently enumerates nothing.
list_units() {
  systemctl list-units --type=service --all --no-legend --plain "$HU_MATCH" 2>/dev/null \
    | sed -e 's/^[^A-Za-z0-9_.@-]*//' \
    | awk '{ print $1 }' \
    | grep -E '\.service$' \
    | sort -u
}

# Cache of `systemctl show` output for the unit currently being examined.
UNIT_SHOW=""

SHOW_PROPS="-p Id -p Type -p RemainAfterExit -p ActiveState -p SubState \
-p MainPID -p FragmentPath -p DropInPaths -p ExecMainStartTimestamp \
-p ExecStartPre -p ExecStart -p ExecStartPost"

load_unit() { # <unit>
  # --timestamp=unix (systemd >= 247) makes ExecMainStartTimestamp trivially
  # parseable. Older systemd REJECTS the flag outright rather than ignoring it,
  # which would leave UNIT_SHOW empty and make every unit report `skipped` with
  # an empty Type — a silent total no-op, the worst possible failure mode for a
  # detector whose whole job is to break a silence. Retry without it; the human
  # timestamp is parsed by `date -d` in unit_start_epoch.
  # shellcheck disable=SC2086 # SHOW_PROPS is a deliberate word-split flag list
  UNIT_SHOW="$(systemctl show --timestamp=unix $SHOW_PROPS "$1" 2>/dev/null)"
  if [ -z "$UNIT_SHOW" ]; then
    # shellcheck disable=SC2086 # same deliberate word-split
    UNIT_SHOW="$(systemctl show $SHOW_PROPS "$1" 2>/dev/null)"
  fi
}

# First value of a property from the cached show output. Pure bash on purpose:
# this runs ~10x per unit and a grep+cut pair per call turned a 10-second sweep
# into a two-minute one on a slow-fork host.
prop() { # <name>
  local line
  while IFS= read -r line; do
    case "$line" in
      "$1="*) printf '%s' "${line#*=}"; return 0 ;;
    esac
  done <<< "$UNIT_SHOW"
  return 0
}

# Every value line of a (possibly repeated) property.
prop_all() { # <name>
  local line
  while IFS= read -r line; do
    case "$line" in
      "$1="*) printf '%s\n' "${line#*=}" ;;
    esac
  done <<< "$UNIT_SHOW"
  return 0
}

# systemd renders Exec* as:
#   { path=/usr/bin/python3 ; argv[]=/usr/bin/python3 /path/x.py ; ... }
# Pull out the argv[] list.
exec_argv() { # reads stdin
  sed -n 's/.*argv\[\]=\(.*\)/\1/p' | sed 's/ ;.*$//'
}

# Epoch of the unit's running main process. `--timestamp=unix` renders
# `@<epoch>` (systemd >= 247); older systemd emits a human timestamp, which
# GNU date parses. Empty when the unit has never run.
unit_start_epoch() {
  local raw
  raw="$(prop ExecMainStartTimestamp)"
  [ -n "$raw" ] || return 0
  case "$raw" in
    @*) printf '%s' "${raw#@}" ;;
    *)  date -d "$raw" +%s 2>/dev/null ;;
  esac
}

# =============================================================================
# Source resolution
# =============================================================================

# Every *.py under a directory, minus caches, virtualenvs and test trees
# (a test file cannot make a running service stale).
py_tree() { # <dir>
  find "$1" -type f -name '*.py' \
    -not -path '*/__pycache__/*' \
    -not -path '*/.venv/*' \
    -not -path '*/tests/*' \
    -not -path '*/test/*' \
    2>/dev/null
}

is_shell_script() { # <file>
  local first=""
  read -r first < "$1" 2>/dev/null || return 1
  case "$first" in
    '#!'*sh | '#!'*sh\ *) return 0 ;;
    *) return 1 ;;
  esac
}

# Absolute paths under the payload roots that a launcher script references.
# One level only — deliberately not recursive, so the source set stays a
# thing a human can read off `check` output and reason about.
payload_refs() { # <script>
  local root
  for root in $HU_PAYLOAD_ROOTS; do
    grep -oE "${root}/[A-Za-z0-9._/-]+" "$1" 2>/dev/null
  done
}

# Print one source path per line for the loaded unit.
unit_sources() {
  local frag drops token
  frag="$(prop FragmentPath)"
  [ -n "$frag" ] && [ -f "$frag" ] && printf '%s\n' "$frag"
  drops="$(prop DropInPaths)"
  for token in $drops; do
    [ -f "$token" ] && printf '%s\n' "$token"
  done

  local p
  for p in ExecStartPre ExecStart ExecStartPost; do
    prop_all "$p" | exec_argv | tr ' ' '\n' | while IFS= read -r token; do
      [ -n "$token" ] || continue
      [ -f "$token" ] || continue
      printf '%s\n' "$token"
      case "$token" in
        *.py)
          py_tree "$(dirname "$token")"
          ;;
        *)
          if is_shell_script "$token"; then
            payload_refs "$token" | while IFS= read -r ref; do
              [ -n "$ref" ] || continue
              if [ -d "$ref" ]; then
                py_tree "$ref"
              elif [ -f "$ref" ]; then
                printf '%s\n' "$ref"
                case "$ref" in
                  *.py) py_tree "$(dirname "$ref")" ;;
                esac
              fi
            done
          fi
          ;;
      esac
    done
  done
}

# =============================================================================
# Install drift — an executed /usr/local/... copy vs its repo source
# =============================================================================

# Discover the checkout: an ancestor of any executed file that looks like this
# repo. Falls back to DROPLET_HOST_UNITS_REPO_ROOT. Empty → drift unchecked.
REPO_ROOT_RESOLVED=""

resolve_repo_root() { # <candidate path>
  [ -n "$REPO_ROOT_RESOLVED" ] && return 0
  local dir="$1"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -d "$dir/.git" ] && [ -d "$dir/scripts/host" ]; then
      REPO_ROOT_RESOLVED="$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# Repo source for an installed copy, found by basename across the roots the
# installers copy FROM — derived, not a per-unit table that rots.
repo_source_for() { # <installed path>
  [ -n "$REPO_ROOT_RESOLVED" ] || return 1
  local base cand
  base="$(basename "$1")"
  for cand in \
    "$REPO_ROOT_RESOLVED/scripts/host/usr-local-sbin/$base" \
    "$REPO_ROOT_RESOLVED/scripts/host/$base" \
    "$REPO_ROOT_RESOLVED/scripts/host/$base.sh"; do
    [ -f "$cand" ] && { printf '%s' "$cand"; return 0; }
  done
  return 1
}

# =============================================================================
# Content digest — the confirmation step behind the mtime trigger
# =============================================================================
# setup.sh rewrites unit files and /usr/local/sbin copies UNCONDITIONALLY
# (`sed > "$dst"`, `install -m 0644`), so their mtime moves on every provision
# whether or not a byte changed. mtime alone would restart droplet-host-net on
# every single setup.sh run — a br-lan DHCP blip for nothing, and exactly the
# blanket restart this design forbids. So mtime is the cheap TRIGGER and the
# digest is the CONFIRMATION: a unit is stale only when the bytes it would read
# now differ from the bytes it was last known to be running.
#
# The digest is recorded at the only two moments the process is PROVABLY at or
# ahead of its sources: when the sweep observes start >= newest source mtime,
# and after a restart this script verified came back. Never otherwise — a
# digest recorded at any other moment could certify code the process never read.
#
# No digest on file (fresh install) + a newer mtime = stale. Being conservative
# on the first run costs one restart; guessing "probably fine" costs another
# multi-hour misdiagnosis.

DIGEST_WARNED=false

sources_digest() { # <file...>
  [ -n "$HU_HASHER" ] || return 1
  [ "$#" -gt 0 ] || return 1
  # Two forks total regardless of source count: hash the files, then hash the
  # listing (which carries the names, so a rename is a change too).
  "$HU_HASHER" "$@" 2>/dev/null | "$HU_HASHER" 2>/dev/null | cut -d' ' -f1
}

recorded_digest() { # <unit>
  cat "$DIGEST_DIR/$1" 2>/dev/null
}

record_digest() { # <unit> <digest>
  [ -n "$2" ] || return 0
  if ! mkdir -p "$DIGEST_DIR" 2>/dev/null || ! printf '%s' "$2" > "$DIGEST_DIR/$1" 2>/dev/null; then
    # Without a writable state dir the confirmation step is unavailable and
    # every mtime move reads as stale. Say so once — a non-root run silently
    # disagreeing with the root run is its own misdiagnosis.
    if [ "$DIGEST_WARNED" != true ]; then
      log "cannot write $DIGEST_DIR — content confirmation unavailable, falling back to mtime only (run with sudo)"
      DIGEST_WARNED=true
    fi
  fi
}

# =============================================================================
# Suspension ledger
# =============================================================================
# One `<unit> <source-epoch-that-failed>` line per suspended unit. Keyed on the
# source epoch so NEW code lifts the suspension by itself.

suspended_epoch_for() { # <unit>
  [ -f "$SUSPENDED_FILE" ] || return 1
  awk -v u="$1" '$1 == u { print $2; found=1 } END { exit found ? 0 : 1 }' \
    "$SUSPENDED_FILE" 2>/dev/null
}

suspend_unit() { # <unit> <source epoch>
  mkdir -p "$HU_STATE_DIR" 2>/dev/null
  local tmp="$SUSPENDED_FILE.tmp.$$"
  { [ -f "$SUSPENDED_FILE" ] && grep -v "^$1 " "$SUSPENDED_FILE"; printf '%s %s\n' "$1" "$2"; } \
    > "$tmp" 2>/dev/null
  mv "$tmp" "$SUSPENDED_FILE" 2>/dev/null
}

unsuspend_unit() { # <unit>
  [ -f "$SUSPENDED_FILE" ] || return 0
  local tmp="$SUSPENDED_FILE.tmp.$$"
  grep -v "^$1 " "$SUSPENDED_FILE" > "$tmp" 2>/dev/null
  mv "$tmp" "$SUSPENDED_FILE" 2>/dev/null
}

# =============================================================================
# The sweep
# =============================================================================
# Parallel arrays, one slot per unit. Bash 4 has associative arrays but plain
# indexed arrays keep this readable and portable to /bin/sh-ish environments.
R_UNIT=(); R_STATE=(); R_REASON=(); R_START=(); R_SRC_EPOCH=()
R_SRC_PATH=(); R_DRIFT=(); R_DRIFT_SRC=(); R_NSOURCES=(); R_UNITFILE_CHANGED=()
R_DIGEST=()

is_listed() { # <needle> <space-separated haystack>
  local item
  for item in $2; do [ "$item" = "$1" ] && return 0; done
  return 1
}

is_longrunning_type() { # <Type>
  case "$1" in
    simple | exec | notify | notify-reload | forking | dbus | idle) return 0 ;;
    *) return 1 ;;
  esac
}

sweep() {
  local unit
  while IFS= read -r unit; do
    [ -n "$unit" ] || continue
    load_unit "$unit"

    local type remain active mainpid start
    type="$(prop Type)"
    remain="$(prop RemainAfterExit)"
    active="$(prop ActiveState)"
    mainpid="$(prop MainPID)"
    start="$(unit_start_epoch)"

    local state="" reason="" src_epoch=0 src_path="" nsources=0
    local drift="false" drift_src="" unitfile_changed="false" digest=""
    local running="false" suspended_at=""
    if [ "$active" = "active" ] && [ -n "$mainpid" ] && [ "$mainpid" != "0" ]; then
      running="true"
    fi
    suspended_at="$(suspended_epoch_for "$unit" || true)"

    if is_listed "$unit" "$HU_NEVER_RESTART"; then
      state="skipped"; reason="deny-listed (DROPLET_HOST_UNITS_NEVER_RESTART)"
    elif [ "$remain" = "yes" ]; then
      state="skipped"; reason="RemainAfterExit=yes — no live process to be stale"
    elif ! is_longrunning_type "$type"; then
      state="skipped"; reason="Type=$type re-executes its source on every activation"
    elif [ "$running" != "true" ] && [ -z "$suspended_at" ]; then
      # Not our business: never started, stopped by an operator, masked. A
      # dead unit is `systemctl status`'s problem, not a staleness problem.
      state="skipped"; reason="not running (ActiveState=$active, MainPID=${mainpid:-0})"
    elif [ "$running" = "true" ] && [ -z "$start" ]; then
      state="skipped"; reason="no ExecMainStartTimestamp"
    fi

    if [ -z "$state" ]; then
      # Resolve sources and find the newest.
      local sources newest_epoch=0 newest_path="" f mt frag
      local src_files=()
      sources="$(unit_sources | sort -u)"
      frag="$(prop FragmentPath)"
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        nsources=$((nsources + 1))
        src_files+=("$f")
        resolve_repo_root "$(dirname "$f")" >/dev/null 2>&1 || true
        mt="$(stat -c '%Y' "$f" 2>/dev/null || stat -f '%m' "$f" 2>/dev/null)"
        [ -n "$mt" ] || continue
        if [ "$mt" -gt "$newest_epoch" ]; then
          newest_epoch="$mt"; newest_path="$f"
        fi
        # A changed unit DEFINITION additionally needs a daemon-reload.
        if [ "$f" = "$frag" ] && [ "$mt" -gt "$start" ]; then
          unitfile_changed="true"
        fi
        # Install drift: an executed copy whose repo source differs.
        local rs
        if rs="$(repo_source_for "$f")"; then
          if ! cmp -s "$rs" "$f"; then
            drift="true"; drift_src="$rs"
          fi
        fi
      done <<< "$sources"

      src_epoch="$newest_epoch"; src_path="$newest_path"
      digest="$(sources_digest ${src_files[@]+"${src_files[@]}"} || true)"

      if [ "$nsources" -eq 0 ]; then
        state="skipped"; reason="no source files resolved from its Exec lines"
      elif [ "$running" != "true" ]; then
        # Suspended AND down: we restarted it and it never came back. Never
        # let that decay into a quiet "not running" line — a unit this script
        # took down is the loudest thing it can report.
        state="failed"
        reason="DOWN — droplet-host-units restarted it and it did not come back (ActiveState=$active). Inspect: systemctl status $unit; journalctl -u $unit -n 100"
      elif [ "$newest_epoch" -gt "$start" ]; then
        # mtime says maybe. Confirm against the digest recorded the last time
        # this process was provably at or ahead of its sources — setup.sh
        # rewrites unit files and installed copies byte-identically on every
        # run, and restarting for that is churn, not a fix.
        if [ -n "$digest" ] && [ "$digest" = "$(recorded_digest "$unit")" ]; then
          state="current"
          reason="sources rewritten with identical content since the process started (mtime moved, bytes did not)"
        else
          state="stale"
          reason="running process started $(date -u -d "@$start" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null), sources modified $(date -u -d "@$newest_epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
        fi
      else
        # Provably at or ahead of its sources: what is on disk right now IS
        # what this process read. The only safe moment to record the digest.
        state="current"
        record_digest "$unit" "$digest"
      fi
    fi

    R_UNIT+=("$unit");        R_STATE+=("$state")
    R_REASON+=("$reason");    R_START+=("${start:-0}")
    R_SRC_EPOCH+=("$src_epoch"); R_SRC_PATH+=("$src_path")
    R_DRIFT+=("$drift");      R_DRIFT_SRC+=("$drift_src")
    R_NSOURCES+=("$nsources"); R_UNITFILE_CHANGED+=("$unitfile_changed")
    R_DIGEST+=("$digest")
  done < <(list_units)
}

# =============================================================================
# Reporting
# =============================================================================

iso_or_dash() { # <epoch>
  [ "${1:-0}" -gt 0 ] 2>/dev/null || { printf '-'; return; }
  date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '-'
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

report_human() {
  local i n
  n="${#R_UNIT[@]}"
  printf '  host units matched by %s: %d\n' "$HU_MATCH" "$n"
  for ((i = 0; i < n; i++)); do
    case "${R_STATE[$i]}" in
      stale)
        printf '  STALE    %-38s started %s  sources %s\n' \
          "${R_UNIT[$i]}" "$(iso_or_dash "${R_START[$i]}")" "$(iso_or_dash "${R_SRC_EPOCH[$i]}")"
        printf '           newest source: %s\n' "${R_SRC_PATH[$i]}"
        ;;
      current)
        printf '  ok       %-38s started %s  sources %s  (%s file(s))\n' \
          "${R_UNIT[$i]}" "$(iso_or_dash "${R_START[$i]}")" \
          "$(iso_or_dash "${R_SRC_EPOCH[$i]}")" "${R_NSOURCES[$i]}"
        ;;
      failed)
        printf '  FAILED   %-38s %s\n' "${R_UNIT[$i]}" "${R_REASON[$i]}"
        ;;
      restarted)
        printf '  restart  %-38s %s\n' "${R_UNIT[$i]}" "${R_REASON[$i]}"
        ;;
      *)
        printf '  skip     %-38s %s\n' "${R_UNIT[$i]}" "${R_REASON[$i]}"
        ;;
    esac
    if [ "${R_DRIFT[$i]}" = "true" ]; then
      printf '           install drift: the executed copy differs from %s — re-run scripts/setup.sh\n' \
        "${R_DRIFT_SRC[$i]}"
    fi
  done
}

report_json() {
  local i n first=1
  n="${#R_UNIT[@]}"
  printf '{"generated_at":"%s","match":"%s","stale_count":%d,"failed_count":%d,"units":[' \
    "$(now_iso)" "$(json_escape "$HU_MATCH")" "$(count_state stale)" "$(count_state failed)"
  for ((i = 0; i < n; i++)); do
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{"unit":"%s","state":"%s","reason":"%s","started_at":"%s","started_epoch":%s,"newest_source":"%s","newest_source_at":"%s","newest_source_epoch":%s,"sources":%s,"install_drift":%s,"install_drift_source":"%s","unit_file_changed":%s}' \
      "$(json_escape "${R_UNIT[$i]}")" \
      "$(json_escape "${R_STATE[$i]}")" \
      "$(json_escape "${R_REASON[$i]}")" \
      "$(iso_or_dash "${R_START[$i]}")" \
      "${R_START[$i]:-0}" \
      "$(json_escape "${R_SRC_PATH[$i]}")" \
      "$(iso_or_dash "${R_SRC_EPOCH[$i]}")" \
      "${R_SRC_EPOCH[$i]:-0}" \
      "${R_NSOURCES[$i]:-0}" \
      "${R_DRIFT[$i]}" \
      "$(json_escape "${R_DRIFT_SRC[$i]}")" \
      "${R_UNITFILE_CHANGED[$i]}"
  done
  printf ']}\n'
}

count_state() { # <state>
  local i n=0
  for ((i = 0; i < ${#R_STATE[@]}; i++)); do
    [ "${R_STATE[$i]}" = "$1" ] && n=$((n + 1))
  done
  printf '%d' "$n"
}

# =============================================================================
# refresh
# =============================================================================

# Indices of stale units, alphabetical, with RESTART_LAST members moved to the
# end in the order they are listed.
restart_order() {
  local i last_idx=""
  for ((i = 0; i < ${#R_UNIT[@]}; i++)); do
    # `failed` here means "suspended and currently down" — a candidate the
    # suspension gate in do_refresh still has to clear before it is retried.
    case "${R_STATE[$i]}" in stale | failed) ;; *) continue ;; esac
    if is_listed "${R_UNIT[$i]}" "$HU_RESTART_LAST"; then
      last_idx+=" $i"
    else
      printf '%s\n' "$i"
    fi
  done
  local u
  for u in $HU_RESTART_LAST; do
    for i in $last_idx; do
      [ "${R_UNIT[$i]}" = "$u" ] && printf '%s\n' "$i"
    done
  done
}

do_refresh() { # <force>
  local force="$1"
  local idx unit failed=0 reloaded=0

  # A unit whose last restart failed is not retried until its sources change
  # again (or --force): a restarter that keeps retrying a unit that cannot
  # start IS the restart loop this is supposed to prevent.
  for idx in $(restart_order); do
    unit="${R_UNIT[$idx]}"
    local suspended_at
    if [ "$force" != "true" ] && suspended_at="$(suspended_epoch_for "$unit")"; then
      if [ "$suspended_at" = "${R_SRC_EPOCH[$idx]}" ]; then
        R_STATE[$idx]="failed"
        R_REASON[$idx]="restart SUSPENDED — the last attempt on these exact sources did not come back. Inspect: systemctl status $unit; journalctl -u $unit -n 100. Retry: droplet-host-units refresh --force"
        log_crit "$unit is running stale code and its last restart failed — suspended, NOT retried. systemctl status $unit"
        failed=1
        continue
      fi
      # Sources moved since the failure — the new code may be the fix.
      unsuspend_unit "$unit"
    fi

    # A changed unit definition must be reloaded before the restart, or
    # systemd restarts the unit it still has in memory.
    if [ "${R_UNITFILE_CHANGED[$idx]}" = "true" ] && [ "$reloaded" -eq 0 ]; then
      log "unit definition changed — systemctl daemon-reload"
      systemctl daemon-reload
      reloaded=1
    fi

    log "restarting $unit (started $(iso_or_dash "${R_START[$idx]}"), sources $(iso_or_dash "${R_SRC_EPOCH[$idx]}"): ${R_SRC_PATH[$idx]})"
    local rc=0
    systemctl restart "$unit" || rc=$?

    [ "${HU_SETTLE:-0}" -gt 0 ] 2>/dev/null && sleep "$HU_SETTLE"

    # Verify it actually came back — a restart that returns 0 and leaves the
    # unit dead is the failure mode that must never pass silently.
    load_unit "$unit"
    local active mainpid new_start
    active="$(prop ActiveState)"
    mainpid="$(prop MainPID)"
    new_start="$(unit_start_epoch)"
    if [ "$rc" -eq 0 ] && [ "$active" = "active" ] && [ -n "$mainpid" ] && [ "$mainpid" != "0" ]; then
      R_STATE[$idx]="restarted"
      R_REASON[$idx]="restarted at $(iso_or_dash "${new_start:-0}") (PID $mainpid)"
      R_START[$idx]="${new_start:-0}"
      unsuspend_unit "$unit"
      # The new process read the sources as they are right now — the second of
      # the two moments a digest may honestly be recorded.
      record_digest "$unit" "${R_DIGEST[$idx]}"
      log "$unit is back up (PID $mainpid)"
    else
      R_STATE[$idx]="failed"
      R_REASON[$idx]="restart did not come back (exit $rc, ActiveState=$active, MainPID=${mainpid:-0})"
      suspend_unit "$unit" "${R_SRC_EPOCH[$idx]}"
      log_crit "$unit did NOT come back after restart (exit $rc, ActiveState=$active). It is DOWN. Inspect: systemctl status $unit; journalctl -u $unit -n 100"
      failed=1
    fi
  done

  return "$failed"
}

# =============================================================================
# main
# =============================================================================

SUBCOMMAND=""
AS_JSON=false
FORCE=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    check | refresh) SUBCOMMAND="$1"; shift ;;
    --json)  AS_JSON=true; shift ;;
    --force) FORCE=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) printf 'droplet-host-units: unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$SUBCOMMAND" ]; then
  usage >&2
  exit 2
fi

if ! command -v systemctl >/dev/null 2>&1; then
  log "systemctl not found — nothing to check (not a systemd host)"
  [ "$AS_JSON" = true ] && printf '{"generated_at":"%s","match":"%s","stale_count":0,"failed_count":0,"units":[]}\n' \
    "$(now_iso)" "$(json_escape "$HU_MATCH")"
  exit 0
fi

[ -n "$HU_REPO_ROOT" ] && [ -d "$HU_REPO_ROOT" ] && REPO_ROOT_RESOLVED="$HU_REPO_ROOT"

sweep

EXIT=0
if [ "$SUBCOMMAND" = "refresh" ]; then
  do_refresh "$FORCE" || EXIT=1
else
  # A unit running stale code, or one this script took down and never got
  # back, both mean "the box is not running what the tree says".
  { [ "$(count_state stale)" -gt 0 ] || [ "$(count_state failed)" -gt 0 ]; } && EXIT=1
fi

if [ "$AS_JSON" = true ]; then
  report_json
else
  report_human
fi

exit "$EXIT"
