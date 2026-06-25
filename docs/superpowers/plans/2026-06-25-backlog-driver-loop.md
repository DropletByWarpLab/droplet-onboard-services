# Backlog-Driver Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-paced `/loop /backlog-tick` that drives the existing agent harness across the WARP backlog unattended — one ticket per firing, opening PRs but never merging.

**Architecture:** A committed slash command (`.claude/commands/backlog-tick.md`) is the per-tick controller. It adds *cross-ticket sequencing* (seed a Jira queue, select the next ticket whose deps are merged to `main`, run the harness, record, continue) on top of the unchanged within-ticket gates in [`agent-harness.md`](../agent-harness.md). State lives in gitignored scratch files under `.claude/loop-state/`. CI is watched inline inside each tick, not via a nested loop.

**Tech Stack:** Claude Code slash commands (markdown + frontmatter); the five `.claude/agents/` role agents (`droplet-dev`, `-qa`, `-ui-ux`, `-manager`, `-code-reviewer`); Jira (Atlassian) MCP for seeding; `gh` + `git` for dependency/merge checks.

## Global Constraints

Every task implicitly includes these (verbatim from the spec `docs/superpowers/specs/2026-06-25-backlog-driver-loop-design.md` and repo guidelines):

- The loop **NEVER merges a PR**, **NEVER force-pushes** (already denied in `.claude/settings.json`), and **NEVER posts QA/UX/Reviewer verdicts to GitHub** (internal artifacts per agent-harness.md §6).
- The loop **only starts a ticket once all its dependencies are merged to `main`** — verified by content against `main`, not by Jira status. **No branch stacking.**
- **Uniform effort/model**: controller and all five agents inherit the session model + reasoning effort. **No agent frontmatter `model`/`effort` pins.** Launch the session at **Opus 4.8 + high**.
- `.claude/loop-state/` is **gitignored per-run scratch**; the committed dry-run trace is the durable record.
- **Run caps:** stop after **5 tickets** or **4 hours** per run.
- Repo conventions: conventional-commit subjects (`docs(...)`, `feat(...)`, `chore(...)`); **Simplicity first / surgical changes** (CLAUDE.md); every commit message ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- The exact WARP "ready" status name is **validated at first seed, never guessed** (repo "No guessing" rule).

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Create | `.claude/commands/backlog-tick.md` | The per-tick controller prompt — the whole deliverable. One ticket per firing. |
| Modify | `.gitignore` | Ignore `.claude/loop-state/` runtime scratch. |
| Modify | `docs/superpowers/agent-harness.md` | Add §8 documenting the backlog-driver mode alongside the CI ralph-loop (§3). |
| Create | `docs/superpowers/harness-runs/<KEY>-backlog-loop-dryrun.md` | Committed trace of the controller-logic dry-run (Task 3). |
| Runtime only (gitignored, not created by this plan) | `.claude/loop-state/{queue.json,run.json,run-log.md}` | Queue, run-cap counter, append-only audit log. The command creates these at runtime. |

---

### Task 1: The `/backlog-tick` controller command

**Files:**
- Modify: `.gitignore`
- Create: `.claude/commands/backlog-tick.md`

**Interfaces:**
- Consumes: the five agents in `.claude/agents/`; Jira MCP search + issue-link reads; `gh`/`git`.
- Produces: at runtime, `.claude/loop-state/queue.json` (`{ v, seeded_jql, items: [{key, blockers, touchesDashboard, status}] }`), `.claude/loop-state/run.json` (`{ started_at, count }`), `.claude/loop-state/run-log.md` (append-only). Emits a final `LOOP_STATUS: CONTINUE` or `LOOP_STATUS: STOP — <reason>` line per tick.

- [ ] **Step 1: Ignore the runtime scratch dir**

Append to `.gitignore`:

```gitignore

# Backlog-driver loop runtime scratch (queue, run-cap counter, audit log)
.claude/loop-state/
```

- [ ] **Step 2: Verify the ignore rule matches**

Run: `git check-ignore -v .claude/loop-state/queue.json`
Expected: prints a line ending in `.claude/loop-state/` (the matching rule). Exit code 0.

- [ ] **Step 3: Create the controller command**

Create `.claude/commands/backlog-tick.md` with EXACTLY this content:

