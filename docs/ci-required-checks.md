# Required status checks — the ruleset ↔ workflow contract

Branch protection on this repo lives in two **repository rulesets**, not in
classic branch protection and not in any org-level ruleset. A ruleset names
each gate by the **check-run name string**. Nothing in GitHub validates that
such a check exists, so a listed context whose workflow was renamed, deleted,
or never merged sits there looking like a gate and enforcing nothing.

That has happened twice on this repo (WARP-2167, WARP-2171). The mirror-image
failure — a gate that runs, reports red, and blocks nothing because no ruleset
names it — happened a third time with `fips-lint` and `semgrep` (WARP-2481).
This file is the inventory that makes the next drift visible without an API
call.

> **WARP-229 history, corrected.** `test-fips.yml`'s header called the FIPS
> static lint "PR-BLOCKING" from 2026-05-10. It never was: `fips-lint` was
> never a required context and, living in a path-filtered workflow, could not
> become one. The claim became true on 2026-08-28 (WARP-2481) when the lint
> moved into `ci.yml` and its verdict started reaching branch protection
> through `ci-summary`.

## What is required today

Verified 2026-08-24 against the live rulesets and against real PR heads
(#1729, `base=stage`, open; #1690, `base=stage`, merged).

### `Stage Protection` — ruleset id 20877684, `refs/heads/stage`

| required context | emitted by | reports on every PR? |
| --- | --- | --- |
| `ci-summary` | `ci.yml`, job `ci-summary` | yes — `if: always()`, `needs` every leg, fails unless all legs pass. Designed to be the one always-reporting check (WARP-1007). Aggregates: `node`, `python`, `storage`, `fips`, `semgrep`. |
| `egress-gate` | `egress-gate.yml`, job `egress-gate` | yes — unfiltered `pull_request:`, ~15 s job, kept unfiltered precisely so it can be required (WARP-269/968/969). |
| `title carries a WARP key` | `pr-title-ticket-lint.yml`, job `title-carries-ticket` | yes — unfiltered `pull_request:`, no checkout. |

### `Main Protection` — ruleset id 14884851, `~DEFAULT_BRANCH`

| required context | emitted by | reports on every PR? |
| --- | --- | --- |
| `ci-summary` | `ci.yml` | yes — same fan-in as above |
| `egress-gate` | `egress-gate.yml` | yes |

`main` only ever receives promotion PRs whose head is `stage`. The title lint
exempts those by design (`head.ref in (stage, main)`), so requiring it here
would add a context that always passes trivially — deliberately not listed.

## What reaches branch protection through `ci-summary`

Three contexts are required, but they are not the whole enforced surface —
`ci-summary` is a fan-in, so every leg it `needs` is merge-blocking without
being named in a ruleset. Legs today:

| leg (job id) | check name | gating |
| --- | --- | --- |
| `node` | `node / <suite>` | `detect` path filter |
| `python` | `python / <service>` | `detect` path filter |
| `storage` | `storage / shell unit tests` | `detect` path filter |
| `fips` | `fips / static lint` | `detect` path filter (WARP-2481) |
| `semgrep` | `semgrep / diff-aware SAST` | **unfiltered — runs on every PR** (WARP-2481) |

**Adding a leg to `ci.yml` changes what blocks a merge.** That is the intended
mechanism, and it is why the leg list is not a style choice: `ci-summary` is
only as honest as the surface it aggregates, and it fails closed — a leg may
report `skipped` only when `detect` proved its suite list `[]`.

`semgrep` is passed a hard-coded non-empty suite list, so "skipped" can never
be read as "nothing to do" for it.

### The WARP-2481 correction

Until 2026-08-28 `fips-lint` (`test-fips.yml`) and `semgrep` (`semgrep.yml`)
each lived in their own workflow, and **neither blocked anything**. Both went
red, the merge went through. Demonstrated on PR #1815: `fips-lint` red with 3
violations, `semgrep` red with 1, `CodeQL` red with 2 high — while
`ci-summary`, `egress-gate` and `title carries a WARP key`, the only three
required contexts, were all green. One approval would have merged it.

The fix was not to require those contexts — `test-fips.yml` is path-filtered,
so requiring `fips-lint` would hang every out-of-filter PR on "Expected"
forever (see the next section). Both were moved into `ci.yml` as legs, which
needed **no ruleset change and no new required context**.

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
`CodeQL`, `gitleaks`, `hadolint`, `ci-coverage`, `docker-build ok`, and the
per-service `*-tests.yml` workflows are advisory. Most are path-filtered, so
requiring them as-is would hit the trap above. `docs/SECURITY.md` and
`codeql.yml` claimed CodeQL was merge-blocking via a ruleset `code_scanning`
rule; no such rule exists on either ruleset (corrected under WARP-2167).
Whether any of them *should* block is a live decision — make it deliberately,
and update this table in the same change.

`semgrep` was on this list until WARP-2481 and is no longer: it is now the
`semgrep / diff-aware SAST` leg of `ci.yml` and blocks through `ci-summary`.

### CodeQL is advisory and **cannot** be folded into `ci-summary` {#codeql}

Verified 2026-08-28, and this is *not* the reason WARP-2481 anticipated.
CodeQL here is a first-party workflow (`.github/workflows/codeql.yml`,
advanced setup — GitHub's default setup is `not-configured`, confirmed via
`gh api .../code-scanning/default-setup`). So "it is default setup, hands off"
is **false**. Folding it still does not work, for a stronger reason:

> **The alert signal is not the workflow job's exit status.** The three
> `codeql / *` jobs succeed as long as the SARIF uploads. The check that goes
> red on new alerts is a separate check-run named plain **`CodeQL`**, produced
> by GitHub's code-scanning service from that SARIF.

On PR #1815 the evidence is unambiguous:

```
failure   CodeQL                            <- the code-scanning verdict
success   codeql / javascript-typescript    <- the workflow jobs, all green
success   codeql / python
success   codeql / actions
```

Fanning the three jobs into `ci-summary` would therefore aggregate three jobs
that were **green on the very PR where CodeQL found 2 high-severity alerts** —
pure cost, zero enforcement, and a fan-in that looks like a gate. Requiring the
`CodeQL` check-run directly is also unsafe: `codeql.yml` is path-filtered, so
on a PR outside its filter it never reports and hits the "Expected" trap above.

**Therefore: CodeQL findings are advisory and are cleared by human review.** A
reviewer is expected to read the Security tab / the PR's code-scanning
annotations and either fix or consciously accept each new alert. Making CodeQL
genuinely merge-blocking needs a different mechanism (an unfiltered wrapper
workflow that polls the code-scanning API for the head sha and fans in, or a
`code_scanning` ruleset rule) and is a deliberate decision, not a side effect
of this file.
