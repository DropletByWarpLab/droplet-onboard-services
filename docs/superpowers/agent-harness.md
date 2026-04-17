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
| **CI** | GitHub Actions | PR | 7 workflows green | all green |
| **Code Reviewer** | `.superpowers/agents/code-reviewer.md` | PR diff + spec + QA + UX | single PR comment (APPROVE / APPROVE_WITH_COMMENTS / REQUEST_CHANGES) | Reviewer verdict ≠ REQUEST_CHANGES |
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

CI has seven workflows: orchestrator-vitest, orchestrator-tsc, dashboard-vitest, dashboard-tsc, routing-pytest, setup-e2e, docker-build, security-tests. When one fails, classify:

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
- CI: 7/7 green
- Code Reviewer: APPROVE (or APPROVE_WITH_COMMENTS — see comment)
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
#   - READY_FOR_PR → Manager opens PR, posts QA + UX as comments, return PR number
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
# Code Reviewer posts one comment.
# Controller reads verdict:
#   - APPROVE → §4 pre-merge handoff
#   - APPROVE_WITH_COMMENTS → §4 pre-merge handoff, flag comments in summary
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
| QA report | PR comment | indefinitely (on the PR) |
| UX review | PR comment (if applicable) | indefinitely |
| Manager PR body | PR body | indefinitely |
| Code Reviewer comment | PR review comment | indefinitely |
| Dry-run traces | `docs/superpowers/harness-runs/WARP-XX-*.md` | committed for first ticket of each phase |

New phases don't require a new dry-run unless the harness itself changes. If the role prompts are edited mid-phase, trigger a fresh dry-run on the next ticket.

---

## 7. When the harness itself breaks

If a role prompt produces useless output (e.g. QA ignores the regression suite, UI/UX invents a breakpoint that isn't in the spec), that's a harness bug, not a Dev bug. Fix the prompt file **in the current ticket's branch** — do not kick it to a follow-up.

The WARP-88 dry-run exists precisely to catch these before Phase 1 starts shipping real code.
