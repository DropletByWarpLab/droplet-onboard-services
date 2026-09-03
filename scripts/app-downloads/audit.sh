#!/usr/bin/env bash
# =============================================================================
# audit.sh — reconcile data/app-downloads/EXPECTED against what is staged.
#
# WHY THIS EXISTS
# ---------------
# `/api/app-downloads` answers HTTP 200 with `available:false` when nothing is
# staged (routes/app-downloads.ts classifies `catalog_missing` as benign, and
# that is the right call for the API). The consequence is that an appliance
# whose "Get the app" page is completely empty is GREEN to /api/health, to
# every uptime probe, to every smoke test and to all of the watchdog's other
# checks. Every box that has ever shipped has been in that state.
#
# Observing the directory is not enough to fix that: "it is empty" is true and
# uninformative, and any naive check goes green the moment ONE platform is
# staged. So EXPECTED declares what a release is SUPPOSED to carry, and this
# script reconciles the declaration against reality. Same shape as
# `droplet-host-units audit` reconciling scripts/host/MANIFEST (WARP-2574).
#
# USAGE
#   scripts/app-downloads/audit.sh [--dir <staging root>] [--quiet]
#
# OUTPUT — one line per platform. Column 1 is a whitespace-free label and
# column 2 is the platform, because callers (the watchdog, ship-check) read
# those two fields with awk. tests/app-downloads-audit.test.sh pins the
# contract, so a reformatted report cannot silently break them.
#
#   OK            <platform>  <detail>
#   MISSING       <platform>  declared but not staged / no usable asset
#   STALE         <platform>  staged bytes disagree with the catalog
#   BLOCKED       <platform>  deliberately not shipping, ticket named
#   UNDECLARED    <platform>  staged, but EXPECTED still says blocked
#   UNVERIFIABLE  <platform>  declared, staged, but could not be checked
#
# EXIT CONTRACT — copied deliberately from `droplet-host-units audit`:
#   0  everything EXPECTED declares is satisfied (no blocked rows)
#   1  a real gap: MISSING, STALE, UNDECLARED or UNVERIFIABLE
#   3  clean, but N platforms are `blocked` — each named with its ticket
#   4  COULD NOT LOOK — no EXPECTED, no staging root, no hasher.
#
# 4 must NEVER collapse into 0. "I could not check" and "I checked and it is
# fine" sharing an exit code is the precise bug this file exists to end.
# =============================================================================
set -uo pipefail

AUD_DIR="${DROPLET_APP_DOWNLOADS_DIR:-}"
QUIET=false

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      shift
      [ $# -gt 0 ] || { printf 'audit: --dir needs a path\n' >&2; exit 4; }
      AUD_DIR="$1"
      ;;
    --quiet) QUIET=true ;;
    -h|--help)
      sed -n '3,42p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) printf 'audit: unknown argument: %s\n' "$1" >&2; exit 4 ;;
  esac
  shift
done

say() { [ "$QUIET" = true ] || printf '%s\n' "$*"; }
note() { printf '%s\n' "$*" >&2; }

# --- locate the staging root -------------------------------------------------
# Resolved from this script's own location by default, so a box, a CI runner
# and a developer checkout all agree without anyone passing a path. An explicit
# --dir always wins, which is what makes the test suite hermetic.
if [ -z "$AUD_DIR" ]; then
  _self="$(cd "$(dirname "$0")" && pwd)"
  AUD_DIR="$(cd "$_self/../.." && pwd)/data/app-downloads"
fi

if [ ! -d "$AUD_DIR" ]; then
  note "audit: no staging root at $AUD_DIR — no verdict"
  exit 4
fi

EXPECTED_FILE="$AUD_DIR/EXPECTED"
if [ ! -r "$EXPECTED_FILE" ]; then
  note "audit: no readable EXPECTED at $EXPECTED_FILE — no verdict"
  exit 4
fi

CATALOG="$AUD_DIR/catalog.json"

# --- hasher ------------------------------------------------------------------
# sha256sum ships in coreutils on every appliance; the fallbacks exist so a
# stripped host or a macOS dev box degrades to a verdict rather than to a lie.
_hash_cmd=""
if command -v sha256sum >/dev/null 2>&1; then _hash_cmd=sha256sum
elif command -v shasum >/dev/null 2>&1; then _hash_cmd="shasum -a 256"
fi

