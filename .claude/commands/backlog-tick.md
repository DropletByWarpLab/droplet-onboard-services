---
description: Advance the WARP backlog by one ticket through the agent harness (one /loop tick)
---

You are the **backlog-driver controller**. This is ONE tick: take the next ready
WARP ticket through the full agent harness, open its PR, record the result, and
signal whether the loop should continue. Do exactly **one** ticket, then end the tick.

Authoritative within-ticket behavior lives in `docs/superpowers/agent-harness.md`.
This command only adds *cross-ticket sequencing*. When in doubt about a gate,
defer to that doc — do not re-derive it.

## Hard rules
- NEVER merge a PR. NEVER force-push. NEVER post QA/UX/Reviewer verdicts to GitHub.
- NEVER start a ticket whose dependencies are not ALL merged to `main`. No stacking.
- When any STOP condition fires, append to the run log, print the
  `LOOP_STATUS: STOP — <reason>` line, and end the tick WITHOUT scheduling more work.
- On a normal successful ticket, print `LOOP_STATUS: CONTINUE` and end the tick
  (the `/loop` wrapper re-fires for the next ticket).

## Step 1 — Run-cap bookkeeping
Get NOW: `date -u +%Y-%m-%dT%H:%M:%SZ`.
Read `.claude/loop-state/run.json` if present.
- If absent, OR its `started_at` is more than 12h before NOW (stale ⇒ new run):
  write `{ "started_at": "<NOW>", "count": 0 }`.
- If `count >= 5`: print `LOOP_STATUS: STOP — run cap reached (5 tickets)` and end.
- If `(NOW - started_at) >= 4h`: print `LOOP_STATUS: STOP — run cap reached (4h)` and end.

## Step 2 — Load / seed the queue
Read `.claude/loop-state/queue.json`. If missing OR no item has `status == "pending"`:
- **Seed** via Jira MCP: search the WARP project for ready tickets. Default JQL
  (status validated against the live WARP workflow on 2026-06-25 — re-validate if the
  board's workflow changes):
  `project = WARP AND status = "To Do" AND issuetype != Epic AND description IS NOT EMPTY ORDER BY rank`.
  The `issuetype != Epic AND description IS NOT EMPTY` clauses keep epics and unrefined
  placeholders out of the queue; the null-description guard in Step 3 is a backstop.
  Record the final JQL in `run-log.md`.
- **Paginate** the seed query until `hasNextPage == false` — the ready backlog spans
  many pages (≈300 items at last seed).
- For each ticket, read its issue links; collect "is blocked by" keys as `blockers`.
  Store `touchesDashboard: null` (resolved later from the branch diff).
- Order topologically by `blockers`; break ties by Jira rank.
- Write `queue.json`:
  `{ "v": 1, "seeded_jql": "<jql>", "items": [ { "key": "...", "blockers": [...], "touchesDashboard": null, "status": "pending" } ] }`
- If the seed returns nothing: print `LOOP_STATUS: STOP — backlog drained` and end.

## Step 3 — Select the next workable ticket
Walk `items` top-down. For the first `pending` ticket, classify each blocker:
- **Satisfied** only when its PR is **merged to `main`** — verify by content, e.g.
  `gh pr list --state merged --search "<BLOCKER_KEY>"`, and confirm the commits are on
  `main`. **Do NOT trust Jira status** to mark a blocker satisfied.
- **Ambiguous** if the blocker is Jira-`Done` but has **no merged PR** (e.g. an
  infra/manual ticket that closed without one). An ambiguous blocker is NOT
  auto-satisfied.
- **Unsatisfied** otherwise (open/unmerged PR, or not yet done).

Then select:
- Before selecting, fetch the candidate's Jira description. If it is null or empty,
  skip it: append `SKIPPED <KEY>: no description — needs spec before dispatch` to
  `run-log.md` and continue to the next `pending` ticket (backstop — the seed JQL
  already excludes empty-description tickets).
- Pick the first `pending` ticket with a non-empty description whose blockers are ALL
  **satisfied**. Set its `status` to `in_progress`; persist `queue.json`.
- If a candidate is runnable except that one or more blockers are **ambiguous** (all
  its other blockers satisfied), STOP — do not auto-start and do not silently skip:
  print `LOOP_STATUS: STOP — handoff: blocker <KEY> is Done in Jira with no merged PR;
  confirm it is safe before <TICKET> starts`, and end.
- If NO pending ticket qualifies because blockers are genuinely **unsatisfied** (or
  only empty-description tickets remain): print
  `LOOP_STATUS: STOP — all remaining tickets blocked on your merge`, list the open PRs
  already produced (from `run-log.md`), and end.

## Step 4 — Run the harness for the selected ticket
Fetch the ticket body + AC from Jira. Create the ticket's branch in its own git
worktree. Then run the gates per `agent-harness.md`:
1. Dispatch `droplet-dev` with the ticket body + AC + relevant spec sections inline.
   Wait for its self-assessment + pushed branch with green local tests.
2. Determine if the branch touches `apps/web-dashboard/`; set `touchesDashboard`.
   Dispatch `droplet-qa` and — only if it touches the dashboard — `droplet-ui-ux`,
   concurrently. Wait for BOTH. QA FAIL or UX CHANGES_REQUESTED ⇒ back to Dev with
   the note (bounded; if it recurs, go to Step 6 handoff).
3. Dispatch `droplet-manager`. `SEND_BACK_TO_DEV` ⇒ back to Dev. `HANDOFF_TO_HUMAN`
   ⇒ Step 6. `READY_FOR_PR` ⇒ Manager opens the PR.
4. **Inline CI watch** (NOT a nested /loop): poll `gh pr checks <n>` using the
   classification table in agent-harness.md §3 — infra flake ⇒ `gh run rerun <id>
   --failed` (≤3 attempts/check); source defect ⇒ back to Dev once; systemic ⇒
   Step 6. Cap: ≤6 polls / ≤30 min. Briefly wait between polls.
5. Dispatch `droplet-code-reviewer`. `APPROVE` ⇒ Step 5. `APPROVE_WITH_COMMENTS` ⇒
   fix via Dev + re-push + re-review, ≤2 rounds, else Step 6. `REQUEST_CHANGES` ⇒
   back to Dev once, else Step 6.

## Step 5 — Record success and continue
Append a block to `run-log.md`: NOW, ticket key, Dev/QA/UX/Manager/CI/Reviewer
verdicts, PR URL, outcome `PR_OPEN_READY_FOR_MERGE`. Set the queue item
`status: "done"`. Increment `run.json.count`. Print `LOOP_STATUS: CONTINUE` and end.

## Step 6 — Handoff (a STOP)
Append a block to `run-log.md` with outcome `HANDOFF: <reason>`. Set the queue item
`status: "blocked"`. Print `LOOP_STATUS: STOP — handoff: <reason>` with a short
summary of where things stand, and end. Do not schedule more work.
