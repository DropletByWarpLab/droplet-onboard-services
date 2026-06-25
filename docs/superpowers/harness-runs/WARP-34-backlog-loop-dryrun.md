# Backlog-loop controller dry-run — WARP-34

**Date:** 2026-06-25  
**Branch:** WARP/flamboyant-darwin-99b92b  
**Scope:** Steps 1–3 of `/backlog-tick` against live Jira. Stopped before Step 4 (no agent dispatch).

---

## Validated JQL

Status validation method: called `getTransitionsForJiraIssue(WARP-911)` to enumerate all live WARP workflow statuses.

| Status name     | Status ID | Category         |
|-----------------|-----------|------------------|
| **To Do**       | 10000     | new (blue-gray)  |
| In Progress     | 10001     | indeterminate    |
| In Review       | 10002     | indeterminate    |
| Hardware Test   | 10003     | indeterminate    |
| Done            | 10004     | done             |

**"To Do"** is the sole `statusCategory.key == "new"` status — the initial/backlog state and the only one meaning "ready to start". Cross-confirmed: 20 most-recent WARP issues sampled by `created DESC` were all "To Do".

**Final JQL used:**
```
project = WARP AND status = "To Do" ORDER BY rank
```

---

## Step 1 — Run-cap bookkeeping

- `run.json` was absent → new run.
- Wrote `{ "started_at": "2026-06-25T19:18:39Z", "count": 0 }`.
- Cap checks: count (0) < 5 ✓, elapsed < 4h ✓ → proceed.

---

## Step 2 — Seed

