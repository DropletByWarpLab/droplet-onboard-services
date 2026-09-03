#!/usr/bin/env bash
# =============================================================================
# Unit tests for scripts/app-downloads/audit.sh + data/app-downloads/EXPECTED.
#
# WARP-2666. The auditor is the piece that lets any gate say something more
# useful than "the directory is empty". Its exit contract is load-bearing —
# scripts/image/build-iso.sh refuses a build on it, scripts/test/ship-check.sh
# reports on it, and scripts/host/droplet-watchdog.sh reads its report with awk
# on columns 1 and 2 — so these tests pin:
#
#   Phase 1  behaviour per policy, and every exit code, INCLUDING exit 4.
#            "I could not look" sharing an exit code with "I looked and it is
#            fine" is the precise bug this whole change exists to end, so exit
#            4 must never collapse into 0.
#   Phase 2  a replay of the state every shipped box has actually been in —
#            only the tracked files, nothing staged — which must be exit 3
#            with zero OK rows. If this ever comes back 0, the gate is lying.
#   Phase 3  BOTH-DIRECTIONS reconciliation of EXPECTED against the generator's
#            own platform list, plus the rules that keep a `blocked` row
#            honest. This is what stops the blind spot reopening: a platform
#            added to gen-catalog with no EXPECTED row fails CI.
#   Phase 4  MUTATION — corrupt each Phase-3 assertion in a throwaway copy and
#            prove the assertion actually FAILS. A guard nobody has watched
#            fail is a guard nobody knows works.
#
# Hermetic: everything under mktemp, fake installers, no Docker, no network.
# Runtime: < 5 seconds. Requires: bash, node, python3.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
AUDIT="$REPO_ROOT_REAL/scripts/app-downloads/audit.sh"
GEN="$REPO_ROOT_REAL/scripts/app-downloads/gen-catalog.mjs"
REAL_EXPECTED="$REPO_ROOT_REAL/data/app-downloads/EXPECTED"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  app-downloads — audit.sh + EXPECTED"
echo "  ================================================"
echo ""

for f in "$AUDIT" "$GEN" "$REAL_EXPECTED"; do
  if [ -f "$f" ]; then pass "exists: ${f#"$REPO_ROOT_REAL"/}"
  else fail "missing: ${f#"$REPO_ROOT_REAL"/}"; echo "FAILURES=$FAILURES"; exit 1; fi
done