sha256_of() { # <path> → hex digest on stdout, or empty
  [ -n "$_hash_cmd" ] || return 1
  # shellcheck disable=SC2086
  $_hash_cmd "$1" 2>/dev/null | awk '{ print $1 }'
}

# --- catalog reader ----------------------------------------------------------
# python3 is the only JSON parser guaranteed on the appliance (Node lives
# inside the orchestrator image, not on the host). Without it there is no way
# to read the catalog, and the honest answer is exit 4 — not a green verdict.
HAVE_PY=false
if command -v python3 >/dev/null 2>&1; then HAVE_PY=true; fi

# Emits, for one platform: "<primary>\t<storeUrl>\t<installerCount>" then one
# "<name>\t<size>\t<sha256>" line per asset. Exits 3 if the catalog is
# unreadable/malformed, 2 if the platform is not in it.
catalog_platform() { # <platform>
  python3 - "$CATALOG" "$1" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "rb") as fh:
        cat = json.load(fh)
except FileNotFoundError:
    sys.exit(2)
except Exception:
    sys.exit(3)
if not isinstance(cat, dict) or not isinstance(cat.get("platforms"), list):
    sys.exit(3)
for entry in cat["platforms"]:
    if isinstance(entry, dict) and entry.get("platform") == sys.argv[2]:
        assets = entry.get("assets") or []
        installers = [a for a in assets if isinstance(a, dict) and a.get("kind") == "installer"]
        print("%s\t%s\t%d" % (entry.get("primary") or "", entry.get("storeUrl") or "", len(installers)))
        for a in assets:
            if isinstance(a, dict):
                print("%s\t%s\t%s" % (a.get("name") or "", a.get("size"), a.get("sha256") or ""))
        sys.exit(0)
sys.exit(2)
PY
}

# --- reconcile ---------------------------------------------------------------
n_missing=0; n_stale=0; n_blocked=0; n_unverifiable=0; n_ok=0; n_rows=0; n_undeclared=0
blocked_names=""

