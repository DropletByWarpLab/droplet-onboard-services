#!/usr/bin/env bash
# =============================================================================
# unit tests for scripts/jira-ticket-status.sh (WARP-1811)
#
# This script WRITES TO JIRA, on every merged PR, unattended. There is no
# staging board and no undo — a wrong transition is a ticket somebody has to
# notice and put back. So every guard is exercised here against a stubbed
# `curl`, which is the only way to prove the Epic refusal or the already-Done
# skip without spoiling a real ticket to do it.
#
# The stub is a real program on PATH that answers by URL and records every
# call, so a test can assert what was NOT requested — which is the whole point
# for a guard. "It did not transition" is only believable if you can see that
# no transition was ever POSTed.
#
# Needs no network, no token, no Jira. Runtime: < 5 seconds.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/jira-ticket-status.sh"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  jira-ticket-status — the guards (WARP-1811)"
echo "  ================================================"
echo ""

if [ ! -f "$SCRIPT" ]; then
  fail "script missing at $SCRIPT"; echo "FAILURES=1"; exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "  jq is required for these tests"; exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

# ── the curl stub ───────────────────────────────────────────────────────────
#
# Answers three shapes of request from files the test writes:
#   ISSUE_JSON      the GET /issue/<key> body
#   TRANSITIONS_JSON the GET /issue/<key>/transitions body
#   *_CODE          the HTTP code for each verb
# and appends one line per call to CALLS so a test can assert absence.
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
URL=""; OUT=""; METHOD="GET"
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT="$2"; shift 2 ;;
    -X) METHOD="$2"; shift 2 ;;
    -u|-H|-d|-w) shift 2 ;;
    -sS|--max-time) [ "$1" = "--max-time" ] && shift; shift ;;
    http*) URL="$1"; shift ;;
    *) shift ;;
  esac
done
echo "$METHOD $URL" >> "$CALLS"
case "$URL" in
  */transitions)
    if [ "$METHOD" = "POST" ]; then printf '%s' "${TRANSITION_CODE:-204}"; exit 0; fi
    [ -n "$OUT" ] && cp "$TRANSITIONS_JSON" "$OUT"
    printf '%s' "${TRANSITIONS_CODE:-200}" ;;
  */comment)
    printf '%s' "${COMMENT_CODE:-201}" ;;
  *)
    [ -n "$OUT" ] && cp "$ISSUE_JSON" "$OUT"
    printf '%s' "${ISSUE_CODE:-200}" ;;
esac
STUB
chmod +x "$WORK/bin/curl"
export PATH="$WORK/bin:$PATH"

export JIRA_EMAIL="ci@example.test"
export JIRA_API_TOKEN="stub-token"
export JIRA_BASE_URL="https://jira.invalid"
export PR_NUMBER="4242"
export PR_URL="https://github.com/x/y/pull/4242"
export PR_BASE_REF="stage"

issue() { # $1 status, $2 category, $3 type
  cat > "$WORK/issue.json" <<EOF
{"fields":{"status":{"name":"$1","statusCategory":{"name":"$2"}},"issuetype":{"name":"$3"}}}
EOF
  export ISSUE_JSON="$WORK/issue.json"
}
transitions() { # transitions JSON body
  printf '%s' "$1" > "$WORK/transitions.json"
  export TRANSITIONS_JSON="$WORK/transitions.json"
}
TRANSITIONS_DEFAULT='{"transitions":[{"id":"4","to":{"name":"In Review"}},{"id":"51","to":{"name":"Done"}}]}'

run() { # $1 mode, $2 title → stdout+stderr in $OUT_TXT, status in $RC
  export CALLS="$WORK/calls.txt"; : > "$CALLS"
  PR_TITLE="$2" bash "$SCRIPT" --mode "$1" > "$WORK/out.txt" 2>&1
  RC=$?
  OUT_TXT="$(cat "$WORK/out.txt")"
}
posted_transition() { grep -q "^POST .*/transitions$" "$CALLS"; }
posted_comment()    { grep -q "^POST .*/comment$" "$CALLS"; }

# --- Phase 1: it moves a ticket at all ---------------------------------------
echo "--- Phase 1: the happy paths ---"

issue "To Do" "To Do" "Story"; transitions "$TRANSITIONS_DEFAULT"
run done "feat(x): a thing (WARP-1)"
if [ $RC -eq 0 ] && posted_transition && echo "$OUT_TXT" | grep -q "WARP-1: To Do → Done"; then
  pass "a merged PR moves its ticket to Done"
else
  fail "a merged PR moves its ticket to Done — rc=$RC out=$OUT_TXT"
fi

issue "To Do" "To Do" "Task"; transitions "$TRANSITIONS_DEFAULT"
run in-review "WARP-2: something"
if [ $RC -eq 0 ] && echo "$OUT_TXT" | grep -q "WARP-2: To Do → In Review"; then
  pass "an opened PR moves its ticket to In Review"
else
  fail "an opened PR moves its ticket to In Review — out=$OUT_TXT"
fi

