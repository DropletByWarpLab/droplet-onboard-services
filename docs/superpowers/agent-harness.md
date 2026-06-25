# Agent Harness — Execution Playbook

**Version:** 1.0 (2026-04-16, WARP-88)
**Authoritative reference:** `docs/superpowers/specs/2026-04-16-device-intelligence-design.md` §11
**Role prompts:** `.superpowers/agents/{dev,qa,ui-ux,manager,code-reviewer}.md`

This playbook tells the controller (a human or a coordinating Claude session) **how** to sequence the role agents for a Phase 1 ticket. Role-level behavior lives in the per-role prompt files; this doc is the ordering contract + exception handling.

---

## 1. Gate sequence

One pass per ticket. Each gate must pass before the next fires.

```
┌──────┐   ┌────┐   ┌───────┐   ┌─────────┐   ┌────┐   ┌────┐   ┌──────────────┐   ┌───────┐
│ Dev  │──▶│ QA │──▶│ UI/UX │──▶│ Manager │──▶│ PR │──▶│ CI │──▶│ Code Reviewer│──▶│ Human │
└──────┘   └────┘   └───────┘   └─────────┘   └────┘   └────┘   └──────────────┘   └───────┘
                    (skipped on
                  non-dashboard
                     tickets)
```

| Gate | Runner | Input | Output | Advance when |
|---|---|---|---|---|
| **Dev** | `.superpowers/agents/dev.md` | ticket + spec + AC + branch | pushed branch, green local tests, self-assessment | Dev says "done + tests green" |
| **QA** | `.superpowers/agents/qa.md` | branch + Dev self-assessment | QA Report (PASS / PASS_WITH_NOTES / FAIL) | QA verdict ≠ FAIL |
| **UI/UX** | `.superpowers/agents/ui-ux.md` (dashboard only) | branch + spec §8 + ADR-002 | UX Review (APPROVED / APPROVED_WITH_NOTES / CHANGES_REQUESTED) | UX verdict ≠ CHANGES_REQUESTED |
| **Manager** | `.superpowers/agents/manager.md` | QA + UX + ticket | `READY_FOR_PR` or `SEND_BACK_TO_DEV` or `HANDOFF_TO_HUMAN` | `READY_FOR_PR` |
| **PR** | Manager invokes `gh pr create` | PR body + title | PR number + URL | PR created |
| **CI** | GitHub Actions | PR | 8 workflows green | all green |
| **Code Reviewer** | `.superpowers/agents/code-reviewer.md` | PR diff + spec + QA + UX | single review verdict — internal artifact, NOT posted to GitHub (APPROVE / APPROVE_WITH_COMMENTS / REQUEST_CHANGES) | Reviewer verdict ≠ REQUEST_CHANGES |
| **Human** | project lead | everything above | merge or defer | human clicks merge |

### Non-dashboard tickets

Skip the UI/UX gate for tickets that do NOT touch `apps/web-dashboard/`. In Phase 1 this is WARP-80, WARP-81, WARP-82, WARP-87, WARP-88.

The Manager still synthesizes — the UX section of its decision tree simply has no input.

---

## 2. Parallelism

Agents run serially **within** a ticket (the gate sequence). Agents run **across** tickets in parallel where the dependency graph allows.

### 2.1 Ticket-level parallelism — Phase 1

From spec §4:

```
WARP-88  (harness, first — this ticket)
   │
WARP-80  (data model)
   │
WARP-81  (reconciler + OUI)
   │
   ├─────────────┬─────────────┬─────────────┬─────────────┐
   ▼             ▼             ▼             ▼             ▼
WARP-82      WARP-87      WARP-83      ...
(API)        (CI OUI)     (card grid)
                              │
                              ├──────────┬──────────┐
                              ▼          ▼          ▼
                          WARP-84    WARP-85    WARP-86
                          (detail)   (groups)   (block)
```

| Ticket | Runs after | Runs in parallel with |
|---|---|---|
| WARP-88 | — | — |
| WARP-80 | WARP-88 dry-run | — |
| WARP-81 | WARP-80 merged | — |
| **WARP-82** | WARP-81 merged | **WARP-87** |
| **WARP-87** | WARP-81 merged | **WARP-82** |
| WARP-83 | WARP-82 merged | — (WARP-84/85/86 depend on it) |
| **WARP-84** | WARP-83 merged | **WARP-85, WARP-86** |
| **WARP-85** | WARP-83 merged | **WARP-84, WARP-86** |
| **WARP-86** | WARP-83 merged | **WARP-84, WARP-85** |

### 2.2 Agent-level parallelism within a ticket

**QA and UI/UX run concurrently** after Dev pushes. They are independent — QA runs the regression suite; UI/UX inspects the dashboard UI. Manager waits for both before synthesizing.

Spawn them together using `superpowers:dispatching-parallel-agents` semantics. They do not share state.

**Everything else is serial.** Dev must finish before QA starts (there is no branch to review otherwise). Manager must finish before PR opens. CI must finish before Code Reviewer runs.

### 2.3 Stacked branches

