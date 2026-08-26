# Required status checks — the ruleset ↔ workflow contract

Branch protection on this repo lives in two **repository rulesets**, not in
classic branch protection and not in any org-level ruleset. A ruleset names
each gate by the **check-run name string**. Nothing in GitHub validates that
such a check exists, so a listed context whose workflow was renamed, deleted,
or never merged sits there looking like a gate and enforcing nothing.

That has happened twice on this repo (WARP-2167, WARP-2171). This file is the
inventory that makes the next drift visible without an API call.

## What is required today

Verified 2026-08-24 against the live rulesets and against real PR heads
(#1729, `base=stage`, open; #1690, `base=stage`, merged).

### `Stage Protection` — ruleset id 20877684, `refs/heads/stage`

> **STALE as of 2026-08-26 (WARP-2187).** `stage` was deleted deliberately and
> `branch-flow-guard` retired with it, but this ruleset is **still active** and
> still targets `refs/heads/stage`. It now guards a ref that cannot exist, so it
> gates nothing. Deleting a ruleset is a repo-admin action rather than a file
> change, so it is tracked on WARP-2187 rather than done here. The contexts below
> are recorded as they stand, not as a recommendation.

| required context | emitted by | reports on every PR? |
| --- | --- | --- |
| `ci-summary` | `ci.yml`, job `ci-summary` | yes — `if: always()`, `needs` every leg, fails unless all legs pass. Designed to be the one always-reporting check (WARP-1007). |
| `egress-gate` | `egress-gate.yml`, job `egress-gate` | yes — unfiltered `pull_request:`, ~15 s job, kept unfiltered precisely so it can be required (WARP-269/968/969). |
| `title carries a WARP key` | `pr-title-ticket-lint.yml`, job `title-carries-ticket` | yes — unfiltered `pull_request:`, no checkout. |

### `Main Protection` — ruleset id 14884851, `~DEFAULT_BRANCH`

| required context | emitted by | reports on every PR? |
| --- | --- | --- |
| `ci-summary` | `ci.yml` | yes |
| `egress-gate` | `egress-gate.yml` | yes |

Until 2026-08-26 `main` only ever received promotion PRs whose head was
`stage`, and the title lint exempts those by design (`head.ref in (stage,
main)`) — so requiring it here would have added a context that always passed
trivially, and it was deliberately not listed.

**That reasoning expired with the branch (WARP-2187).** `main` now receives
feature PRs directly, and those are exactly the PRs the title lint is meant to
catch — so `title carries a WARP key` is currently a gate that RUNS on every
feature PR into `main` and is REQUIRED on none of them. The job qualifies under
the rule below (unfiltered `pull_request:`, no checkout), so adding it to `Main
Protection` is safe whenever someone with admin decides to. Open on WARP-2187.

## The rule for adding a required context

**A required context must come from a workflow that runs on every PR.**

A path-filtered workflow does not report on a PR outside its filter, and
GitHub renders a required-but-absent context as *"Expected — waiting for
status to be reported"* forever. The PR cannot merge and no amount of
re-running fixes it.

This bites at the `on:` level, not just per-job. A stable fan-in job inside a
path-filtered workflow is **not** always present — the whole workflow never
starts. `docker-build ok` (`docker-build.yml`) is exactly this shape: it is a
correct fan-in for a dynamic matrix, but `docker-build.yml` is path-filtered
to Dockerfiles, `package*.json`, `requirements*.txt`, `docker/docker-compose.yml`,
`docker/fips/**` and `docker/nginx/**`, so it is absent from #1729 and present
on #1690. It is **not** requireable as written — see WARP-2172, which also
covers `docs/security/fips-ci-gate-required.md` still instructing otherwise.

The two safe shapes:

1. Make the work a leg of `ci.yml` so its result lands in `ci-summary`. No new
   context, no new trap. Preferred.
2. Give the gate its own unfiltered workflow whose job reports green when the
   change is out of scope — a real fan-in over `needs`, not an `if:` that
   skips (a skipped job reports as skipped, which satisfies a required check
   without having tested anything).

## Renaming is the dangerous edit

The ruleset matches the job's `name:`, not its id. Renaming a required job
does not loosen the gate — it deadlocks every open PR, including the PR
carrying the rename. The ordered dance:

1. Add the new name as a required context alongside the old one.
2. Land the workflow change; confirm both contexts report green on a PR.
3. Drop the old context from the ruleset.

Adding a context is safe. Renaming or removing one is not.

## Verifying

```bash
# what the rulesets require
gh api repos/DropletByWarpLab/droplet-onboard-services/rulesets   --jq '.[] | {id, name}'
gh api repos/DropletByWarpLab/droplet-onboard-services/rulesets/20877684   --jq '.rules[] | select(.type=="required_status_checks")
         | .parameters.required_status_checks[].context'

# everything that actually reported on a PR head
gh api "repos/DropletByWarpLab/droplet-onboard-services/commits/$(
  gh pr view <n> -R DropletByWarpLab/droplet-onboard-services     --json headRefOid --jq .headRefOid)/check-runs?per_page=100"   --jq '.check_runs[].name' | sort -u
```

Every context from the first command must appear in the second. Two traps
when reading the result:

- `GET /commits/<sha>/status` is the **legacy commit-status** API. Every gate
  here emits check *runs*, so that endpoint returns
  `{"state":"pending","statuses":[]}` even when all gates are green. Use
  `/check-runs`.
- **"It merged" is not evidence a gate works.** Both rulesets carry
  `bypass_actors: [{actor_type: OrganizationAdmin, bypass_mode: always}]`, so
  org admins merge straight through a context that never reports. WARP-2171's
  broken gate survived from 2026-08-16 to 2026-08-24 for exactly this reason,
  while #1687, #1689 and #1693 all merged over it.

## Not required, and why

`codeql / javascript-typescript`, `codeql / python`, `codeql / actions`,
`semgrep`, `gitleaks`, `hadolint`, `ci-coverage`, `docker-build ok`, and the
per-service `*-tests.yml` workflows are advisory. Most are path-filtered, so
requiring them as-is would hit the trap above. `docs/SECURITY.md` and
`codeql.yml` claimed CodeQL was merge-blocking via a ruleset `code_scanning`
rule; no such rule exists on either ruleset (corrected under WARP-2167).
Whether any of them *should* block is a live decision — make it deliberately,
and update this table in the same change.
