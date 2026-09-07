#!/usr/bin/env bash
# =============================================================================
# jira-ticket-status.sh — move the WARP tickets a PR names to match the PR.
#
# WARP-1811. Called by .github/workflows/jira-ticket-status.yml on two events:
# a PR opening (`--mode in-review`) and a PR merging (`--mode done`).
#
# ── Why this exists ─────────────────────────────────────────────────────────
#
# Nothing in the merge path has ever transitioned the ticket a PR implements,
# so the board persistently overstates open work. Measured three times:
#
#   2026-07-11   30 tickets with merged PRs stranded not-Done (28 fixed by hand)
#   2026-08-07   63 more, out of 499 open — ~13% of the visible backlog
#   2026-09-07   15 more in one session (7 filing slices + 8 ADR-045 tickets),
#                every one of them merged to `stage` days earlier
#
# Each sweep fixes the symptom and none of them stops the next one. A hand
# transition costs the same as building this and regenerates within weeks.
#
# ── Why it is a script and not inline YAML ──────────────────────────────────
#
# Because it writes to Jira, and a thing that writes needs tests. Every guard
# below is exercised by tests/jira-ticket-status.test.sh against a stubbed
# `curl`, which is the only way to prove the Epic guard or the already-Done
# skip without a live board and a ticket to spoil.
#
# ── The contract, enforced socially by pr-title-ticket-lint.yml ─────────────
#
#   - the TITLE carries the key(s) the PR IMPLEMENTS; those are transitioned
#   - keys merely REFERENCED go in the body, which this never reads. A prior
#     sweep measured ~27% false positives on body-sourced keys, which is why
#     this reads one field and not two.
#   - "[no-close]" transitions nothing (a comment still links the PR)
#   - "[no-ticket]" and "DO-NOT-MERGE" skip the run entirely
#
# ── What it refuses to touch ────────────────────────────────────────────────
#
#   - Epics. An epic closes when someone decides its children add up to the
#     thing, which is a judgement no merge can make.
#   - "Hardware Test". That status is a deliberate hold meaning "the code is
#     in, somebody still has to put it on a box" — precisely the state a
#     merge must not clear. WARP-2736 and WARP-2814 exist because merging is
#     not the same as proving.
#   - Anything already in the target state, or past it. Re-transitioning is
#     not merely wasteful: on a workflow where the transition is not a
#     self-loop it is an error, and errors on merged PRs is the failure mode
#     that made #1614's reviewer ask for this guard.
#
# ── Failure posture ─────────────────────────────────────────────────────────
#
# A Jira hiccup is a ::warning. The merge already happened and a red X on a
# merged PR is pure noise. The ONE thing that turns this red is a credential
# that no longer works — 401/403 on the READ of every key — because a silently
# dead token is how this automation would rot back into hand sweeps without
# anyone noticing. A REJECTED transition (400/409) is not that, and is counted
# apart.
#
# "on the READ" is load-bearing, not a hedge. Jira Cloud documents 403 on
# POST /rest/api/3/issue/{key}/transitions as "the user does not have the
# necessary permission" — a per-project permission, not a dead token. Every
# POST below is reached only AFTER a 200 from GET /issue/{key}, so by then the
# credential is demonstrably alive and a 401/403 is evidence about permissions
# alone. Counting those as auth failures is what turned a MERGED PR red and
# told the reader to rotate a healthy token: #1614's defect, relocated out of
# the transition-code branch and into the predicate.
#
# Usage:  jira-ticket-status.sh --mode in-review|done
# Env:    PR_TITLE PR_NUMBER PR_URL PR_BASE_REF JIRA_EMAIL JIRA_API_TOKEN
#         JIRA_BASE_URL (default https://warp-lab.atlassian.net)
# =============================================================================
set -uo pipefail

MODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  in-review) TARGET_STATUS="In Review" ;;
  done)      TARGET_STATUS="Done" ;;
  *) echo "--mode must be in-review or done" >&2; exit 2 ;;
esac

PR_TITLE="${PR_TITLE:-}"
PR_NUMBER="${PR_NUMBER:-}"
PR_URL="${PR_URL:-}"
PR_BASE_REF="${PR_BASE_REF:-}"
JIRA_BASE_URL="${JIRA_BASE_URL:-https://warp-lab.atlassian.net}"
JIRA_EMAIL="${JIRA_EMAIL:-}"
JIRA_API_TOKEN="${JIRA_API_TOKEN:-}"

# Statuses that mean "this ticket is finished". Matched on the status CATEGORY
# rather than the name, because "Won't Do" is also terminal and a name list
# would have to be kept in step with the Jira workflow by hand.
DONE_CATEGORY="Done"

note() { echo "$*"; }
warn() { echo "::warning title=jira-ticket-status::$*"; }

# ── the two things that stop the run before any network call ────────────────

if [ -z "$JIRA_EMAIL" ] || [ -z "$JIRA_API_TOKEN" ]; then
  # Distinguishing these matters: on a fork PR `pull_request` withholds
  # secrets that ARE configured, and a notice saying they are "not set" sends
  # the reader to the repo settings to find them already there (#1614 nit 3).
  if [ "${PR_FROM_FORK:-false}" = "true" ]; then
    note "::notice title=Skipped for a fork::Secrets are withheld from fork pull requests, so no ticket was moved."
  else
    note "::notice title=jira-ticket-status is dormant::JIRA_EMAIL / JIRA_API_TOKEN are not set on this repository."
  fi
  exit 0
fi

for MARKER in '[no-ticket]' 'DO-NOT-MERGE'; do
  if printf '%s' "$PR_TITLE" | grep -qF -- "$MARKER"; then
    note "title carries $MARKER — nothing to do"
    exit 0
  fi
done

NO_CLOSE=0
if printf '%s' "$PR_TITLE" | grep -qF -- '[no-close]'; then
  NO_CLOSE=1
  note "[no-close] present — the PR will be linked on the ticket, but nothing is transitioned"
fi

# Uppercase only, deliberately: pr-title-ticket-lint.yml accepts the same
# casing and nothing else, so the two agree by construction. A lowercase
# `warp-123` is rejected by the lint before it can reach here.
KEYS=$(printf '%s' "$PR_TITLE" | grep -oE 'WARP-[0-9]+' | sort -u)
if [ -z "$KEYS" ]; then
  note "no WARP keys in the title — nothing to do"
  exit 0
fi

# ── HTTP ────────────────────────────────────────────────────────────────────
#
# `--max-time` on every call: a hung Jira connection would otherwise burn the
# job's whole timeout and fail it with no diagnostic — a red X on a merged PR
# with nothing to read (#1614 nit 2). No `|| echo 000` either: on a
# connection-level failure curl already prints 000 via `-w`, and the fallback
# appended a second one so the warning read "returned HTTP 000 000" (nit 1).

jira_get() { # $1 = path → body on stdout, HTTP code on fd 3
  curl -sS --max-time 30 -o /tmp/jira-body.$$ -w '%{http_code}' \
    -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
    -H 'Accept: application/json' \
    "$JIRA_BASE_URL$1"
}

jira_post() { # $1 = path, $2 = json → HTTP code on stdout
  curl -sS --max-time 30 -o /dev/null -w '%{http_code}' \
    -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
    -H 'Content-Type: application/json' \
    -X POST "$JIRA_BASE_URL$1" -d "$2"
}

