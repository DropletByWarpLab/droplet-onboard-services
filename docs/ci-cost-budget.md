# CI cost budget — why the workflows are shaped this way

> **TL;DR for agents:** GitHub Actions has a **hard $100/month spending
> limit** (org-wide, set 2026-07-21). CI was redesigned on that date to fit
> it (PR [#1204](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/1204)).
> Every new workflow, trigger, matrix leg, or widened `paths:` filter is a
> **spend decision, not a style decision**. Before adding one, do the math
> in [Estimating a change](#estimating-the-cost-of-a-ci-change) below. When
> the limit is hit, GitHub **blocks all Actions runs org-wide** — nothing
> merges, the backlog loop stalls. This has happened (2026-07-15 was a
> near-zero CI day for exactly this reason).

## The budget, in minutes

- Runner rate: **$0.006/min** (ubuntu-latest, "Actions Linux" SKU, this
  org's GHEC pricing).
- **50,000 min/month included** with the GHEC plan, then metered.
- $100 limit ⇒ **~66,600 min/month gross ceiling** (50k free + ~16.6k paid).
- Practical target: **stay inside the 50k included minutes** so the paid
  tier is headroom for spikes, not baseline.

## What it looked like before the redesign (measured, 30 days to 2026-07-21)

~**118,000 min/month ≈ $410 net** and climbing. Volume: ~713 PR events +
~371 pushes to main per 30 days (the agent backlog loop). Where the
minutes actually went (billable min = Σ per-job wall time, each job
rounded up to the minute):

| Line item | runs/mo | avg min/run | min/mo |
|---|---:|---:|---:|
| ci.yml on PRs (full 16-job matrix, every PR) | 713 | ~44 | ~31,000 |
| ci.yml on main pushes | 371 | ~17 | ~6,300 |
| docker-build pushes (all 13 images every merge) | 264 | ~28 | ~7,500 |
| setup-e2e PRs (fired on nearly every backend PR) | 328 | ~21 | ~6,800 |
| web-dashboard-tests (PR+push, duplicate of ci leg) | 614 | ~12 | ~7,200 |
| orchestrator-tests (PR+push, mostly duplicate) | 744 | ~7 | ~5,200 |
| test-fips (fips-sabotage compile on every code PR) | ~1,385 | ~5.6 | ~7,800 |
| publish-release (never succeeded — see below) | 396 | 0–120 | wasted |
| everything else (linters, small suites) | — | ~1–4 | ~12,000 |

The two structural sins: **(1) duplication** — ci.yml ran every suite on
every PR *and* the per-service workflows ran the same suites again
(the retire-the-duplicates follow-up written in ci.yml's header at
WARP-1007 time was never executed); **(2) unconditional heavyweights** —
publish-release built + pushed all 13 images with no layer cache on every
merge and then **failed at the cosign sign step by design** (the key
ceremony hasn't run), ~400 doomed runs/month.

## The redesign (2026-07-21, PR #1204)

1. **ci.yml is path-aware on PRs.** A `detect` job (dorny/paths-filter +
   dynamic matrices — the pattern docker-build's `detect` established)
   runs only the legs whose paths changed. `ci-summary` stays the single
   always-reporting required check and **fails closed**: a skipped leg
   passes only when `detect` succeeded AND emitted `[]` for that leg's
   suite list. Main pushes/dispatches always run the full matrix (the
   post-merge canary that keeps the green-main record honest).
2. **The 13 per-service workflows that exactly mirror ci.yml legs have no
   `pull_request` trigger** (ai-gateway, camera-discovery,
   device-identity-svc, email-indexer, file-indexer, fleet-agent,
   matter-controller, mcp-server, ops-console, routing, switch, voice-io,
   web-dashboard). They keep push-to-main (+ dispatch) as an independent
   post-merge canary and to satisfy `scripts/check-ci-coverage.sh`.
   `orchestrator-tests.yml` is the exception: it keeps its PR trigger but
   contains ONLY the pg-integration lane (real Postgres — no ci.yml leg
   covers that); its duplicated unit job was deleted.
3. **publish-release.yml is `workflow_dispatch`-only** until the key
   ceremony provisions the cosign secrets. Publishing is a deliberate
   act, run from a sha that is already green on ci-summary.
4. **docker-build pushes build only affected images** (a GHCR layer cache
   only goes stale when its own build inputs change), with a weekly
   scheduled full rebuild (Sat 02:23 UTC) as the heal-all + full-fleet
   Trivy sweep. PR runs read the cache, never write it.
5. **setup-e2e no longer triggers on `apps/orchestrator/**`** (tsc breaks
   → ci.yml orchestrator leg; run-stage COPY breaks → docker-build's
   WARP-1246 smoke-boot). A nightly run (03:47 UTC) covers the residual
   "orchestrator change breaks the setup.sh flow" class within 24h.
6. **test-fips gates the fips-sabotage OpenSSL compile** on the same
   FIPS-option paths as fips-stack; only `fips-lint` (static, ~2 min)
   ran on every code PR.
   *Superseded 2026-08-28 (WARP-2481):* `fips-lint` moved into `ci.yml` as
   the `fips` leg (same `paths:`, so its own cost is unchanged), and
   `test-fips.yml`'s trigger `paths:` were narrowed from the lint's broad
   list to the FIPS-option paths the two remaining Docker jobs actually
   gate on. Those two jobs used to spin up a runner and no-op (6–11 s each,
   but billing rounds up: 2 min/event) on ~91% of PRs and 271 of 293
   monthly main pushes. Net: **~-1,600 min/mo**.

Modeled result at the same cadence: **~40k min/month** — inside the
included tier, headroom to ~1.6× today's PR volume.

## Rules for future CI changes (the point of this doc)

- **Do not re-add `pull_request:` triggers to the 13 mirrored per-service
  workflows.** PR-time coverage lives in ci.yml's legs. If you think a PR
  trigger is missing, the fix is a ci.yml `detect` filter entry, not a
  second workflow run.
- **Adding a new service** (`check-ci-coverage.sh` will make you): give it
  a ci.yml leg — a filter entry in `detect` AND a matrix entry in the plan
  step — plus a `<name>-tests.yml` with **push-to-main + dispatch only**,
  copying any retired-trigger sibling (e.g. `switch-tests.yml`).
- **Never add an unfiltered `pull_request:` trigger** to any job heavier
  than ~1 min. The only every-PR workflows are the ~1-min hygiene checks
  (egress-gate, ci-coverage, codeql-trigger)
  and ci.yml's detect+summary. That list is closed — extending it is a
  budget decision for Romain. (`semgrep` left this list in WARP-2481, and
  `gitleaks` + `hadolint` in WARP-2493: all three are now *legs* of ci.yml.
  semgrep and gitleaks stayed unfiltered — same trigger set, same billable
  minute, spend unchanged, they just block merges now. hadolint gained a
  `detect` filter on Dockerfiles + .hadolint.yaml, which is a **saving**:
  its verdict is a pure function of those files, so a PR touching neither
  could only re-report the base branch's result.)
- **Widening a `paths:` list on docker-build / setup-e2e / test-fips is a
  spend decision.** These are the 20–60-min jobs; a glob like
  `apps/orchestrator/**` or `services/**` puts them on ~half of all PRs.
  Estimate first (below), and say the number in the PR description.
- **Do not put publish-release back on `push:` before the key ceremony.**
  After the ceremony, re-enabling per-merge (or tag) publishing must also
  drop its inline gate jobs in favor of the ci-summary result for the
  same sha (the WARP-536 follow-up).
- **Don't "fix" a flaky suite by re-running it on more triggers.** Fix the
  flake; reruns are minutes.
- **Scheduled jobs are cheap but not free** — the nightly setup-e2e is
  ~650 min/mo, the weekly docker-build full rebuild ~400 min/mo. A new
  cron entry needs the same math.
- **ci.yml's fail-closed contract is load-bearing.** If you touch detect /
  the leg matrices / ci-summary, preserve: (a) summary reports on every
  PR, (b) a skip passes only with a proven-empty suite list, (c) main
  pushes run everything. Breaking (b) silently un-gates merges; breaking
  (a) hangs every PR on "Expected".

## Estimating the cost of a CI change

```
min/month = (PR runs/mo it will trigger × avg billable min)
          + (main-push runs/mo × avg billable min)
          + (scheduled runs/mo × avg billable min)
```

Current cadence numbers to plug in: ~700 PR events and ~370 main pushes
per month; a path-filtered trigger fires on the fraction of PRs touching
those paths (check 30-day history, see below). Billable minutes = sum of
each job's wall time rounded **up** per job — a 10-leg matrix of 40-second
jobs bills 10 minutes, not 7. As a sanity bar: anything adding
**>2,000 min/month (~$12)** needs an explicit callout in the PR
description; anything adding >5,000 needs Romain's sign-off.

Measuring reality (the APIs lie in specific ways):

- Per-repo daily spend: `gh api '/organizations/DropletByWarpLab/settings/billing/usage?year=YYYY&month=M'`
  — use the **daily** grain; the monthly rollup can attribute one repo's
  usage to another (it once booked this repo's 83k minutes to
  droplet-fleet-hq).
- Run counts: the runs-list API silently caps at 1,000 results — use
  `/actions/workflows/{id}/runs?created=>=DATE&per_page=1` and read
  `.total_count` per workflow instead.
- Per-run cost: the `/timing` endpoint's `billable` field is dead (new
  billing platform) — list the run's jobs and sum
  `ceil((completed_at − started_at)/60s)`.

## If the budget is hit anyway

The levers, in order: (1) lower the backlog-loop cadence — spend scales
linearly with PR/merge volume; (2) temporarily dispatch-only the heavy
non-required workflows (setup-e2e, test-fips, docker-build PR builds) —
`storage-pool-tests` shows the precedent and the cost: it sat
dispatch-only through an earlier minutes drought and its suites rotted;
(3) ask Romain before raising the limit. Never quietly disable required
checks (ci-summary, egress-gate).