- API fetched 6 paginated pages (50 issues/page), 295 unique issues total (`hasNextPage` still true after page 6 — see rough edge #3 below).
- Blocker extraction: `issuelinks[].type.inward == "is blocked by"` (Jira link type `Blocks`, id=10000).
- Results: 240 unblocked, 55 blocked.
- Topological order: rank order preserved (rank already respects most dependencies; blocked tickets appear after their blockers in rank).

### Seeded `queue.json` (condensed — first 10 + representative blocked items)

```json
{
  "v": 1,
  "seeded_jql": "project = WARP AND status = \"To Do\" ORDER BY rank",
  "items": [
    { "key": "WARP-34",  "blockers": [], "touchesDashboard": null, "status": "in_progress" },
    { "key": "WARP-26",  "blockers": [], "touchesDashboard": null, "status": "pending" },
    { "key": "WARP-27",  "blockers": [], "touchesDashboard": null, "status": "pending" },
    { "key": "WARP-28",  "blockers": [], "touchesDashboard": null, "status": "pending" },
    { "key": "WARP-29",  "blockers": [], "touchesDashboard": null, "status": "pending" },
    { "key": "WARP-100", "blockers": [], "touchesDashboard": null, "status": "pending" },
    { "key": "WARP-101", "blockers": [], "touchesDashboard": null, "status": "pending" },
    { "key": "WARP-102", "blockers": [], "touchesDashboard": null, "status": "pending" },
    { "key": "WARP-103", "blockers": [], "touchesDashboard": null, "status": "pending" },
    { "key": "WARP-104", "blockers": [], "touchesDashboard": null, "status": "pending" },
    "... (285 more items) ...",
    { "key": "WARP-231", "blockers": ["WARP-230"], "touchesDashboard": null, "status": "pending" },
    { "key": "WARP-232", "blockers": ["WARP-231"], "touchesDashboard": null, "status": "pending" },
    { "key": "WARP-438", "blockers": ["WARP-436", "WARP-437"], "touchesDashboard": null, "status": "pending" }
  ]
}
```

**Well-formed check (brief Step 2):**
```
python3 -c "import json;d=json.load(open('.claude/loop-state/queue.json'));assert d['v']==1;assert d['seeded_jql'];assert all({'key','blockers','touchesDashboard','status'} <= set(i) for i in d['items']);print('queue OK:',len(d['items']),'items')"
```
Output: **`queue OK: 295 items`** — no assertion error.

---

## Step 3 — Selection decision

Walking `items` top-down for first `pending` ticket with all blockers satisfied.

| Ticket | Blockers | PR check | Result |
|--------|----------|----------|--------|
| **WARP-34** | `[]` | N/A (no blockers) | **SELECTED** ✓ |

**WARP-34 summary:** "Create VPN tunnel to give access to files to exterior users"  
**Status in Jira:** To Do  
**Blockers:** none  
**PR check:** `gh pr list --state merged --search "WARP-34"` → no results (expected — ticket not yet started)

→ Set `status: "in_progress"` in `queue.json` for WARP-34.

---

## LOOP_STATUS

```
LOOP_STATUS: [DRY-RUN STOP — Step 4 not dispatched]
```

In a live run, this tick would continue with:
```
LOOP_STATUS: CONTINUE
```
and dispatch `droplet-dev` for WARP-34.

---

## WARP-230 / WARP-231 dependency spot-check

WARP-231 is blocked by WARP-230 ("TPM 2.0-sealed device identity").  
- Jira status of WARP-230: **Done**  
- `gh pr list --state merged --search "WARP-230"` → **no results**

This surfaces rough edge #2 (see below): the command says "verify by content, e.g. `gh pr list --state merged`" but hardware/infrastructure tickets sometimes close without PRs. WARP-231 would be incorrectly gated if the controller only checks for a merged PR. The fix is noted.

---

## Rough edges found in `.claude/commands/backlog-tick.md`

### Bug 1 — Missing guard: null description on top-ranked ticket
**Ticket:** WARP-34 (top-ranked, selected)  
**Problem:** WARP-34 has `description: null` in Jira. Step 4 says "Fetch the ticket body + AC from Jira" and dispatches `droplet-dev` with "the ticket body + AC". A null description would cause the Dev agent to hallucinate scope or fail.  
**Fix applied in-branch:** Added a guard to Step 3 (selection) that skips tickets with no description and logs why. See the diff in `backlog-tick.md`.

### Rough edge 2 — Blocker satisfaction: no-PR "Done" tickets
**Problem:** Step 3 says a blocker is satisfied only when "its PR is **merged to `main`**". WARP-230 is Done in Jira but has no merged PR (hardware/infrastructure work done outside the PR flow). The strict PR check would permanently block WARP-231.  
**Recommendation (SUPERSEDED):** ~~Fall back to `Jira status == "Done"` when no merged PR exists.~~

> **RESOLUTION — REJECTED (commit `1ded212b`, spec §11.2).** Auto-satisfying a
> blocker from Jira status violates the binding rule "verify against `main`, never
> trust Jira status." Shipped behavior instead: a Jira-`Done` blocker with no merged
> PR is **ambiguous** — the loop STOPs with a handoff so the human confirms before the
> dependent starts. It never auto-satisfies and never silently skips the dependent.

### Rough edge 3 — Pagination not mentioned in Step 2
**Problem:** Step 2 says "search the WARP project for ready tickets" with no mention of pagination. Live WARP has 295+ "To Do" tickets requiring 6 API pages. A controller that assumes a single response would silently truncate the queue.  
**Recommendation:** Add a note to Step 2: "paginate until `hasNextPage == false`, accumulating all results." Not a code change in the command file — just a documentation gap.

---

## Fixes shipped to `backlog-tick.md` (final — commit `1ded212b`)

- **Bug 1 (null description):** Step 3 skips empty-description tickets and logs a
  `SKIPPED` note; the seed JQL (Step 2) also excludes them (`description IS NOT EMPTY`)
  and epics (`issuetype != Epic`).
- **Rough edge 2 (Done-without-PR blocker):** resolved as a **handoff**, NOT an
  auto-satisfy — see the REJECTED resolution above and spec §11.2.
- **Rough edge 3 (pagination):** Step 2 now paginates until `hasNextPage == false`.

See commits `22293466` (dry-run) and `1ded212b` (post-dry-run fixes) for the diffs.