For the WARP-84/85/86 fan-out, each branch is off `WARP-83` (not `main`) until WARP-83 merges. After WARP-83 merges to `main`, rebase each child branch onto `main` and re-push before the Manager opens its PR. The QA agent will refuse to run on a branch that won't fast-forward to `main`.

---

## 3. Stuck CI — the ralph-loop

CI has eight workflows: orchestrator-vitest, orchestrator-tsc, dashboard-vitest, dashboard-tsc, routing-pytest, setup-e2e, docker-build, security-tests. When one fails, classify:

| Failure pattern | Category | Action |
|---|---|---|
| `ENOSPC`, `docker pull rate-limited`, cache miss, step timeout, transient network | **Infra flake** | Ralph-loop: retry the failed job up to 2x, stop after 3 total |
| Test assertion failure, TypeScript error, lint error, migration conflict | **Source defect** | Send back to Dev — this is not ralph-loop territory |
| Workflow never starts, GitHub rate-limit, systemic Actions outage | **Systemic** | HANDOFF_TO_HUMAN — do not loop |

### 3.1 Ralph-loop template

Use the `ralph-loop:ralph-loop` skill with this prompt, parameterized by PR number:

```
/loop 5m

You are watching PR #<n> CI. Do:

1. `gh pr checks <n>` — if all green, STOP and report "CI green".
2. If any check FAILED, categorize:
   - ENOSPC / docker-pull / network / cache / timeout → infra flake → continue
   - test failure / tsc error / lint error → source defect → STOP and report
     "SOURCE_DEFECT on <check name>: <one-line diagnostic>. Hand back to Dev."
   - workflow never started or GH outage → STOP and report "SYSTEMIC_CI_OUTAGE".
3. For infra flakes: `gh run rerun <run-id> --failed`. Note the attempt number.
4. If this is the 3rd rerun on the same check (attempts 1+2 already consumed),
   STOP and report "PERSISTENT_INFRA_FLAKE on <check name>. Escalate."
5. Otherwise sleep until next tick.
```

### 3.2 Stop conditions — explicit

The loop auto-stops on:

- **All CI green.** Emit "CI green, PR #<n> ready for Code Reviewer".
- **Source defect.** Emit the diagnostic and hand back to Dev.
- **Systemic outage.** Emit HANDOFF_TO_HUMAN.
- **3 attempts on the same infra flake.** Emit PERSISTENT_INFRA_FLAKE + escalate.

The loop MUST NOT:

- Attempt autonomous code changes.
- Re-run beyond 3 attempts on the same check.
- Run for more than 30 minutes (cap at 6 ticks).

---

## 4. Handoff-to-human triggers

From spec §11.4. Main conversation pauses for the project lead when any of these fire:

| Trigger | Detector | Who raises it |
|---|---|---|
| **Product ambiguity** | AC bullet needs a decision that isn't in spec (e.g. "what's the icon for a Philips Hue hub?", "when a group is deleted, do its devices go to `Ungrouped` or the first alphabetic group?") | Dev (asks before coding) or UI/UX (flags in review) |
| **Systemic CI failure** | Ralph-loop emits `PERSISTENT_INFRA_FLAKE` or `SYSTEMIC_CI_OUTAGE` | Ralph-loop |
| **AC drift mid-execution** | Dev discovers the AC as written is impossible / contradicts spec, OR QA finds an AC bullet has no test and Dev's self-assessment says "skipped" without a spec waiver | Dev (prefer) or QA (detect) |
| **Pre-merge** | Every PR, unconditionally. Human is the final gate. | Controller, after Code Reviewer APPROVE |

### 4.1 What "handoff" means

The controlling session stops invoking agents, posts a summary of where things are, and waits for explicit human direction. No more agent spawning until the human answers.

For the pre-merge handoff, the controller's last action is to confirm CI is green and Code Reviewer has approved, then report:

```
PR #<n> is ready for human merge.
- QA: PASS
- UX: APPROVED (or N/A)
- CI: 8/8 green
- Code Reviewer: APPROVE (or APPROVE_WITH_COMMENTS — see controller summary)
Merge when ready.
```

---

## 5. Per-gate runbook

### 5.1 Dev

```
# Controller
git checkout <branch>
# Invoke Dev agent with:
#   - ticket body (full)
#   - relevant spec sections (inline)
#   - AC (spec §12)
#   - branch name
# Wait for Dev's self-assessment.
```

### 5.2 QA + UI/UX (parallel)

```
# Controller — spawn both as parallel subagents.
# QA input: branch, base, ticket, AC, Dev self-assessment, spec sections
# UI/UX input: branch, base, ticket, spec §8, ADR-002, design-token paths
#              (skip if branch does not touch apps/web-dashboard/)
# Wait for BOTH to return before invoking Manager.
```

### 5.3 Manager

```
# Controller
# Input: ticket, AC, QA report, UX review (or "N/A"), commit list, diff stats
# Manager returns:
#   - READY_FOR_PR → Manager opens PR (QA + UX stay internal — NOT posted as comments; folded into the PR body self-review), return PR number
#   - SEND_BACK_TO_DEV → loop to 5.1 with Manager's note of what to fix
#   - HANDOFF_TO_HUMAN → §4
```

### 5.4 CI