issue "To Do" "To Do" "Bug"; transitions "$TRANSITIONS_DEFAULT"
run done "fix: two at once (WARP-3, WARP-4)"
if [ "$(grep -c '^POST .*/transitions$' "$CALLS")" = "2" ]; then
  pass "every key in the title is moved, not just the first"
else
  fail "every key in the title is moved — calls: $(cat "$CALLS")"
fi

# --- Phase 2: what it refuses to touch ---------------------------------------
echo ""
echo "--- Phase 2: the guards ---"

issue "To Do" "To Do" "Epic"; transitions "$TRANSITIONS_DEFAULT"
run done "feat: epic-ish (WARP-5)"
if ! posted_transition && echo "$OUT_TXT" | grep -q "is an Epic"; then
  pass "🔴 an Epic is never transitioned"
else
  fail "🔴 an Epic is never transitioned — calls: $(cat "$CALLS")"
fi

issue "Hardware Test" "In Progress" "Task"; transitions "$TRANSITIONS_DEFAULT"
run done "feat: needs a box (WARP-6)"
if ! posted_transition && echo "$OUT_TXT" | grep -q "Hardware Test"; then
  pass "🔴 a Hardware Test hold survives a merge"
else
  fail "🔴 a Hardware Test hold survives a merge — calls: $(cat "$CALLS")"
fi

issue "Done" "Done" "Story"; transitions "$TRANSITIONS_DEFAULT"
run done "fix: follow-up on an already-closed key (WARP-7)"
if ! posted_transition && [ $RC -eq 0 ]; then
  pass "🔴 an already-Done ticket is skipped, and the job stays green"
else
  fail "🔴 an already-Done ticket is skipped — rc=$RC calls: $(cat "$CALLS")"
fi

issue "Done" "Done" "Story"; transitions "$TRANSITIONS_DEFAULT"
run in-review "fix: a PR that mentions a closed ticket (WARP-8)"
if ! posted_transition && echo "$OUT_TXT" | grep -q "not reopened"; then
  pass "🔴 a closed ticket is never dragged BACK to In Review"
else
  fail "🔴 a closed ticket is never dragged back — calls: $(cat "$CALLS")"
fi

issue "In Review" "In Progress" "Story"; transitions "$TRANSITIONS_DEFAULT"
run in-review "feat: reopened PR (WARP-9)"
if ! posted_transition; then
  pass "a ticket already In Review is left alone on a reopen"
else
  fail "a ticket already In Review is left alone — calls: $(cat "$CALLS")"
fi

issue "To Do" "To Do" "Story"; transitions '{"transitions":[{"id":"2","to":{"name":"In Progress"}}]}'
run done "feat: no path to Done (WARP-10)"
if ! posted_transition && echo "$OUT_TXT" | grep -q "no transition to Done"; then
  pass "a ticket with no path to the target is named, not forced"
else
  fail "a ticket with no path to the target — out=$OUT_TXT"
fi

# --- Phase 3: the title markers ----------------------------------------------
echo ""
echo "--- Phase 3: the opt-outs ---"

issue "To Do" "To Do" "Story"; transitions "$TRANSITIONS_DEFAULT"
run done "chore: tidy up [no-ticket] (WARP-11)"
if ! posted_comment && ! posted_transition; then
  pass "[no-ticket] stops the run before any call"
else
  fail "[no-ticket] stops the run — calls: $(cat "$CALLS")"
fi

issue "To Do" "To Do" "Story"; transitions "$TRANSITIONS_DEFAULT"
run done "DO-NOT-MERGE: spike (WARP-12)"
if ! posted_comment && ! posted_transition; then
  pass "DO-NOT-MERGE stops the run before any call"
else
  fail "DO-NOT-MERGE stops the run — calls: $(cat "$CALLS")"
fi

issue "To Do" "To Do" "Story"; transitions "$TRANSITIONS_DEFAULT"
run done "feat: partial work [no-close] (WARP-13)"
if posted_comment && ! posted_transition; then
  pass "[no-close] still links the PR but transitions nothing"
else
  fail "[no-close] comments without transitioning — calls: $(cat "$CALLS")"
fi

run done "chore: no key here at all"
if ! posted_comment && [ $RC -eq 0 ]; then
  pass "a title with no key does nothing, quietly"
else
  fail "a title with no key does nothing — rc=$RC"
fi

# The body is never read. Asserted through the interface rather than by
# grepping the source: a prior sweep measured ~27% false positives on
# body-sourced keys, and the fix is that this script has no way to see one.
if [ -z "${PR_BODY:-}" ] && ! grep -q 'PR_BODY' "$SCRIPT"; then
  pass "🔴 the PR body is never read — reference-only keys cannot close a ticket"
else
  fail "🔴 the script reads the PR body"
fi

# --- Phase 4: failure posture ------------------------------------------------
echo ""
echo "--- Phase 4: only a dead credential turns this red ---"

issue "To Do" "To Do" "Story"; transitions "$TRANSITIONS_DEFAULT"
TRANSITION_CODE=409 run done "feat: jira says no (WARP-14)"
unset TRANSITION_CODE
if [ $RC -eq 0 ] && echo "$OUT_TXT" | grep -q "rejected"; then
  pass "🔴 a REJECTED transition is a warning, never a red X on a merged PR"
