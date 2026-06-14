#!/usr/bin/env bash
# =============================================================================
# unit tests for pool_destroy member-superblock wiping inside
# scripts/host/droplet-storage-pool.sh.
#
# Bug (data lifecycle): pool_destroy ran `mdadm --stop "$MD"` and THEN iterated
# /sys/block/$DEVICE/slaves/* to zero each member's md superblock. But --stop
# tears down the md device and removes /sys/block/<md> — so by the time the
# slaves glob runs it matches NOTHING, no superblock is zeroed, and the
# "destroyed" array re-assembles on the next boot.
#
# The fix: enumerate the member devices from /sys/block/$DEVICE/slaves/* into a
# list BEFORE --stop, then stop the array, then `mdadm --zero-superblock` each
# captured member (keeping the `|| true` tolerance).
#
# These tests do NOT require Docker, real mdadm, or a real md array. The
# pool_destroy execution block is delimited by sentinel markers; we extract it
# and run it against a fake /sys/block tree + a stub `mdadm` whose `--stop`
# REMOVES the slaves dir (exactly the kernel behavior that caused the bug) and
# whose `--zero-superblock` records which member it was asked to wipe. We then
# assert every member's superblock was zeroed. Mirrors
# tests/openwrt-attach-iface-detect.test.sh.
#
# Runtime: < 5 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
POOL="$REPO_ROOT_REAL/scripts/host/droplet-storage-pool.sh"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  droplet-storage-pool — pool_destroy superblock wipe"
echo "  ================================================"
echo ""

# --- Static structure --------------------------------------------------------
echo "--- Phase 1: capture-before-stop ordering ---"

if [ -f "$POOL" ]; then
  pass "storage-pool script exists"
else
  fail "storage-pool script missing at $POOL"
  echo "FAILURES=$FAILURES"; exit 1
fi

START_MARK="# >>> pool_destroy member wipe"
END_MARK="# <<< pool_destroy member wipe"

if grep -qF "$START_MARK" "$POOL" && grep -qF "$END_MARK" "$POOL"; then
  pass "pool_destroy sentinel markers present"
else
  fail "pool_destroy sentinel markers ('$START_MARK' .. '$END_MARK') missing"
fi

# Extract the delimited block and assert the member enumeration (the slaves
# glob) appears BEFORE `mdadm --stop`. If the order regresses, the slaves dir
# is gone by the time we read it and no superblock is wiped.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

sed -n "/$(printf '%s' "$START_MARK" | sed 's/[][\\.*^$/]/\\&/g')/,/$(printf '%s' "$END_MARK" | sed 's/[][\\.*^$/]/\\&/g')/p" \
  "$POOL" > "$WORK/block.sh"

if [ -s "$WORK/block.sh" ]; then
  pass "extracted pool_destroy block"
else
  fail "could not extract pool_destroy block — skipping ordering/behavioral asserts"
  echo ""; echo "  $((TESTS - FAILURES))/$TESTS passed"; echo "FAILURES=$FAILURES"
  [ "$FAILURES" -eq 0 ] || exit 1
  exit 0
fi

glob_line="$(grep -n '/slaves/' "$WORK/block.sh" | head -1 | cut -d: -f1)"
stop_line="$(grep -n 'mdadm --stop' "$WORK/block.sh" | head -1 | cut -d: -f1)"
if [ -n "$glob_line" ] && [ -n "$stop_line" ] && [ "$glob_line" -lt "$stop_line" ]; then
  pass "members enumerated (slaves glob) BEFORE 'mdadm --stop'"
else
  fail "slaves glob (line ${glob_line:-?}) must come before 'mdadm --stop' (line ${stop_line:-?})"
fi

# --- Behavioral: run the block against a fake sysfs + stub mdadm -------------
echo "--- Phase 2: behavioral run with fake /sys/block + stub mdadm ---"

# Stub `mdadm`: --stop deletes the slaves dir (mimics the kernel removing
# /sys/block/<md>); --zero-superblock appends the target it was asked to wipe.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/mdadm" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  --stop)            rm -rf "$SLAVES_DIR" ;;
  --zero-superblock) printf '%s\n' "$2" >> "$ZEROED_LOG" ;;
esac
exit 0
EOF
chmod +x "$WORK/bin/mdadm"

# Fake /sys/block/md0/slaves/{sda,sdb} — the two array members.
SYSBLK="$WORK/sys/block"
mkdir -p "$SYSBLK/md0/slaves/sda" "$SYSBLK/md0/slaves/sdb"

ZEROED_LOG="$WORK/zeroed.log"
: > "$ZEROED_LOG"

# The block reads the literal /sys/block/$DEVICE/slaves/* path; rewrite that
# root to our fixture so we can exercise the real capture→stop→zero flow without
# touching the host's /sys. We assert the BEHAVIOR, not the literal string.
sed "s#/sys/block/#$SYSBLK/#g" "$WORK/block.sh" > "$WORK/block.run.sh"

PATH="$WORK/bin:$PATH" \
SLAVES_DIR="$SYSBLK/md0/slaves" \
ZEROED_LOG="$ZEROED_LOG" \
DEVICE="md0" MD="/dev/md0" \
bash -c "set -e; . '$WORK/block.run.sh'" >/dev/null 2>&1 || true

zeroed_count="$(wc -l < "$ZEROED_LOG" | tr -d ' ')"
if [ "$zeroed_count" -eq 2 ]; then
  pass "both members had their superblock zeroed after --stop (captured beforehand)"
else
  fail "expected 2 members zeroed, got $zeroed_count (slaves glob ran after --stop?)"
fi

if grep -qx "/dev/sda" "$ZEROED_LOG" && grep -qx "/dev/sdb" "$ZEROED_LOG"; then
  pass "the correct member nodes (/dev/sda, /dev/sdb) were zeroed"
else
  fail "expected /dev/sda and /dev/sdb in zeroed log, got: $(tr '\n' ' ' < "$ZEROED_LOG")"
fi

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
if [ "$FAILURES" -ne 0 ]; then
  echo "  RESULT: FAIL ($FAILURES failing)"
  exit 1
fi
echo "  RESULT: PASS"