````markdown
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
- **Seed** via Jira MCP: search the WARP project for ready tickets. Default JQL:
  `project = WARP AND status = "<READY_STATUS>" ORDER BY rank`.
  On the FIRST seed, VALIDATE `<READY_STATUS>` against the live WARP workflow
  (list the project's statuses; choose the one meaning "ready to start") — do not
  assume a name. Record the final JQL in `run-log.md`.
- For each ticket, read its issue links; collect "is blocked by" keys as `blockers`.
  Store `touchesDashboard: null` (resolved later from the branch diff).
- Order topologically by `blockers`; break ties by Jira rank.
- Write `queue.json`:
  `{ "v": 1, "seeded_jql": "<jql>", "items": [ { "key": "...", "blockers": [...], "touchesDashboard": null, "status": "pending" } ] }`
- If the seed returns nothing: print `LOOP_STATUS: STOP — backlog drained` and end.

## Step 3 — Select the next workable ticket
Walk `items` top-down. For the first `pending` ticket, test each blocker: a blocker
is satisfied only when its PR is **merged to `main`** — verify by content, e.g.
`gh pr list --state merged --search "<BLOCKER_KEY>"` and confirm the commits are on
`main`. Do NOT trust Jira status.
- Pick the first ticket whose blockers are ALL satisfied. Set its `status` to
  `in_progress`; persist `queue.json`.
- If NO pending ticket has all blockers satisfied: print
  `LOOP_STATUS: STOP — all remaining tickets blocked on your merge`, then list the
  open PRs already produced (from `run-log.md`), and end.

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
````

- [ ] **Step 4: Verify the command file is well-formed**

Run: `head -3 .claude/commands/backlog-tick.md && grep -c '^## Step' .claude/commands/backlog-tick.md`
Expected: first line is `---`, second line is the `description:` frontmatter; the grep prints `6` (Steps 1–6 present).

- [ ] **Step 5: Commit**

```bash
git add .gitignore .claude/commands/backlog-tick.md
git commit -m "$(cat <<'EOF'
feat(loop): add /backlog-tick controller for unattended backlog driving

One ticket per /loop firing: seed a Jira queue, select the next ticket whose
deps are merged to main, run the agent harness, open the PR (never merge),
record, and emit LOOP_STATUS. Inline bounded CI watch; run caps 5 tickets/4h.
State is gitignored scratch under .claude/loop-state/.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Document the backlog-driver mode in the harness playbook

**Files:**
- Modify: `docs/superpowers/agent-harness.md` (append a new §8)

**Interfaces:**
- Consumes: existing §3 (CI ralph-loop), §4 (handoff triggers), §6 (internal-reviews-stay-local) — referenced, not duplicated.
- Produces: §8 — the canonical doc entry for `/loop /backlog-tick`.

- [ ] **Step 1: Append §8 to the harness doc**

Append to the end of `docs/superpowers/agent-harness.md`:

```markdown

---

## 8. Backlog-driver loop (unattended sequencing)

§1–§7 describe **one ticket**. The backlog-driver loop runs that sequence across
the whole backlog unattended, via `/loop /backlog-tick` (self-paced — no interval).
The loop adds *cross-ticket sequencing only*; it changes nothing within a ticket.

- **Controller:** `.claude/commands/backlog-tick.md` (one ticket per firing).
- **State:** `.claude/loop-state/{queue.json,run.json,run-log.md}` — gitignored scratch.

**Per tick:** load/seed the queue (hybrid — seed from Jira once, walk it, re-seed on
drain) → select the top ticket whose dependencies are ALL merged to `main` → run
§1–§5 gates → Manager opens the PR → record → continue.

**Autonomy boundary:** the loop opens PRs and advances, but **never merges** — the
human merge gate (§4) is unconditional. It only works tickets whose dependencies are
already merged to `main`; it does **not** use branch stacking (§2.3). This
self-throttles: the loop yields a set of independent, mergeable PRs, then stops.

**CI:** watched **inline** inside the tick using the §3 classification table — NOT a
separate nested `/loop`. Same flake/defect/systemic logic, capped at 6 polls /
30 min / 3 attempts per check.

**Stop conditions:** backlog drained · all remaining tickets blocked on a human merge
· any §4 hard handoff · run caps (5 tickets or 4h; reset by removing
`.claude/loop-state/run.json`). Each tick ends with a `LOOP_STATUS: CONTINUE` or
`LOOP_STATUS: STOP — <reason>` line.

**Effort/model:** uniform — controller and all five agents inherit the session model
+ reasoning effort (no agent frontmatter pins). Launch the session at Opus + high.

**Design reference:** `docs/superpowers/specs/2026-06-25-backlog-driver-loop-design.md`.
```

- [ ] **Step 2: Verify the section and its cross-references**

Run: `grep -n '^## 8. Backlog-driver loop' docs/superpowers/agent-harness.md && grep -cE '^## 3\.|^## 4\.|^## 6\.' docs/superpowers/agent-harness.md`
Expected: the §8 heading is found; the second grep prints `3` (the referenced §3/§4/§6 headings all still exist).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/agent-harness.md
git commit -m "$(cat <<'EOF'
docs(superpowers): document the backlog-driver loop in the harness playbook

Add §8 describing /loop /backlog-tick: hybrid queue, open-PR-never-merge
boundary, wait-on-merged-deps, inline CI watch, stop conditions, and uniform
effort. Cross-references existing §3/§4/§6.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Controller-logic dry-run (seed → select → stop)

Validates the **new** logic only — seeding, JQL validation, and dependency-gated
selection — by running Steps 1–3 of the command against live Jira and stopping
**before** Step 4 (no Dev dispatch, no real ticket implemented). The full
single-ticket run is the supervised go-live (handoff note below), not a plan task.

**Files:**
- Create: `docs/superpowers/harness-runs/<KEY>-backlog-loop-dryrun.md` (use the first selected ticket key)

**Interfaces:**
- Consumes: `.claude/commands/backlog-tick.md` (Task 1), Jira MCP, `gh`/`git`.
- Produces: a committed dry-run trace.

- [ ] **Step 1: Run Steps 1–3 of the controller against live Jira**

Manually perform the command's Step 1 (write `run.json`), Step 2 (seed: validate the
WARP "ready" status, search, build `queue.json` with blockers), and Step 3 (select
the first ticket whose blockers are merged to `main`). **Stop before Step 4** — do
not dispatch any agent.

- [ ] **Step 2: Verify the seeded state is well-formed**

Run: `python3 -c "import json;d=json.load(open('.claude/loop-state/queue.json'));assert d['v']==1;assert d['seeded_jql'];assert all({'key','blockers','touchesDashboard','status'} <= set(i) for i in d['items']);print('queue OK:',len(d['items']),'items')"`
Expected: prints `queue OK: <n> items` with no assertion error.

- [ ] **Step 3: Verify selection / stop behavior is correct**

Confirm exactly one of:
- a ticket was moved to `status: "in_progress"` AND every one of its `blockers` has a PR merged to `main` (spot-check with `gh pr list --state merged --search "<BLOCKER_KEY>"`), OR
- the run emitted `LOOP_STATUS: STOP — backlog drained` / `STOP — all remaining tickets blocked on your merge`, and `run-log.md` records why.

Expected: the selected ticket has no unmerged blocker, OR a correct STOP reason is logged. (This is the core correctness gate for the new logic.)

- [ ] **Step 4: Capture the trace**

Create `docs/superpowers/harness-runs/<KEY>-backlog-loop-dryrun.md` with: the validated JQL, the seeded queue (paste `queue.json`), the selection decision (which ticket, which blockers checked, merged-status of each), the emitted `LOOP_STATUS`, and any rough edges found in the command prompt (fix them in `.claude/commands/backlog-tick.md` in this branch per agent-harness.md §7, and note the fix).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/harness-runs/*-backlog-loop-dryrun.md .claude/commands/backlog-tick.md
git commit -m "$(cat <<'EOF'
test(loop): controller-logic dry-run for /backlog-tick

Seed → JQL validation → dependency-gated selection verified against live Jira,
stopping before agent dispatch. Trace committed; any prompt rough edges fixed
in-branch.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Go-live (supervised, not a plan task)

After Task 3 is clean, the first **real** run is the user's, supervised:

1. Set the session to **Opus 4.8 + high**.
2. (Optional) `rm -f .claude/loop-state/run.json` to reset the run caps.
3. Run `/loop /backlog-tick`. Watch the first 1–2 tickets through to `PR_OPEN_READY_FOR_MERGE`, then let it run. Merge PRs as they land to unblock dependents on the next re-seed.

## Self-Review

**1. Spec coverage:**
- Hybrid queue (seed-once/walk/re-seed) → Task 1 Step 3 §2. ✅
- Never-merge / open-PR-and-continue → Global Constraints + Task 1 hard rules + Step 5. ✅
- Wait-on-merged-deps, no stacking → Task 1 §3 + Global Constraints. ✅
- Uniform Opus/high effort, no frontmatter pins → Global Constraints + §8 + Go-live. ✅
- Inline bounded CI watch (not nested loop) → Task 1 §4 Step 4. ✅
- State files + gitignore → Task 1 Steps 1–3; runtime shapes in Interfaces. ✅
- Stop conditions + caps (5/4h) → Task 1 Steps 1,2,3,6. ✅
- agent-harness.md §8 → Task 2. ✅
- Dry-run trace committed → Task 3. ✅ (refined to controller-logic scope; the spec's "one real ready ticket" full run is folded into supervised Go-live, since the within-ticket gates are already validated by WARP-88.)
- Validate-don't-guess "ready" status → Task 1 §2 + Task 3 Step 1. ✅

**2. Placeholder scan:** `<KEY>`, `<READY_STATUS>`, `<n>`, `<reason>`, `<BLOCKER_KEY>` are runtime-resolved tokens with explicit resolution instructions, not unfilled gaps. No "TODO/TBD/handle edge cases." ✅

**3. Type consistency:** `queue.json` keys (`v`, `seeded_jql`, `items[].{key,blockers,touchesDashboard,status}`) and `run.json` keys (`started_at`, `count`) and the `LOOP_STATUS: CONTINUE|STOP — <reason>` contract are identical across Task 1, Task 2 §8, and Task 3's validation. ✅