while read -r platform policy ticket rest || [ -n "${platform:-}" ]; do
  case "$platform" in ''|'#'*) continue ;; esac
  [ -n "${policy:-}" ] || { note "audit: EXPECTED row for '$platform' has no policy — no verdict"; exit 4; }
  n_rows=$((n_rows + 1))

  case "$policy" in
    absent)
      continue
      ;;
    blocked)
      # A blocked row with no ticket is indistinguishable from a forgotten
      # one. Refuse to give a verdict rather than report a clean box.
      if [ -z "${ticket:-}" ] || [ "$ticket" = "-" ] || [ -z "${rest:-}" ]; then
        note "audit: EXPECTED row '$platform blocked' needs BOTH a ticket and a note — no verdict"
        exit 4
      fi
      # The declaration can go stale in the GOOD direction too. If an operator
      # stages an installer for a platform still marked `blocked`, nothing else
      # notices: the page starts serving it, every gate keeps reporting
      # "deliberately blocked", and EXPECTED quietly stops describing reality —
      # so the row never gets flipped and the build keeps needing
      # --allow-blank-downloads for a platform that is no longer blank.
      if [ -d "$AUD_DIR/$platform" ] && [ -n "$(ls -A "$AUD_DIR/$platform" 2>/dev/null)" ]; then
        n_undeclared=$((n_undeclared + 1))
        say "UNDECLARED    $platform  files are staged but EXPECTED still says blocked ($ticket) — flip the row to 'installer' or clear the directory"
        continue
      fi
      n_blocked=$((n_blocked + 1))
      blocked_names="$blocked_names $platform($ticket)"
      say "BLOCKED       $platform  $ticket — $rest"
      continue
      ;;
    installer|store) ;;
    *)
      note "audit: EXPECTED row '$platform' has unknown policy '$policy' — no verdict"
      exit 4
      ;;
  esac

  if [ "$HAVE_PY" = false ]; then
    note "audit: python3 not found — cannot read $CATALOG"
    exit 4
  fi

  info=""
  rc=0
  info="$(catalog_platform "$platform")" || rc=$?
  if [ "$rc" = 3 ]; then
    note "audit: $CATALOG is unreadable or malformed — no verdict"
    exit 4
  fi
  if [ "$rc" = 2 ]; then
    n_missing=$((n_missing + 1))
    if [ -f "$CATALOG" ]; then
      say "MISSING       $platform  declared '$policy' in EXPECTED but absent from catalog.json"
    else
      say "MISSING       $platform  declared '$policy' in EXPECTED but nothing is staged (no catalog.json)"
    fi
    continue
  fi

  header="$(printf '%s\n' "$info" | head -1)"
  primary="$(printf '%s' "$header" | cut -f1)"
  store_url="$(printf '%s' "$header" | cut -f2)"
  installer_count="$(printf '%s' "$header" | cut -f3)"

  if [ "$policy" = store ]; then
    case "$store_url" in
      '')
        n_missing=$((n_missing + 1))
        say "MISSING       $platform  declared 'store' but the catalog entry has no storeUrl"
        ;;
      *REPLACE-ME*)
        n_missing=$((n_missing + 1))
        say "MISSING       $platform  storeUrl is the placeholder '$store_url' — that is not a listing"
        ;;
      *)
        n_ok=$((n_ok + 1))
        say "OK            $platform  store link $store_url"
        ;;
    esac
    continue
  fi

  # policy == installer
  if [ "${installer_count:-0}" -lt 1 ] || [ -z "$primary" ]; then
    n_missing=$((n_missing + 1))
    say "MISSING       $platform  declared 'installer' but the catalog entry has no installer asset"
    continue
  fi

  # Every declared asset must exist on disk with the pinned size and digest.
  # The orchestrator re-hashes at serve time and refuses on mismatch, so a
  # drifted byte here is a download that 503s in front of a customer.
  bad=""
  while IFS="$(printf '\t')" read -r name size digest; do
    [ -n "$name" ] || continue
    file="$AUD_DIR/$platform/$name"
    if [ ! -f "$file" ]; then bad="$bad $name(absent)"; continue; fi
    actual_size="$(wc -c < "$file" 2>/dev/null | tr -d ' ')"
    if [ -n "$size" ] && [ "$size" != "None" ] && [ "$actual_size" != "$size" ]; then
      bad="$bad $name(size $actual_size!=$size)"
      continue
    fi
    if [ -n "$digest" ]; then
      actual="$(sha256_of "$file")" || {
        n_unverifiable=$((n_unverifiable + 1))
        say "UNVERIFIABLE  $platform  no sha256 tool on this host — cannot confirm $name"
        bad="__unverifiable__"
        break
      }
      [ "$actual" = "$digest" ] || bad="$bad $name(digest)"
    fi
  done <<EOF
$(printf '%s\n' "$info" | tail -n +2)
EOF

  if [ "$bad" = "__unverifiable__" ]; then
    continue
  fi
  if [ -n "$bad" ]; then
    n_stale=$((n_stale + 1))
    say "STALE         $platform  staged bytes disagree with catalog.json:$bad"
    continue
  fi

  n_ok=$((n_ok + 1))
  say "OK            $platform  $primary ($installer_count installer asset(s)) verified against catalog.json"
# Process substitution, NOT a pipe: a `while` on the right of a pipe runs in a
# subshell and every counter above would be incremented and then discarded.
#
# The `tr` strips CR. .gitattributes pins this file to LF, but it can also
# arrive by scp or from an editor, and a trailing CR lands in the LAST field of
# a row — on a 3-field `absent`/`blocked` row that is the ticket, so `-\r`
# stops equalling `-` and the auditor refuses to rule on a correct file.
done < <(tr -d '\r' < "$EXPECTED_FILE")

if [ "$n_rows" = 0 ]; then
  note "audit: EXPECTED declares no platforms — no verdict"
  exit 4
fi

# --- verdict -----------------------------------------------------------------
if [ $((n_missing + n_stale + n_unverifiable + n_undeclared)) -gt 0 ]; then
  say ""
  say "audit: $n_missing missing, $n_stale stale, $n_unverifiable unverifiable, $n_undeclared undeclared — EXPECTED and this staging root disagree"
  exit 1
fi

if [ "$n_blocked" -gt 0 ]; then
  say ""
  say "audit: $n_ok satisfied, $n_blocked deliberately blocked —${blocked_names}"
  exit 3
fi

say ""
say "audit: $n_ok platform(s) satisfied, nothing blocked"
exit 0
