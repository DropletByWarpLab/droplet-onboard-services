#!/usr/bin/env bash
#
# check-vuln-exceptions.sh — WARP-3667.
#
# Fails when a vulnerability exception has no expiry, is past due, or when the
# pinned Trivy database snapshot is older than 35 days.
#
# WHY THIS EXISTS
# ---------------
# The scan gates are deterministic because two things are frozen: the Trivy
# vulnerability DB (.github/trivy-db-version) and the reviewed baseline of
# accepted findings (.trivyignore, osv-scanner.toml). Frozen with no clock,
# an accepted finding is never looked at again and an advisory published after
# the snapshot can never fail a PR. Both must be re-reviewed on a schedule.
#
#   1. .trivyignore — every entry is `<id> exp:YYYY-MM-DD`. Trivy itself stops
#      ignoring an entry the day it expires (docker-build then fails on it);
#      this check additionally refuses an entry that has NO expiry, which
#      Trivy would accept as "ignore forever".
#   2. osv-scanner.toml — every [[IgnoredVulns]] has `ignoreUntil = YYYY-MM-DD`
#      (osv-scanner enforces it natively; this refuses a block without one).
#   3. .github/trivy-db-version — the `Snapshot pinned: YYYY-MM-DD` line must
#      be at most 35 days old. Refresh: see that file's header.
#
# Extending an exception is a reviewed edit of the date, never a deletion.
#
# Usage:
#   scripts/check-vuln-exceptions.sh              # check the tracked files
#   scripts/check-vuln-exceptions.sh --selfcheck  # prove the gate itself
set -eu

cd "$(dirname "$0")/.."

MAX_PIN_AGE_DAYS=35
TRIVYIGNORE="${TRIVYIGNORE:-.trivyignore}"
OSV_TOML="${OSV_TOML:-osv-scanner.toml}"
TRIVY_PIN="${TRIVY_PIN:-.github/trivy-db-version}"
TODAY="${CHECK_TODAY:-$(date -u +%F)}"

epoch() { date -u -d "$1" +%s 2>/dev/null || date -u -j -f %Y-%m-%d "$1" +%s; }

run_checks() {
  local bad=0 n_trivy=0 n_osv=0 line id date snap age

  # 1. .trivyignore
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    n_trivy=$((n_trivy + 1))
    if ! printf '%s' "$line" | grep -Eq '^[A-Za-z0-9._-]+ exp:[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
      echo "FAIL: $TRIVYIGNORE: '$line' has no 'exp:YYYY-MM-DD' expiry" >&2; bad=$((bad + 1)); continue
    fi
    date="${line##*exp:}"
    if [ "$date" \< "$TODAY" ]; then
      echo "FAIL: $TRIVYIGNORE: $line expired (today is $TODAY) — re-triage and extend, or fix the finding" >&2
      bad=$((bad + 1))
    fi
  done < "$TRIVYIGNORE"

  # 2. osv-scanner.toml: one record per [[IgnoredVulns]] block, "<id>|<ignoreUntil or empty>"
  while IFS='|' read -r id date; do
    n_osv=$((n_osv + 1))
    if [ -z "$date" ]; then
      echo "FAIL: $OSV_TOML: $id has no ignoreUntil" >&2; bad=$((bad + 1))
    elif [ "$date" \< "$TODAY" ]; then
      echo "FAIL: $OSV_TOML: $id ignoreUntil $date is past due (today is $TODAY)" >&2; bad=$((bad + 1))
    fi
  done < <(awk '
    function flush() { if (inblk) print id "|" until }
    /^\[\[/ { flush(); inblk = ($0 ~ /^\[\[IgnoredVulns\]\]/); id = "?"; until = ""; next }
    inblk && /^id[[:space:]]*=/ { id = $0; sub(/^id[[:space:]]*=[[:space:]]*"/, "", id); sub(/".*$/, "", id) }
    inblk && /^ignoreUntil[[:space:]]*=/ { u = $0; sub(/^ignoreUntil[[:space:]]*=[[:space:]]*/, "", u); sub(/[^0-9-].*$/, "", u); until = u }
    END { flush() }
  ' "$OSV_TOML")

  # 3. Trivy DB pin age
  snap="$(grep -E '^# Snapshot pinned: [0-9]{4}-[0-9]{2}-[0-9]{2}' "$TRIVY_PIN" | head -1 | sed -E 's/^# Snapshot pinned: ([0-9-]{10}).*/\1/')"
  if [ -z "$snap" ]; then
    echo "FAIL: $TRIVY_PIN: no '# Snapshot pinned: YYYY-MM-DD' line" >&2; bad=$((bad + 1))
  else
    age=$(( ($(epoch "$TODAY") - $(epoch "$snap")) / 86400 ))
    if [ "$age" -gt "$MAX_PIN_AGE_DAYS" ]; then
      echo "FAIL: $TRIVY_PIN: snapshot $snap is $age days old (max $MAX_PIN_AGE_DAYS) — refresh the pin and re-baseline .trivyignore (see that file's header)" >&2
      bad=$((bad + 1))
    fi
  fi

  echo "checked: $n_trivy .trivyignore entries, $n_osv osv ignores, Trivy DB pin ${snap:-?}"
  return "$bad"
}

if [ "${1:-}" = "--selfcheck" ]; then
  d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
  mk() { # $1=trivyignore body $2=osv body $3=pin date
    printf '%s\n' "$1" > "$d/ti"; printf '%s\n' "$2" > "$d/osv"
    printf '# Snapshot pinned: %s (schema v2)\nsha256:x\n' "$3" > "$d/pin"
  }
  expect() { # $1=ok|bad $2=label
    if (TRIVYIGNORE="$d/ti" OSV_TOML="$d/osv" TRIVY_PIN="$d/pin" CHECK_TODAY=2026-10-04 run_checks >/dev/null 2>&1); then got=ok; else got=bad; fi
    [ "$got" = "$1" ] || { echo "self-test FAILED: $2 (wanted $1)" >&2; exit 1; }
  }
  G_OSV='[[IgnoredVulns]]
id = "GHSA-1"
ignoreUntil = 2027-01-02
reason = "r"'
  mk 'CVE-1 exp:2027-01-02' "$G_OSV" 2026-10-01; expect ok  "all valid"
  mk 'CVE-1'                "$G_OSV" 2026-10-01; expect bad "trivy entry without expiry"
  mk 'CVE-1 exp:2026-10-03' "$G_OSV" 2026-10-01; expect bad "trivy entry expired"
  mk 'CVE-1 exp:2027-01-02' '[[IgnoredVulns]]
id = "GHSA-1"
reason = "r"' 2026-10-01;                           expect bad "osv ignore without ignoreUntil"
  mk 'CVE-1 exp:2027-01-02' '[[IgnoredVulns]]
id = "GHSA-1"
ignoreUntil = 2026-09-01
reason = "r"' 2026-10-01;                           expect bad "osv ignore past due"
  mk 'CVE-1 exp:2027-01-02' "$G_OSV" 2026-08-01; expect bad "Trivy DB pin older than 35 days"
  mk 'CVE-1 exp:2027-01-02' "$G_OSV" 2026-08-30; expect ok  "pin 35 days old is still fresh"
  echo "check-vuln-exceptions self-test: OK"
  exit 0
fi

if run_checks; then
  echo "check-vuln-exceptions: OK"
else
  echo "check-vuln-exceptions: FAILED — see the FAIL lines above." >&2
  exit 1
fi
