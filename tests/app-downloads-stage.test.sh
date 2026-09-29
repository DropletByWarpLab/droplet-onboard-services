#!/usr/bin/env bash
# =============================================================================
# Unit tests for scripts/app-downloads/stage.mjs (+ the stage.sh guard rails).
#
# The staging half of the /downloads surface. WARP-2046 shipped the serving
# half — catalog parser, digest gate, the page — but nothing that ever PUTS an
# installer in the staging root, so every box has reported "no apps are staged"
# since it merged. These tests cover the script that closes that, and in
# particular the one failure that is silent rather than loud:
#
#   gen-catalog's pickPrimary() takes the first `-setup.exe` in SORTED order.
#   Leave last release's installer in place and `primary` becomes the OLDER
#   build — the download button hands out a stale app, with a catalog that
#   parses and a digest that verifies. Test 5 proves the default clears it and
#   test 6 proves the hazard is real by reproducing it under --keep-existing.
#
# Hermetic: fake multi-byte "installers", no Docker, no network, no real
# 220 MB artifact. Runtime: < 5 seconds. Requires: bash, node.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGE_MJS="$REPO_ROOT_REAL/scripts/app-downloads/stage.mjs"
STAGE_SH="$REPO_ROOT_REAL/scripts/app-downloads/stage.sh"
GEN="$REPO_ROOT_REAL/scripts/app-downloads/gen-catalog.mjs"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  app-downloads — stage.mjs"
echo "  ================================================"
echo ""

for f in "$STAGE_MJS" "$STAGE_SH" "$GEN"; do
  if [ -f "$f" ]; then pass "exists: ${f#"$REPO_ROOT_REAL"/}"
  else fail "missing: ${f#"$REPO_ROOT_REAL"/}"; echo "FAILURES=$FAILURES"; exit 1; fi
done

command -v node >/dev/null 2>&1 || { fail "node is required"; echo "FAILURES=$FAILURES"; exit 1; }

WORK="$(mktemp -d)"
SRC="$WORK/src"
mkdir -p "$SRC"
trap 'rm -rf "$WORK"' EXIT

# Fake installers. Content differs per version so the digests differ too —
# identical bytes would let a swapped-file bug pass unnoticed.
printf 'MZ fake droplet installer 9.8.0' > "$SRC/Droplet_9.8.0_x64-setup.exe"
printf 'MZ fake droplet installer 9.9.9 payload' > "$SRC/Droplet_9.9.9_x64-setup.exe"
printf 'signature envelope' > "$SRC/Droplet_9.9.9_x64-setup.exe.sig"

# Read one field out of a staged catalog.
field() { # <root> <js expression over `c`>
  node -e "
    const c = JSON.parse(require('fs').readFileSync(process.argv[1] + '/catalog.json','utf8'));
    const w = c.platforms.find(p => p.platform === 'windows') || {};
    process.stdout.write(String($2));
  " "$1"
}

stage() { # <root> <args...>
  local root="$1"; shift
  node "$STAGE_MJS" --dir "$root" "$@" >"$WORK/out.txt" 2>"$WORK/err.txt"
}

# --- 1. dry run changes nothing ---------------------------------------------
R="$WORK/dry"; mkdir -p "$R"
if stage "$R" --dry-run "$SRC/Droplet_9.9.9_x64-setup.exe" \
   && [ ! -e "$R/catalog.json" ] && [ ! -e "$R/windows" ]; then
  pass "--dry-run stages nothing"
else
  fail "--dry-run wrote to the staging root"; cat "$WORK/err.txt"
fi

if grep -q "9.9.9" "$WORK/out.txt" && grep -q "windows" "$WORK/out.txt"; then
  pass "--dry-run reports the inferred platform + version"
else
  fail "--dry-run did not report what it would do"
fi

# --- 2. a real stage ---------------------------------------------------------
R="$WORK/one"; mkdir -p "$R"
if stage "$R" "$SRC/Droplet_9.9.9_x64-setup.exe"; then
  pass "stages an installer"
else
  fail "staging failed"; cat "$WORK/err.txt"
fi

[ -f "$R/windows/Droplet_9.9.9_x64-setup.exe" ] \
  && pass "installer copied into windows/" || fail "installer not copied"
