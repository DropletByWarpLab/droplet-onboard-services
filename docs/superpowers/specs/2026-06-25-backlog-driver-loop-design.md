# Backlog-Driver Loop — Design

**Date:** 2026-06-25
**Status:** Approved (design), pending implementation plan
**Builds on:** [`docs/superpowers/agent-harness.md`](../agent-harness.md) v1.0 (WARP-88)
**Role prompts (unchanged):** `.claude/agents/{dev,qa,ui-ux,manager,code-reviewer}.md`

## 1. Goal

Drive the existing agent harness across the WARP backlog **unattended**, using a
self-paced `/loop`. The loop owns *sequencing across tickets*; the harness still
owns *everything within a ticket* (Dev → QA → UI/UX → Manager → PR → CI →
Code Reviewer → Human). We wrap the harness — we do **not** rewrite it, the five
role agents, or the gate logic.

You run it as:

```
/loop /backlog-tick
```

Self-paced (no interval). Each firing of `/backlog-tick` advances **one ticket**
end-to-end, then the loop re-fires for the next ticket until a stop condition hits.

## 2. Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | **Scope** | Backlog-driver loop only (no PR-babysitter, CI-watcher-as-separate-loop, or local-verify loop in this design). |
| 2 | **Ticket source** | Hybrid — seed an ordered queue from Jira once, walk it, re-sync from Jira only when the queue drains. |
| 3 | **Autonomy boundary** | Open the PR, keep going on the next ready ticket, **never merge**. Pause the whole loop only on a hard handoff or when everything left is blocked on a human merge. |
| 4 | **Dependency handling** | **Wait** — only start a ticket once all its dependencies are merged to `main`. No branch stacking. |
| 5 | **Effort / model** | **Uniform** — controller and all five agents inherit the session model + reasoning effort. No agent frontmatter pins. Launch the session at **Opus + high**. |

## 3. Why these (rationale)

- **Hybrid queue** avoids coupling every tick to Jira MCP reliability and the
  reconciliation quirks already documented in memory (`jira-git-reconciliation`),
  while still starting from live Jira state.
- **Never merge** honors the harness's "human is the final gate, every PR,
  unconditionally" (agent-harness.md §4). The dependency graph self-throttles the
  loop: it produces a set of independent, mergeable PRs and then stops.
- **Wait, don't stack** matches the repo's "Simplicity first" guideline — no
  rebase choreography, no QA refusing non-fast-forward branches (agent-harness.md
  §2.3).
- **Uniform effort** is the only option fully consistent with `/loop`: the Agent
  (subagent) dispatch tool exposes a per-agent **model** override but **no**
  per-agent **effort** override. Effort is therefore a single session-level value
  applied to the controller and every agent. (True per-gate effort would require
  rebuilding the controller as a `Workflow`, which was rejected to stay on `/loop`.)

## 4. Architecture

New surface area is intentionally small:

| Artifact | Path | Purpose |
|---|---|---|
| Per-tick controller | `.claude/commands/backlog-tick.md` | The slash command run by `/loop`. Processes exactly one ticket through the harness. |
| Work queue | `.claude/loop-state/queue.json` | Ordered list of ready tickets + their blockers. Single source of truth for "what's next." |
| Run log | `.claude/loop-state/run-log.md` | Append-only audit trail (timestamp, ticket, gate verdicts, PR URL, outcome). What the controller re-reads to resume after a context summary. |
| Harness doc update | `docs/superpowers/agent-harness.md` | New "§8 Backlog-driver loop" section documenting this mode alongside the existing CI ralph-loop (§3). |
| Dry-run trace | `docs/superpowers/harness-runs/<KEY>-backlog-loop-dryrun.md` | First-run evidence, committed (mirrors the harness's existing dry-run convention). |

`.claude/loop-state/` is **gitignored** — per-run scratch, not a tracked artifact.
The committed dry-run trace is the durable record.

## 5. The per-tick algorithm (`/backlog-tick` = one firing)

1. **Load state.** Read `queue.json` + `run-log.md`.
   - If `queue.json` is missing or has no remaining items → **seed** (step 1a).
2. **(1a) Seed** (only when the queue is empty). Query the WARP project via Jira
   MCP for *ready* tickets. Read each ticket's "is blocked by" issue links to
   record blockers. Topologically order by those links; where link data is
   incomplete, fall back to Jira rank/priority order and rely on step 3's
   merged-to-`main` check as the real gate. Write `queue.json`.
   - **First-seed validation:** the "ready" JQL is configurable and its exact
     status names MUST be validated against the live WARP workflow on first run —
     do not hardcode a guessed status (per repo "No guessing" rule). Record the
     final JQL in `run-log.md`.
   - If the seed returns nothing → **STOP: backlog drained.**
3. **Select.** Walk the queue top-down; pick the first ticket whose **every
   blocker has a merged PR on `main`**. Verify against `main` by content
   (matching the `pr-review-verify-head` / `jira-git-reconciliation` memories),
   not by trusting Jira status.
   - If no queued ticket qualifies → **STOP: N PRs open, waiting on your merge**
     (list them with URLs).
4. **Isolate.** Create the ticket's branch in its own git worktree (this repo
   already operates this way). One branch per ticket.