command -v node >/dev/null 2>&1 || { fail "node is required"; echo "FAILURES=$FAILURES"; exit 1; }
command -v python3 >/dev/null 2>&1 || { fail "python3 is required"; echo "FAILURES=$FAILURES"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Run the auditor against a root, leaving the report in $OUT and the exit code
# in $RC. Deliberately NOT a function whose result is read via `$(...)`: command
# substitution runs in a subshell, so an $OUT set in there is discarded and
# every content assertion below would silently compare against an empty string
# — a whole class of tests that can only pass.
OUT=""
RC=0
run_audit() { # <root>
  OUT="$(bash "$AUDIT" --dir "$1" 2>&1)"
  RC=$?
}

expect_rc() { # <label> <want> <root>
  run_audit "$3"
  if [ "$RC" = "$2" ]; then pass "$1 (exit $RC)"
  else fail "$1 — wanted exit $2, got $RC"; printf '%s\n' "$OUT" | sed 's/^/      | /'; fi
}

# Assert on the captured report. Guards against the empty-$OUT trap above by
# refusing to pass on an empty report.
expect_out() { # <label> <grep -E pattern>
  if [ -z "$OUT" ]; then fail "$1 — the report was empty (nothing was captured)"; return; fi
  if printf '%s\n' "$OUT" | grep -Eq "$2"; then pass "$1"
  else fail "$1 — report did not match /$2/"; printf '%s\n' "$OUT" | sed 's/^/      | /'; fi
}

# -----------------------------------------------------------------------------
echo "  -- Phase 1: exit contract ----------------------"
# -----------------------------------------------------------------------------

expect_rc "no staging root at all → no verdict" 4 "$WORK/nope"

R="$WORK/no-expected"; mkdir -p "$R"
expect_rc "staging root with no EXPECTED → no verdict" 4 "$R"

R="$WORK/empty-expected"; mkdir -p "$R"; printf '# only comments\n\n' > "$R/EXPECTED"
expect_rc "EXPECTED declaring no platforms → no verdict" 4 "$R"

R="$WORK/bad-policy"; mkdir -p "$R"; printf 'windows sometimes - who knows\n' > "$R/EXPECTED"
expect_rc "unknown policy → no verdict, never a pass" 4 "$R"

R="$WORK/blocked-no-ticket"; mkdir -p "$R"; printf 'windows blocked - \n' > "$R/EXPECTED"
expect_rc "blocked row with no ticket → no verdict" 4 "$R"

R="$WORK/blocked-no-note"; mkdir -p "$R"; printf 'windows blocked WARP-1\n' > "$R/EXPECTED"
expect_rc "blocked row with a ticket but no reason → no verdict" 4 "$R"

R="$WORK/blocked-ok"; mkdir -p "$R"
printf 'windows blocked WARP-1 no tag cut yet\nmacos absent - none\n' > "$R/EXPECTED"
expect_rc "properly declared blocked row → 3, not 0" 3 "$R"
expect_out "the blocked report names the platform AND its ticket" '^BLOCKED +windows +WARP-1 '

R="$WORK/absent-only"; mkdir -p "$R"; printf 'macos absent - no client\nlinux absent - no client\n' > "$R/EXPECTED"
expect_rc "only 'absent' rows → clean" 0 "$R"

R="$WORK/missing-installer"; mkdir -p "$R"; printf 'windows installer WARP-1 must ship\n' > "$R/EXPECTED"
expect_rc "declared installer, nothing staged → a real gap" 1 "$R"

# Now stage something real and regenerate.
R="$WORK/staged"; mkdir -p "$R/windows"
printf 'windows installer WARP-1 must ship\n' > "$R/EXPECTED"
printf 'MZ fake droplet installer payload' > "$R/windows/Droplet_9.9.9_x64-setup.exe"
printf '{"windows":{"version":"9.9.9"}}' > "$R/platforms.json"
node "$GEN" --dir "$R" >/dev/null 2>&1
expect_rc "declared installer, staged and hashed → clean" 0 "$R"
expect_out "the clean report names the platform it verified" '^OK +windows '

# Same length, different bytes: size alone would miss this.
printf 'MZ fake droplet installer PAYLOAD' > "$R/windows/Droplet_9.9.9_x64-setup.exe"
expect_rc "staged bytes changed under a valid catalog → STALE" 1 "$R"
expect_out "a digest drift at identical size is reported STALE" '^STALE +windows .*digest'

# Deleting the file entirely is a different failure, still a gap.
rm -f "$R/windows/Droplet_9.9.9_x64-setup.exe"
expect_rc "catalog declares an asset that is gone → a real gap" 1 "$R"

# `store` policy: a placeholder is not a listing.
R="$WORK/store-placeholder"; mkdir -p "$R"
printf 'android store WARP-1 play listing\n' > "$R/EXPECTED"
printf '{"android":{"version":"1.0","storeUrl":"https://testflight.apple.com/join/REPLACE-ME"}}' > "$R/platforms.json"
node "$GEN" --dir "$R" >/dev/null 2>&1
expect_rc "a REPLACE-ME storeUrl is not a store listing" 1 "$R"

R="$WORK/store-real"; mkdir -p "$R"
printf 'android store WARP-1 play listing\n' > "$R/EXPECTED"
printf '{"android":{"version":"1.0","storeUrl":"https://play.google.com/apps/internaltest/1234567890"}}' > "$R/platforms.json"
node "$GEN" --dir "$R" >/dev/null 2>&1
expect_rc "a real-looking store listing satisfies 'store'" 0 "$R"

# A `blocked` row whose directory has files in it. The declaration has gone
# stale in the GOOD direction, and without this nothing notices: the page would
# start serving the app while every gate kept saying "deliberately blocked",
# and the build would keep demanding --allow-blank-downloads for a platform
# that is no longer blank.
R="$WORK/blocked-but-staged"; mkdir -p "$R/windows"
printf 'windows blocked WARP-1 no tag cut yet\n' > "$R/EXPECTED"
printf 'MZ someone staged this anyway' > "$R/windows/Droplet_9.9.9_x64-setup.exe"
expect_rc "a blocked platform with files staged is a real gap" 1 "$R"
expect_out "the report says the declaration is stale, and how to fix it" '^UNDECLARED +windows .*flip the row'

# ...and the same row with an EMPTY directory is still just blocked. An empty
# platform dir is what `stage.sh --unstage` and a plain mkdir leave behind, so
# treating its mere existence as "staged" would make the check cry wolf.
rm -f "$R/windows/Droplet_9.9.9_x64-setup.exe"
expect_rc "an EMPTY platform directory is still just blocked" 3 "$R"

# A malformed catalog must not read as "nothing staged".
R="$WORK/malformed"; mkdir -p "$R"
printf 'windows installer WARP-1 must ship\n' > "$R/EXPECTED"
printf 'this is not json' > "$R/catalog.json"
expect_rc "a malformed catalog → no verdict, not a green pass" 4 "$R"

# -----------------------------------------------------------------------------
echo ""
echo "  -- Phase 2: replay of the state every box shipped in --"
# -----------------------------------------------------------------------------
# Exactly what a freshly imaged box has: the tracked files, nothing staged.
R="$WORK/shipped"; mkdir -p "$R"
cp "$REAL_EXPECTED" "$R/EXPECTED"
cp "$REPO_ROOT_REAL/data/app-downloads/README.md" "$R/" 2>/dev/null || true
cp "$REPO_ROOT_REAL/data/app-downloads/platforms.example.json" "$R/" 2>/dev/null || true

run_audit "$R"
if [ "$RC" = 3 ]; then
  pass "a shipped box's staging root reports 3 (blocked), never 0"
elif [ "$RC" = 0 ]; then
  fail "REGRESSION: an empty staging root reported CLEAN — the gate is lying"
else
  fail "a shipped box's staging root reported $RC, wanted 3"
  printf '%s\n' "$OUT" | sed 's/^/      | /'
fi

if printf '%s\n' "$OUT" | awk '$1 == "OK" { found = 1 } END { exit !found }'; then
  fail "an empty staging root produced an OK row"
else
  pass "an empty staging root produces zero OK rows"
fi

# -----------------------------------------------------------------------------
echo ""
echo "  -- Phase 3: EXPECTED reconciles with the generator --
"
# -----------------------------------------------------------------------------
# The both-directions guard. Adding a platform to gen-catalog.mjs without an
# EXPECTED row would make it silently unaudited — the exact shape of the
# original bug — so CI fails on it.
GEN_PLATFORMS="$(node -e '
  const fs = require("fs");
  const src = fs.readFileSync(process.argv[1], "utf8");
  const m = src.match(/const PLATFORMS = \[([^\]]*)\]/);
  if (!m) { process.stderr.write("could not read PLATFORMS from gen-catalog.mjs\n"); process.exit(1); }
  process.stdout.write(m[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean).join("\n"));