```
# Controller
gh pr checks <n>
# If green immediately → 5.5
# If mixed → §3 ralph-loop
```

### 5.5 Code Reviewer

```
# Controller
# Input: PR diff, spec, AC, QA report, UX review, Manager's PR body Concerns
# Invoke superpowers:code-reviewer wrapper (.superpowers/agents/code-reviewer.md)
# Code Reviewer returns one verdict + findings to the controller (internal artifact — NOT posted to GitHub).
# Controller reads verdict:
#   - APPROVE → §4 pre-merge handoff
#   - APPROVE_WITH_COMMENTS → loop findings back through Dev (fix locally + push), then
#       RE-RUN the Code Reviewer on the new commits. Re-run until the verdict is APPROVE
#       with no new non-trivial findings (or only deferred-to-PR-body items remain).
#       Bound this to 2 re-review rounds; if it hasn't converged by then, HANDOFF_TO_HUMAN
#       (the findings are deeper than a quick local fix — note the harness gap). Only once
#       the Reviewer lands on a clean APPROVE → §4 pre-merge handoff. This guarantees the
#       human reviewer's first sight of the branch is the clean, final PR — not the
#       pre-fix commits.
#   - REQUEST_CHANGES → SEND_BACK_TO_DEV (rare; note harness gap)
```

### 5.6 Human merge

Out of scope. Controller stops.

---

## 6. Artifacts

Every harness run produces:

| Artifact | Location | Retained |
|---|---|---|
| Dev self-assessment | controller transcript | transcript only |
| QA report | controller transcript (internal — not posted to GitHub) | transcript only |
| UX review | controller transcript (internal — not posted to GitHub) | transcript only |
| Manager PR body | PR body | indefinitely |
| Code Reviewer verdict | controller transcript (internal — not posted to GitHub) | transcript only |
| Dry-run traces | `docs/superpowers/harness-runs/WARP-XX-*.md` | committed for first ticket of each phase |

New phases don't require a new dry-run unless the harness itself changes. If the role prompts are edited mid-phase, trigger a fresh dry-run on the next ticket.

> **Internal reviews stay local.** The QA report, UX review, and Code Reviewer verdict are the *publisher's own* internal reviews — they are **never posted as GitHub PR comments**. Non-clean findings are fixed locally (loop back through Dev) and pushed to the branch; only genuinely-deferred items surface in the PR body self-review. What the human reviewer (Romain) sees on GitHub is a clean, final PR — body + code — not a thread of internal-review comments. (Posting a review *to* GitHub is correct only when reviewing *someone else's* PR — external review, per `droplet-pr-sweep` / `droplet-pr-test-review`.)

---

## 7. When the harness itself breaks

If a role prompt produces useless output (e.g. QA ignores the regression suite, UI/UX invents a breakpoint that isn't in the spec), that's a harness bug, not a Dev bug. Fix the prompt file **in the current ticket's branch** — do not kick it to a follow-up.

The WARP-88 dry-run exists precisely to catch these before Phase 1 starts shipping real code.

---

## 8. Backlog-driver loop (unattended sequencing)

§1–§7 describe **one ticket**. The backlog-driver loop runs that sequence across
the whole backlog unattended, via `/loop /backlog-tick` (self-paced — no interval).
The loop adds *cross-ticket sequencing only*; it changes nothing within a ticket.

- **Controller:** `.claude/commands/backlog-tick.md` (one ticket per firing).
- **State:** `.claude/loop-state/{queue.json,run.json,run-log.md}` — gitignored scratch.

**Per tick:** load/seed the queue (hybrid — seed from Jira once, walk it, re-seed on
drain) → select the top ticket whose dependencies are ALL merged to `main` → run the
gate sequence (§1, detailed in §5) → Manager opens the PR → record → continue. The
seed JQL is `status = "To Do" AND issuetype != Epic AND description IS NOT EMPTY` —
epics and unrefined placeholders are kept out of the queue.

**Autonomy boundary:** the loop opens PRs and advances, but **never merges** — the
human merge gate (§4) is unconditional. It only works tickets whose dependencies are
already merged to `main`; it does **not** use branch stacking (§2.3). This
self-throttles: the loop yields a set of independent, mergeable PRs, then stops.

**CI:** watched **inline** inside the tick using the §3 classification table — NOT a
separate nested `/loop`. Same flake/defect/systemic logic, capped at 6 polls /
30 min / 3 attempts per check.

**Stop conditions:** backlog drained · all remaining tickets blocked on a human merge
· a blocker that is Jira-`Done` with no merged PR (ambiguous → handoff, never
auto-satisfied — Jira status alone never satisfies a dependency) · any other §4 hard
handoff · run caps (5 tickets or 4h; reset by removing `.claude/loop-state/run.json`).
Each tick ends with a `LOOP_STATUS: CONTINUE` or `LOOP_STATUS: STOP — <reason>` line.

**Effort/model:** uniform — controller and all five agents inherit the session model
+ reasoning effort (no agent frontmatter pins). Launch the session at Opus + high.

**Design reference:** `docs/superpowers/specs/2026-06-25-backlog-driver-loop-design.md`.