[ -f "$R/catalog.json" ] && pass "catalog.json generated" || fail "no catalog.json"
[ -f "$R/platforms.json" ] && pass "platforms.json written" || fail "no platforms.json"

# No half-written temp file may survive: gen-catalog would hash it and declare
# a `.staging` file an asset.
if ls "$R/windows"/*.staging >/dev/null 2>&1; then
  fail "a .staging temp file was left behind"
else
  pass "no .staging temp file left behind"
fi

[ "$(field "$R" 'w.version')" = "9.9.9" ] \
  && pass "version inferred from the filename" || fail "version not inferred"
[ "$(field "$R" 'w.primary')" = "Droplet_9.9.9_x64-setup.exe" ] \
  && pass "primary is the staged installer" || fail "primary is wrong"

if node "$GEN" --dir "$R" --check >/dev/null 2>&1; then
  pass "gen-catalog --check passes on the staged tree"
else
  fail "the catalog it wrote is already stale"
fi

# --- 3. metadata flags -------------------------------------------------------
R="$WORK/meta"; mkdir -p "$R"
stage "$R" --version 1.2.3 --min-os "Windows 10 (1809) or newer" \
      --note "hello" "$SRC/Droplet_9.9.9_x64-setup.exe"
[ "$(field "$R" 'w.version')" = "1.2.3" ] \
  && pass "--version overrides the filename" || fail "--version ignored"
[ "$(field "$R" 'w.minOsVersion')" = "Windows 10 (1809) or newer" ] \
  && pass "--min-os reaches the catalog" || fail "--min-os lost"
[ "$(field "$R" 'w.note')" = "hello" ] \
  && pass "--note reaches the catalog" || fail "--note lost"

# --- 4. platforms.json is merged, not overwritten ----------------------------
R="$WORK/merge"; mkdir -p "$R"
cat > "$R/platforms.json" <<'JSON'
{
  "android": {
    "version": "1.0.0",
    "storeUrl": "https://play.google.com/store/apps/details?id=ai.warplab.droplet"
  }
}
JSON
stage "$R" "$SRC/Droplet_9.9.9_x64-setup.exe"
if grep -q "play.google.com" "$R/platforms.json"; then
  pass "staging windows keeps the android entry"
else
  fail "staging windows clobbered platforms.json"
fi

# --- 5. THE TRAP: a stale installer must not survive a re-stage --------------
R="$WORK/restage"; mkdir -p "$R"
stage "$R" "$SRC/Droplet_9.8.0_x64-setup.exe"
[ "$(field "$R" 'w.primary')" = "Droplet_9.8.0_x64-setup.exe" ] \
  && pass "setup: 9.8.0 staged first" || fail "setup stage failed"

stage "$R" "$SRC/Droplet_9.9.9_x64-setup.exe"
if [ -e "$R/windows/Droplet_9.8.0_x64-setup.exe" ]; then
  fail "the old installer survived the re-stage"
else
  pass "re-staging removes the previous installer"
fi
[ "$(field "$R" 'w.primary')" = "Droplet_9.9.9_x64-setup.exe" ] \
  && pass "primary follows the new build" || fail "primary still points at the old build"
[ "$(field "$R" 'w.version')" = "9.9.9" ] \
  && pass "version follows the new build" || fail "version not updated"

# --- 6. the same tree WITHOUT the clear — proves the hazard is real ----------
# If this ever stops reproducing, the default in test 5 has stopped being
# load-bearing and this whole guard should be re-thought rather than deleted.
R="$WORK/keep"; mkdir -p "$R"
stage "$R" "$SRC/Droplet_9.8.0_x64-setup.exe"
stage "$R" --keep-existing "$SRC/Droplet_9.9.9_x64-setup.exe"
if [ -e "$R/windows/Droplet_9.8.0_x64-setup.exe" ] && [ -e "$R/windows/Droplet_9.9.9_x64-setup.exe" ]; then
  pass "--keep-existing keeps both installers"
else
  fail "--keep-existing removed something"
fi
if [ "$(field "$R" 'w.primary')" = "Droplet_9.8.0_x64-setup.exe" ]; then
  pass "hazard reproduced: with both staged, primary is the OLDER build"
else
  fail "expected the older build to win as primary under --keep-existing"
fi

# --- 7. a signature rides along ---------------------------------------------
R="$WORK/sig"; mkdir -p "$R"
stage "$R" "$SRC/Droplet_9.9.9_x64-setup.exe" "$SRC/Droplet_9.9.9_x64-setup.exe.sig"
if [ "$(field "$R" "w.assets.filter(a => a.kind === 'signature').length")" = "1" ]; then
  pass "a .sig staged alongside is declared as a signature"
else
  fail "the .sig did not land as a signature asset"
fi
[ "$(field "$R" 'w.primary')" = "Droplet_9.9.9_x64-setup.exe" ] \
  && pass "the .sig did not become primary" || fail "primary is not the installer"

# --- 8. refusals -------------------------------------------------------------
R="$WORK/bad"; mkdir -p "$R"
cp "$SRC/Droplet_9.9.9_x64-setup.exe" "$WORK/src/Droplet 9.9.9 setup.exe"
if stage "$R" "$WORK/src/Droplet 9.9.9 setup.exe"; then
  fail "accepted a filename the catalog parser would reject"
else
  pass "refuses a filename the catalog parser would reject"
fi

printf 'not an installer' > "$SRC/notes.txt"
if stage "$R" "$SRC/notes.txt"; then
  fail "accepted a file with no platform"
else
  pass "refuses a file whose platform cannot be inferred"
fi

if stage "$R" "$SRC/missing-file.exe"; then
  fail "accepted a path that does not exist"
else
  pass "refuses a path that does not exist"
fi

printf 'apk' > "$SRC/Droplet_9.9.9.apk"
if stage "$R" "$SRC/Droplet_9.9.9_x64-setup.exe" "$SRC/Droplet_9.9.9.apk"; then
  fail "accepted two platforms in one call"
else
  pass "refuses two platforms in one call"
fi

# --- 9. stage.sh guard rails -------------------------------------------------
if bash "$STAGE_SH" --dir /tmp/somewhere foo.exe >/dev/null 2>&1; then
  fail "stage.sh accepted --dir (would stage outside the compose bind mount)"
else
  pass "stage.sh refuses --dir"
fi

if bash -n "$STAGE_SH" 2>/dev/null; then
  pass "stage.sh parses"
else
  fail "stage.sh has a syntax error"
fi

# The restart is not optional bookkeeping: store.ts memoises the catalog for
# the life of the process, so a stage without it is invisible at /downloads.
# Match the ACTUAL command, not the word. A bare `grep -q "restart"` matched
# RESTART=1, --no-restart, "restarting", and this comment block itself — so
# deleting the real `docker restart "$CID"` left the guard green. A guard that
# cannot fail is worse than no guard, because it is credited as coverage.
if grep -q 'docker restart' "$STAGE_SH"; then
  pass "stage.sh restarts the orchestrator (docker restart)"
else
  fail "stage.sh no longer runs 'docker restart' — staging would be invisible"
fi

# Prove that guard can fail: the same grep against a copy with the call removed
# must NOT match. Without this, the fix above is unverified in exactly the way
# the original was.
_no_restart="$WORK/stage-sh-without-restart"
grep -v 'docker restart' "$STAGE_SH" > "$_no_restart"
if grep -q 'docker restart' "$_no_restart"; then
  fail "the restart guard still matches after the call was removed — it cannot fail"
else
  pass "the restart guard goes red when 'docker restart' is removed (mutation)"
fi

# -----------------------------------------------------------------------------
# Copy honesty (WARP-2666)
# -----------------------------------------------------------------------------
# Three tracked files used to assert that the image build stages installers
# into data/app-downloads. It never did — and that claim is precisely why the
# gap survived a full build-out, because anyone opening .gitignore or the
# README to ask "why is this empty" was told the answer was somewhere else.
#
# The claim has already regrown once, INSIDE the commit written to remove it,
# so this is a grep rather than a code review note. page.test.tsx uses the same
# technique on the customer-facing string.
BANNED='baked into the appliance image|[Tt]he image build stages them|image is the trust root|next box update will bring'
HONESTY_TARGETS=(
  "$REPO_ROOT_REAL/data/app-downloads/.gitignore"
  "$REPO_ROOT_REAL/data/app-downloads/README.md"
  "$REPO_ROOT_REAL/docker/docker-compose.yml"
  "$REPO_ROOT_REAL/apps/web-dashboard/src/app/downloads/page.tsx"
)
honesty_hits=0
for f in "${HONESTY_TARGETS[@]}"; do
  [ -f "$f" ] || continue
  if grep -Eqn "$BANNED" "$f"; then
    fail "false provenance claim in ${f#"$REPO_ROOT_REAL"/}:"
    grep -Ein "$BANNED" "$f" | sed 's/^/      | /'
    honesty_hits=$((honesty_hits + 1))
  fi
done
if [ "$honesty_hits" -eq 0 ]; then
  pass "no tracked file claims installers are baked into the appliance image"
fi

# Prove the grep can fail — otherwise a typo'd pattern reads as clean forever.
_mutant="$WORK/honesty-mutant"
printf 'Installers are BINARIES baked into the appliance image at build time.\n' > "$_mutant"
if grep -Eq "$BANNED" "$_mutant"; then
  pass "the copy-honesty grep catches the claim when it is reintroduced (mutation)"
else
  fail "the copy-honesty grep does not match the claim it exists to catch"
fi

# --- WARP-3174: stage-lock.sh (the image build's lock staging) ---------------
# A fake `gh` plays `gh release download` (copies $FAKE_ASSET to <dir>/<pattern>)
# and `gh auth token` (prints $FAKE_GH_AUTH), so the real fetch-client-apps.py
# and stage.mjs both run. Every call is logged, to prove an empty lock makes none.
STAGE_LOCK="$REPO_ROOT_REAL/scripts/app-downloads/stage-lock.sh"
if command -v python3 >/dev/null 2>&1 && [ -f "$STAGE_LOCK" ]; then
  LK="$WORK/lock"; mkdir -p "$LK/bin"
  cat > "$LK/bin/gh" <<'GH'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = auth ]; then printf '%s' "$FAKE_GH_AUTH"; exit 0; fi
while [ $# -gt 0 ]; do
  case "$1" in -p) pat="$2"; shift 2 ;; -D) dir="$2"; shift 2 ;; *) shift ;; esac
done
cp "$FAKE_ASSET" "$dir/$pat"
GH
  chmod +x "$LK/bin/gh"
  printf 'a notarized dmg, honestly' > "$LK/asset"
  sha="$(node -e "process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))" "$LK/asset")"
  size="$(wc -c < "$LK/asset" | tr -d ' ')"
  write_lock() { # <file> <clients json>
    printf '{"schemaVersion":1,"clients":%s}\n' "$2" > "$1"
  }
  mac_entry() { # <sha256>
    printf '[{"platform":"macos","version":"0.2.0","source":{"repo":"DropletByWarpLab/DropletAgent","tag":"mac-v0.2.0"},"file":"Droplet-0.2.0.dmg","size":%s,"sha256":"%s"}]' "$size" "$1"
  }
  run_lock() { # <lock> <root> [GH_TOKEN] [auth token]
    rm -f "$LK/gh.log"
    PATH="$LK/bin:$PATH" GH_TOKEN="${3-}" DROPLET_CLIENT_APPS_TOKEN="" FAKE_GH_AUTH="${4-}" \
      FAKE_ASSET="$LK/asset" FAKE_GH_LOG="$LK/gh.log" \
      bash "$STAGE_LOCK" --lock "$1" --dir "$2" >"$WORK/out.txt" 2>"$WORK/err.txt"
  }

  write_lock "$LK/empty.json" '[]'
  R="$WORK/lock-empty"; mkdir -p "$R"
  if run_lock "$LK/empty.json" "$R" && [ ! -e "$R/catalog.json" ] && [ ! -e "$LK/gh.log" ]; then
    pass "stage-lock: an empty lock stages nothing and calls no gh (no token needed)"
  else
    fail "stage-lock: an empty lock did something"; cat "$WORK/err.txt"
  fi

  write_lock "$LK/mac.json" "$(mac_entry "$sha")"
  R="$WORK/lock-mac"; mkdir -p "$R"
  if run_lock "$LK/mac.json" "$R" "t0ken" \
     && [ -f "$R/macos/Droplet-0.2.0.dmg" ] \
     && [ "$(node -e "const c=require(process.argv[1]);const m=c.platforms.find(p=>p.platform==='macos');process.stdout.write(m.version+' '+m.primary+' '+m.assets[0].sha256)" "$R/catalog.json")" = "0.2.0 Droplet-0.2.0.dmg $sha" ]; then
    pass "stage-lock: a pinned macos entry is fetched, verified and staged into the catalog"
  else
    fail "stage-lock: a pinned macos entry was not staged"; cat "$WORK/err.txt"
  fi

  R="$WORK/lock-auth"; mkdir -p "$R"
  if run_lock "$LK/mac.json" "$R" "" "builder-token" && [ -f "$R/macos/Droplet-0.2.0.dmg" ] \
     && grep -q '^auth token' "$LK/gh.log"; then
    pass "stage-lock: with no GH_TOKEN it falls back to the builder's gh auth token"
  else
    fail "stage-lock: no fallback to gh auth token"; cat "$WORK/err.txt"
  fi

  R="$WORK/lock-notoken"; mkdir -p "$R"
  if ! run_lock "$LK/mac.json" "$R" "" "" && [ ! -e "$R/catalog.json" ] \
     && grep -q 'DROPLET_CLIENT_APPS_TOKEN' "$WORK/err.txt"; then
    pass "stage-lock: a pinned entry with no token fails closed, with the reason"
  else
    fail "stage-lock: a pinned entry with no token did not fail closed"; cat "$WORK/err.txt"
  fi

  write_lock "$LK/bad.json" "$(mac_entry "$(printf '0%.0s' $(seq 64))")"
  R="$WORK/lock-bad"; mkdir -p "$R"
  if ! run_lock "$LK/bad.json" "$R" "t0ken" && [ ! -e "$R/catalog.json" ] && [ ! -e "$R/macos" ] \
     && grep -q 'sha256' "$WORK/err.txt"; then
    pass "stage-lock: a sha256 mismatch fails and stages nothing"
  else
    fail "stage-lock: a sha256 mismatch was staged"; cat "$WORK/err.txt"
  fi

  write_lock "$LK/broken.json" '"nope"'
  if ! run_lock "$LK/broken.json" "$WORK/lock-broken" "t0ken" && [ ! -e "$LK/gh.log" ]; then
    pass "stage-lock: a malformed lock fails before any download"
  else
    fail "stage-lock: a malformed lock was accepted"
  fi
else
  fail "stage-lock: python3 and scripts/app-downloads/stage-lock.sh are required"
fi

# The wiring: build-iso must stage the lock, audit the root the image carries
# (not the checkout, which never reaches a box), and put that root in the ISO;
# the autoinstall must copy it into the clone. Text checks: build-iso itself
# only runs on a Linux host with docker and a 3 GB download.
BUILD_ISO="$REPO_ROOT_REAL/scripts/image/build-iso.sh"
USER_DATA="$REPO_ROOT_REAL/scripts/image/autoinstall/user-data"
lock_line="$(grep -n 'stage-lock.sh' "$BUILD_ISO" | head -1 | cut -d: -f1)"
audit_line="$(grep -n 'bash "\$AUDIT_SH" --dir' "$BUILD_ISO" | head -1 | cut -d: -f1)"
if [ -n "$lock_line" ] && [ -n "$audit_line" ] && [ "$lock_line" -lt "$audit_line" ]; then
  pass "build-iso stages the lock before its pre-flight audit"
else
  fail "build-iso does not stage clients.lock.json before the audit"
fi
if grep -q 'bash "\$AUDIT_SH" --dir "\$APP_DOWNLOADS_ROOT"' "$BUILD_ISO" \
   && grep -q -- '-map /app-downloads /server/app-downloads' "$BUILD_ISO" \
   && grep -q '"\${APP_DOWNLOADS_ROOT}:/app-downloads:ro"' "$BUILD_ISO"; then
  pass "build-iso audits the staging root it maps into the ISO"
else
  fail "build-iso audits one root and ships another (or ships none)"
fi
if grep -q 'cp -rn /cdrom/server/app-downloads/. /target/home/droplet/edge-platform/data/app-downloads/' "$USER_DATA"; then
  pass "the autoinstall copies the ISO's staging root into the clone"
else
  fail "the autoinstall never copies the ISO's installers into the clone"
fi

echo ""
echo "  ------------------------------------------------"
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mAll %d checks passed\033[0m\n\n" "$TESTS"
  exit 0
fi
printf "  \033[31m%d of %d checks FAILED\033[0m\n\n" "$FAILURES" "$TESTS"
exit 1