' "$GEN")" || GEN_PLATFORMS=""

if [ -z "$GEN_PLATFORMS" ]; then
  fail "could not read the PLATFORMS list out of gen-catalog.mjs"
else
  pass "read $(printf '%s\n' "$GEN_PLATFORMS" | wc -l | tr -d ' ') platform(s) from gen-catalog.mjs"
fi

# Reusable so Phase 4 can run the same assertions against a mutated copy.
check_expected_file() { # <expected file> → prints one line per violation
  local f="$1" platform policy ticket rest
  local declared=""
  while read -r platform policy ticket rest || [ -n "${platform:-}" ]; do
    case "$platform" in ''|'#'*) continue ;; esac
    declared="$declared $platform"
    case "$policy" in
      installer|store|blocked|absent) ;;
      *) printf 'unknown-policy %s %s\n' "$platform" "$policy" ;;
    esac
    if [ "$policy" = blocked ]; then
      if [ -z "${ticket:-}" ] || [ "$ticket" = "-" ]; then
        printf 'blocked-without-ticket %s\n' "$platform"
      else
        case "$ticket" in WARP-[0-9]*) ;; *) printf 'blocked-ticket-not-warp %s %s\n' "$platform" "$ticket" ;; esac
      fi
      [ -n "${rest:-}" ] || printf 'blocked-without-note %s\n' "$platform"
    fi
    case "$rest" in *REPLACE-ME*) printf 'placeholder-in-row %s\n' "$platform" ;; esac
    # Every row must name a platform the generator knows about.
    if ! printf '%s\n' "$GEN_PLATFORMS" | grep -qx "$platform"; then
      printf 'unknown-platform %s\n' "$platform"
    fi
  done < "$f"
  # ...and every platform the generator knows about must have a row.
  local g
  for g in $GEN_PLATFORMS; do
    case " $declared " in *" $g "*) ;; *) printf 'undeclared-platform %s\n' "$g" ;; esac
  done
}

