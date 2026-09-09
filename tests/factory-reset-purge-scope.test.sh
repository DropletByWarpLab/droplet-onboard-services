#!/usr/bin/env bash
# =============================================================================
# Regression guard — factory-reset.sh --purge-images must stay SCOPED.
#
# PR #540 added a post-`down` reclaim step. Its --purge-images branch
# originally ran a daemon-wide `docker system prune -af`. The `-a` flag removes
# EVERY image without a running container across the whole Docker daemon — and
# at factory-reset time every container has just been stopped. On the
# single-box inference host this project (droplet-onboard-services) deploys
# side-by-side with the sibling droplet-local-LLM / Ollama images; those are
# tagged but have no running container at reset time, so `-a` would delete
# them. After reset + reinstall, setup.sh only rebuilds THIS project's images,
# leaving AI inference broken until the models are re-pulled.
#
# The fix scopes the reclaim to its stated intent: build cache + dangling
# (untagged) images + unused networks — never a daemon-wide `-a` image sweep.
#
# This is a STATIC source-assertion test (the same idiom as
# tests/openwrt-attach-firewall.test.sh's Phase 1): it greps the executable
# lines of factory-reset.sh. It does NOT run Docker or factory-reset.sh — the
# live reset→provision→login path is covered by tests/factory-reset.test.sh.
#
# Runtime: < 1 second.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESET="$REPO_ROOT/scripts/factory-reset.sh"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  factory-reset.sh --purge-images scope guard"
echo "  ================================================"
echo ""

# --- Preconditions -----------------------------------------------------------
if [ -f "$RESET" ]; then
  pass "factory-reset.sh exists"
else
  fail "factory-reset.sh missing at $RESET"
  echo "FAILURES=$FAILURES"; exit 1
fi

# Strip comments + blank lines so assertions see only executable shell. The
# fix INTENTIONALLY mentions `docker system prune -af` in a comment (to explain
# why it is NOT used), so a naive whole-file grep would be a false positive.
# Lines whose first non-space char is `#` are comments.
CODE="$(grep -vE '^[[:space:]]*#' "$RESET" | grep -vE '^[[:space:]]*$')"

# --- The regression: no daemon-wide `-a` image removal -----------------------
echo "--- No daemon-wide image sweep in the executable path ---"

# `docker system prune` with -a (in any flag grouping: -af, -a, -fa, --all)
# removes all unused images daemon-wide. It must not appear in executable code.
if grep -qE 'docker[[:space:]]+system[[:space:]]+prune' <<<"$CODE"; then
  fail "executable code runs 'docker system prune' (daemon-wide) — would sweep sibling Ollama images"
else
  pass "no 'docker system prune' in executable code"
fi

# Defense in depth: catch a plain `docker image prune -a` / `-af` too — that is
# also a daemon-wide all-unused-images sweep (only dangling, i.e. `-f` without
# `-a`, is in-scope for a reset).
if grep -qE 'docker[[:space:]]+image[[:space:]]+prune[[:space:]]+(-[a-z]*a[a-z]*|--all)\b' <<<"$CODE"; then
  fail "executable code runs 'docker image prune -a' (all unused, not just dangling) — would sweep sibling images"
else
  pass "no all-unused 'docker image prune -a' in executable code"
fi

# --- The stated intent is still accomplished ---------------------------------
echo "--- Scoped reclaim still does its job ---"

# Build cache (the original always-on reclaim — the whole point of the PR).
if grep -qE 'docker[[:space:]]+builder[[:space:]]+prune' <<<"$CODE"; then
  pass "build cache is reclaimed (docker builder prune)"
else
  fail "build cache reclaim (docker builder prune) is gone — the PR's core behavior"
fi

# Dangling (untagged) images — `-f` WITHOUT `-a`. Required by the --purge-images
# intent ("dangling images go too") while leaving tagged sibling images intact.
if grep -qE 'docker[[:space:]]+image[[:space:]]+prune[[:space:]]+-f\b' <<<"$CODE"; then
  pass "dangling images are reclaimed (docker image prune -f, no -a)"
else
  fail "dangling-image reclaim (docker image prune -f) missing from --purge-images path"
fi

# Unused networks — the other half of the stated --purge-images intent.
if grep -qE 'docker[[:space:]]+network[[:space:]]+prune' <<<"$CODE"; then
  pass "unused networks are reclaimed (docker network prune)"
else
  fail "unused-network reclaim (docker network prune) missing from --purge-images path"
fi

# Named volumes stay Phase 2's job — the reclaim must NOT pass --volumes.
if grep -qE 'prune[^|]*--volumes' <<<"$CODE"; then
  fail "a prune step passes --volumes — named volumes are Phase 2's job, not this reclaim"
else
  pass "no --volumes on the reclaim (named volumes left to Phase 2)"
fi

# =============================================================================
# Results
# =============================================================================
echo ""
echo "  ================================================"
printf "  Results: %d/%d passed" "$((TESTS - FAILURES))" "$TESTS"
if [ "$FAILURES" -gt 0 ]; then
  printf " (\033[31m%d failed\033[0m)" "$FAILURES"
fi
printf "\n"
echo "  ================================================"
echo ""

exit "$FAILURES"