5. **Dev gate.** Dispatch `droplet-dev` with the ticket body, AC, and relevant
   spec sections inline (per the agent's input contract). Wait for its
   self-assessment + pushed branch with green local tests.
6. **QA ∥ UI/UX gates.** Dispatch `droplet-qa` and, *only if the branch touches
   `apps/web-dashboard/`*, `droplet-ui-ux` — concurrently (harness §2.2). Wait
   for both. QA FAIL or UX CHANGES_REQUESTED → back to Dev (step 5) with the
   note; bounded by the run cap (§7).
7. **Manager gate.** Dispatch `droplet-manager` with QA + UX (or "N/A") + ticket.
   - `READY_FOR_PR` → Manager opens the PR. Continue.
   - `SEND_BACK_TO_DEV` → step 5 with the note.
   - `HANDOFF_TO_HUMAN` → **STOP: handoff** (§7).
8. **CI watch (inline, bounded).** Poll `gh pr checks <n>` using the *exact
   classification table from agent-harness.md §3* (infra-flake → rerun;
   source-defect → back to Dev; systemic → handoff), but as an **in-tick poll,
   not a nested `/loop`**: ≤ 6 polls / ≤ 30 min, ≤ 3 attempts per failing check.
   - All green → step 9. Source defect → step 5 once, else handoff. Systemic or
     persistent infra flake → **STOP: handoff.**
9. **Code Reviewer gate.** Dispatch `droplet-code-reviewer` (internal artifact —
   never posted to GitHub).
   - `APPROVE` → record the PR as "ready for your merge."
   - `APPROVE_WITH_COMMENTS` → fix locally via Dev, re-push, re-review; ≤ 2
     rounds (harness §5.5). Non-convergence → **STOP: handoff.**
   - `REQUEST_CHANGES` → step 5, or handoff if it recurs.
10. **Record + advance.** Append the outcome to `run-log.md` (ticket, all gate
    verdicts, PR URL, result), mark the queue item done. The loop re-fires for
    the next ticket.

Across tickets the loop is **serial** (one ticket per firing). *Within* a ticket,
QA ∥ UI/UX remain parallel per the harness. No cross-ticket parallelism — the
"wait on merged deps" decision makes serial the natural fit.

## 6. State file shapes

`.claude/loop-state/queue.json`:

```json
{
  "v": 1,
  "seeded_jql": "project = WARP AND status = \"<validated>\" ORDER BY rank",
  "items": [
    { "key": "WARP-321", "blockers": ["WARP-320"], "touchesDashboard": false, "status": "pending" }
  ]
}
```

`status` ∈ `pending | in_progress | done | blocked`. `blockers` are WARP keys
whose PRs must be merged to `main` before this item is selectable.

`.claude/loop-state/run-log.md` — append-only markdown, one block per ticket
attempt: timestamp, ticket key, Dev/QA/UX/Manager/CI/Reviewer verdicts, PR URL,
final outcome (`PR_OPEN_READY_FOR_MERGE` | `HANDOFF:<reason>` | `SENT_BACK`).

## 7. Stop conditions & guardrails

The loop halts and posts a summary when:

- **Backlog drained** — seed returns nothing.
- **All-blocked** — every remaining queued ticket waits on a merge only the human
  can do.
- **Hard handoff** (agent-harness.md §4) — product ambiguity, AC drift, systemic
  CI outage, or persistent infra flake.
- **Runaway caps** — stop after **N = 5 tickets** *or* **M = 4 hours** per run
  (override at launch). Mirrors the ralph-loop's bounded-attempt discipline.

The loop **never**: merges a PR; force-pushes (already denied in
`.claude/settings.json`); starts a ticket with an unmerged dependency; runs past
its caps; or posts QA / UX / Reviewer verdicts to GitHub (they stay internal per
agent-harness.md §6).

## 8. Effort & model

- Launch the session at **Opus 4.8 + high** reasoning effort. Every tick inherits
  it; the controller's handoff/dependency-classification calls and the Dev +
  Code Reviewer judgment all benefit, while the mechanical gates (QA running
  vitest/tsc/pytest) cost no extra effort.
- **No agent frontmatter changes.** All five agents stay unpinned and inherit the
  session model/effort.
- Cost/quality is tuned solely by the session model + effort you choose at launch.

## 9. Build & rollout plan

1. Commit this spec.
2. Implement `.claude/commands/backlog-tick.md` (controller prompt), the
   `queue.json` / `run-log.md` conventions, and the seed step (Jira query →
   ordered queue). Add `.claude/loop-state/` to `.gitignore`.
3. Add agent-harness.md §8 documenting this mode.
4. **Dry-run** on one real ready ticket with the *merge step inherently absent*
   (the loop never merges anyway) — capture the trace to
   `docs/superpowers/harness-runs/`. Fix any controller-prompt rough edges
   in-branch (harness §7).
5. Once the dry-run is clean → run for real: `/loop /backlog-tick`.

## 10. Non-goals (out of scope)

- PR-babysitter, standalone CI-watcher, and local continuous-verification loops
  (deferred; not part of this design).
- Auto-merge / removing the human merge gate.
- Branch stacking across unmerged dependencies.
- Per-gate effort differentiation (would require a `Workflow` controller).
- Cross-ticket parallel execution.
- Changes to the five role agents or the within-ticket gate logic.

## 11. Post-dry-run refinements (2026-06-25)

The controller-logic dry-run (Task 3 of the implementation plan) ran the seed +
selection against the live WARP board and surfaced two facts the original design
didn't anticipate. Both were resolved by the user:

1. **Ready status validated + queue tightened.** The "ready" status is `To Do`
   (Jira statusCategory `new`), but `status = "To Do"` alone returned ~295 tickets —
   the whole backlog, including epics and description-less placeholders (e.g. the
   top-ranked WARP-34 had a null description). The seed JQL is therefore
   `project = WARP AND status = "To Do" AND issuetype != Epic AND description IS NOT EMPTY ORDER BY rank`,
   and the seed paginates until `hasNextPage == false`. The Step 3 null-description
   skip remains as a backstop.

2. **`Done`-without-PR blockers → handoff, never auto-satisfy.** Some completed
   tickets (e.g. WARP-230) are Jira-`Done` with no merged PR, which would deadlock
   their dependents under the strict "merged-to-`main` only" rule. Decision: a
   blocker that is Jira-`Done` with no merged PR is **ambiguous** — the loop does NOT
   auto-satisfy it from Jira status (the "verify against `main`, not Jira status"
   rule stands) and does NOT silently skip the dependent; instead it STOPs with a
   handoff naming the blocker so the human confirms before that dependent starts.