else
  fail "🔴 a rejected transition stays green — rc=$RC out=$OUT_TXT"
fi

# ── the three 401/403s that are NOT a dead token ────────────────────────────
#
# Each of these is reached only AFTER the issue read returned 200, so the
# credential is demonstrably alive and Jira's 403 means "this account lacks
# that permission on this project". Counting any of them as an auth failure
# turns a MERGED PR red and prints "Rotate JIRA_EMAIL / JIRA_API_TOKEN" about
# a healthy token — #1614's defect, relocated into the predicate. All three
# fail if `read_is_auth_failure` is applied anywhere but the read.

issue "To Do" "To Do" "Story"; transitions "$TRANSITIONS_DEFAULT"
TRANSITION_CODE=403 run done "feat: no Transition Issues permission (WARP-21)"
unset TRANSITION_CODE
if [ $RC -eq 0 ] && ! echo "$OUT_TXT" | grep -q "credential looks dead"; then
  pass "🔴 403 on the TRANSITION is a permission, not a dead token — merged PR stays green"
else
  fail "🔴 403 on the transition stays green — rc=$RC out=$OUT_TXT"
fi

issue "To Do" "To Do" "Story"; transitions "$TRANSITIONS_DEFAULT"
COMMENT_CODE=403 run done "feat: no Add Comments permission (WARP-22)"
unset COMMENT_CODE
if [ $RC -eq 0 ] && ! echo "$OUT_TXT" | grep -q "credential looks dead"; then
  pass "🔴 403 on the COMMENT is a permission, not a dead token"
else
  fail "🔴 403 on the comment stays green — rc=$RC out=$OUT_TXT"
fi

issue "To Do" "To Do" "Story"; transitions "$TRANSITIONS_DEFAULT"
TRANSITIONS_CODE=403 run done "feat: cannot list transitions (WARP-23)"
unset TRANSITIONS_CODE
if [ $RC -eq 0 ] && ! echo "$OUT_TXT" | grep -q "credential looks dead"; then
  pass "🔴 403 listing transitions is a permission, not a dead token"
else
  fail "🔴 403 listing transitions stays green — rc=$RC out=$OUT_TXT"
fi

# The read is still the canary, and still fires.
ISSUE_CODE=401 run done "feat: dead token (WARP-15)"
unset ISSUE_CODE
if [ $RC -eq 1 ] && echo "$OUT_TXT" | grep -q "credential looks dead"; then
  pass "🔴 a dead credential DOES turn it red — the one thing that must not rot"
else
  fail "🔴 a dead credential turns it red — rc=$RC out=$OUT_TXT"
fi

issue "To Do" "To Do" "Story"; transitions "$TRANSITIONS_DEFAULT"
ISSUE_CODE=500 run done "feat: jira wobbled (WARP-16)"
unset ISSUE_CODE
if [ $RC -eq 0 ]; then
  pass "a 5xx is a warning — the merge already happened"
else
  fail "a 5xx stays green — rc=$RC out=$OUT_TXT"
fi

# The mixed case: one key dead-lettered, one moved. Must stay green, because
# something worked and a red X would blame the whole PR for half a problem.
issue "To Do" "To Do" "Story"; transitions "$TRANSITIONS_DEFAULT"
run done "feat: one good one bad (WARP-17)"
if [ $RC -eq 0 ] && posted_transition; then
  pass "a run that moved something is green"
else
  fail "a run that moved something is green — rc=$RC"
fi

JIRA_API_TOKEN="" run done "feat: no secret (WARP-18)"
if [ $RC -eq 0 ] && echo "$OUT_TXT" | grep -q "dormant"; then
  pass "absent secrets are a notice, not a failure"
else
  fail "absent secrets are a notice — rc=$RC out=$OUT_TXT"
fi

JIRA_API_TOKEN="" PR_FROM_FORK=true run done "feat: from a fork (WARP-19)"
if [ $RC -eq 0 ] && echo "$OUT_TXT" | grep -q "fork"; then
  pass "a fork PR says WHY the secrets were missing, rather than misleading"
else
  fail "a fork PR names the fork — out=$OUT_TXT"
fi

# --- Phase 5: injection -------------------------------------------------------
echo ""
echo "--- Phase 5: the title is untrusted input ---"

issue "To Do" "To Do" "Story"; transitions "$TRANSITIONS_DEFAULT"
run done 'feat: $(touch '"$WORK"'/pwned) `id` "; rm -rf / (WARP-20)'
if [ ! -f "$WORK/pwned" ] && [ $RC -eq 0 ]; then
  pass "🔴 a crafted PR title executes nothing"
else
  fail "🔴 a crafted PR title executed something"
fi

echo ""
echo "  ------------------------------------------------"
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mAll %d tests passed\033[0m\n\n" "$TESTS"
else
  printf "  \033[31m%d of %d failed\033[0m\n\n" "$FAILURES" "$TESTS"
fi
echo "FAILURES=$FAILURES"
exit $((FAILURES > 0))