violations="$(check_expected_file "$REAL_EXPECTED")"
if [ -z "$violations" ]; then
  pass "EXPECTED and gen-catalog.mjs agree in both directions, every blocked row is ticketed"
else
  fail "EXPECTED violates the reconciliation rules:"
  printf '%s\n' "$violations" | sed 's/^/      | /'
fi

# -----------------------------------------------------------------------------
echo ""
echo "  -- Phase 4: mutation — prove Phase 3 can fail --"
# -----------------------------------------------------------------------------
mutate_and_expect() { # <label> <sed program> <violation token>
  local m="$WORK/mutant-EXPECTED"
  sed "$2" "$REAL_EXPECTED" > "$m"
  if [ ! -s "$m" ]; then fail "$1 — mutation produced an empty file"; return; fi
  local v
  v="$(check_expected_file "$m")"
  case "$v" in
    *"$3"*) pass "$1 — caught ($3)" ;;
    *) fail "$1 — the guard did NOT catch it (wanted $3, got: ${v:-<nothing>})" ;;
  esac
}

mutate_and_expect "a blocked row losing its ticket" \
  's/^windows   blocked   WARP-[0-9]*/windows   blocked   -/' \
  'blocked-without-ticket'

mutate_and_expect "a blocked row losing its reason" \
  's/^\(android   blocked   WARP-[0-9]*\).*/\1/' \
  'blocked-without-note'

mutate_and_expect "a row naming a platform the generator does not know" \
  's/^macos     absent/solaris   absent/' \
  'unknown-platform'

mutate_and_expect "a platform losing its row entirely" \
  '/^linux  */d' \
  'undeclared-platform'

mutate_and_expect "a placeholder sneaking into a row" \
  's/^ios       blocked   \(WARP-[0-9]*\).*/ios       blocked   \1   see https:\/\/testflight.apple.com\/join\/REPLACE-ME/' \
  'placeholder-in-row'

mutate_and_expect "a typo'd policy" \
  's/^windows   blocked/windows   blocke/' \
  'unknown-policy'

# -----------------------------------------------------------------------------
echo ""
echo "  -- Phase 5: the report's column contract --------"
# -----------------------------------------------------------------------------
# droplet-watchdog.sh reads column 1 (label) and column 2 (platform) with awk.
# If the report is ever reformatted, those checks must break HERE, loudly,
# rather than silently reading the wrong field on a box.
R="$WORK/columns"; mkdir -p "$R"
printf 'windows blocked WARP-1 a reason\nandroid installer WARP-2 must ship\n' > "$R/EXPECTED"
run_audit "$R"
col_ok=1
printf '%s\n' "$OUT" | awk '$1 == "BLOCKED" && $2 == "windows" { f = 1 } END { exit !f }' || col_ok=0
printf '%s\n' "$OUT" | awk '$1 == "MISSING" && $2 == "android" { f = 1 } END { exit !f }' || col_ok=0
if [ "$col_ok" = 1 ]; then
  pass "column 1 is the label and column 2 is the platform (the awk contract)"
else
  fail "the column contract droplet-watchdog.sh depends on is broken"
  printf '%s\n' "$OUT" | sed 's/^/      | /'
fi

# Every non-blank row must open with one of the known labels. A label that
# grew a space would split across awk's $1/$2 and silently shift every field
# the watchdog reads, so an unknown leading token is a failure here.
stray="$(printf '%s\n' "$OUT" | awk 'NF && $1 !~ /^(OK|MISSING|STALE|BLOCKED|UNVERIFIABLE|audit:)$/ { print }')"
if [ -z "$stray" ]; then
  pass "every report row opens with a known single-token label"
else
  fail "report rows with an unrecognised leading token:"
  printf '%s\n' "$stray" | sed 's/^/      | /'
fi

# ...and prove that assertion can actually fail, so it is not decoration.
if printf 'WEIRD LABEL windows oops\n' \
   | awk 'NF && $1 !~ /^(OK|MISSING|STALE|BLOCKED|UNVERIFIABLE|audit:)$/ { print }' \
   | grep -q WEIRD; then
  pass "the label guard rejects an unknown leading token (mutation)"
else
  fail "the label guard accepts anything — it cannot fail"
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