# Auth-class failures are the only ones that can turn this job red. Kept as a
# predicate rather than inline so the "dead token" definition lives in one
# place and the tests can name it.
#
# The `read_` in the name is the contract: the READ is the ONLY place this may
# be applied. A 401/403 on GET /issue/<key> is the only response in this script
# that is evidence about the token, because everything after it runs only
# because that GET returned 200. Named this way so `read_is_auth_failure "$T"`
# on a transition POST reads wrong where it is written — which is exactly how
# it drifted onto the POSTs and turned a merged PR red for a permission
# problem. Every non-2xx after the read is an OTHER failure, by construction.
read_is_auth_failure() { case "$1" in 401|403) return 0 ;; *) return 1 ;; esac; }

MOVED=0      # transitions that happened
SKIPPED=0    # deliberately left alone — a guard fired
REJECTED=0   # Jira said no to the transition itself
AUTH_FAIL=0  # a READ answered 401/403 — the only credential evidence there is
OTHER_FAIL=0 # everything else

for KEY in $KEYS; do
  CODE=$(jira_get "/rest/api/3/issue/$KEY?fields=status,issuetype")
  BODY=$(cat /tmp/jira-body.$$ 2>/dev/null || echo '{}')
  rm -f /tmp/jira-body.$$

  if [ "$CODE" != "200" ]; then
    if read_is_auth_failure "$CODE"; then
      warn "$KEY could not be read — HTTP $CODE (credential)"
      AUTH_FAIL=$((AUTH_FAIL + 1))
    else
      warn "$KEY could not be read — HTTP $CODE"
      OTHER_FAIL=$((OTHER_FAIL + 1))
    fi
    continue
  fi

  STATUS=$(printf '%s' "$BODY" | jq -r '.fields.status.name // ""')
  CATEGORY=$(printf '%s' "$BODY" | jq -r '.fields.status.statusCategory.name // ""')
  TYPE=$(printf '%s' "$BODY" | jq -r '.fields.issuetype.name // ""')

  # ── the guards ────────────────────────────────────────────────────────────

  if [ "$TYPE" = "Epic" ]; then
    note "$KEY is an Epic — left alone (an epic closes when a person says its children add up)"
    SKIPPED=$((SKIPPED + 1)); continue
  fi

  if [ "$STATUS" = "Hardware Test" ]; then
    note "$KEY is on Hardware Test — left alone (a deliberate hold; merging is not proving)"
    SKIPPED=$((SKIPPED + 1)); continue
  fi

  if [ "$STATUS" = "$TARGET_STATUS" ]; then
    note "$KEY is already $TARGET_STATUS"
    SKIPPED=$((SKIPPED + 1)); continue
  fi

  # Never walk a ticket BACKWARDS out of a terminal state. A follow-up PR
  # naming an already-closed key is ordinary — every one of the 15 keys closed
  # by hand on 2026-09-07 is now a candidate — and dragging one back to In
  # Review because somebody referenced it would be worse than the drift this
  # script exists to end.
  if [ "$CATEGORY" = "$DONE_CATEGORY" ] && [ "$MODE" = "in-review" ]; then
    note "$KEY is $STATUS (terminal) — not reopened"
    SKIPPED=$((SKIPPED + 1)); continue
  fi
  if [ "$CATEGORY" = "$DONE_CATEGORY" ] && [ "$MODE" = "done" ]; then
    note "$KEY is already $STATUS"
    SKIPPED=$((SKIPPED + 1)); continue
  fi

  # ── the comment, before the transition ────────────────────────────────────
  #
  # Deliberately first: if the transition is rejected the ticket still carries
  # the link to the PR that implements it, which is the half a person needs
  # when they come to close it by hand.
  if [ "$MODE" = "done" ]; then
    TEXT="PR #${PR_NUMBER} merged into ${PR_BASE_REF} — ${PR_TITLE} — ${PR_URL}"
  else
    TEXT="PR #${PR_NUMBER} opened against ${PR_BASE_REF} — ${PR_TITLE} — ${PR_URL}"
  fi
  # jq --arg so the PR title lands in the JSON as data and never as syntax.
  COMMENT=$(jq -n --arg text "$TEXT" \
    '{body:{type:"doc",version:1,content:[{type:"paragraph",content:[{type:"text",text:$text}]}]}}')
  C=$(jira_post "/rest/api/3/issue/$KEY/comment" "$COMMENT")
  if [ "$C" != "201" ]; then
    # Not an auth failure whatever the code: the read above returned 200, so a
    # 403 here is "no Add Comments permission on this project", not a token.
    OTHER_FAIL=$((OTHER_FAIL + 1))
    warn "$KEY comment failed — HTTP $C"
    continue
  fi

  if [ "$NO_CLOSE" = "1" ]; then
    SKIPPED=$((SKIPPED + 1)); continue
  fi

  # ── resolve the transition BY NAME, never by id ───────────────────────────
  #
  # WARP-1811 named ids (51 Done, 4 In Review, 2 In Progress) and they are
  # correct today. They are also Jira workflow configuration that no test in
  # this repo can pin, and this session already met three different ids
  # reaching Done from three different statuses. Asking the board which
  # transition lands on the status we want costs one GET and cannot drift.
  CODE=$(jira_get "/rest/api/3/issue/$KEY/transitions")
  TBODY=$(cat /tmp/jira-body.$$ 2>/dev/null || echo '{}')
  rm -f /tmp/jira-body.$$
  if [ "$CODE" != "200" ]; then
    # A GET, but not THE read: it is reached only because the issue read
    # already returned 200, so it says nothing about the credential either.
    OTHER_FAIL=$((OTHER_FAIL + 1))
    warn "$KEY transitions could not be listed — HTTP $CODE"
    continue
  fi

  TID=$(printf '%s' "$TBODY" | jq -r --arg want "$TARGET_STATUS" \
    'first(.transitions[]? | select(.to.name == $want) | .id) // ""')
  if [ -z "$TID" ]; then
    # Not an error: a ticket can legitimately have no path to the target from
    # where it stands. Says so by name, so nobody goes looking for an outage.
    note "$KEY has no transition to $TARGET_STATUS from $STATUS — left at $STATUS"
    SKIPPED=$((SKIPPED + 1)); continue
  fi

  T=$(jira_post "/rest/api/3/issue/$KEY/transitions" "{\"transition\":{\"id\":\"$TID\"}}")
  case "$T" in
    204)
      note "$KEY: $STATUS → $TARGET_STATUS"
      MOVED=$((MOVED + 1)) ;;
    400|409)
      # Jira refused the move itself. Counted apart from a failure on purpose:
      # this is the case #1614's review caught turning merged PRs red, and it
      # is not evidence of anything being broken.
      warn "$KEY transition to $TARGET_STATUS was rejected — HTTP $T"
      REJECTED=$((REJECTED + 1)) ;;
    *)
      # Including 403. Jira documents it here as "the user does not have the
      # necessary permission" — a per-project grant the minting account is
      # missing, on a credential the read at the top of this loop just proved
      # alive. Rotating the token would fix nothing and the ticket would still
      # not move, so this must never be the thing that turns a merged PR red.
      OTHER_FAIL=$((OTHER_FAIL + 1))
      warn "$KEY transition failed — HTTP $T" ;;
  esac
done

note "moved=$MOVED skipped=$SKIPPED rejected=$REJECTED auth_failures=$AUTH_FAIL other_failures=$OTHER_FAIL"

# The ONLY red. Nothing worked AND the reason was the credential on every key
# — the dead-token case, which must not rot silently. A rejected transition or
# a single flaky call leaves this green, because the merge already happened.
if [ "$AUTH_FAIL" -gt 0 ] && [ "$MOVED" -eq 0 ] && [ "$SKIPPED" -eq 0 ]; then
  echo "::error title=Jira credential looks dead::Every ticket failed with an auth error. Rotate JIRA_EMAIL / JIRA_API_TOKEN."
  exit 1
fi
exit 0
