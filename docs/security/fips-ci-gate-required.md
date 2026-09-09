# The FIPS build-time gate: what it proves, and why it is not a required check

> **Rewritten 2026-08-28 (WARP-2493).** This file used to be an instruction
> sheet titled *"Make the FIPS build-time gate required-to-merge"*, with
> copy-pasteable `gh api` commands to add **`docker-build ok`** to a ruleset.
> **Do not do that.** Following it would hang every out-of-scope PR forever on
> *"Expected — waiting for status to be reported"* (the WARP-2172 trap). The
> commands and the checked-in ruleset JSON they applied have been removed.
>
> The rule that replaces them lives in
> [`docs/ci-required-checks.md`](../ci-required-checks.md) — read that first.

## What the gate is

The build-time FIPS gate runs in **`.github/workflows/docker-build.yml`**:
every shipped image's Dockerfile `RUN`s `docker/fips/install-fips-provider.sh`,
which runs the module KATs (`openssl fipsinstall`), a positive probe (provider
active @ 3.0.9, base+fips both active, SHA-256 works), and a negative probe
(MD5 rejected). Any failure `exit 1`s the docker build, failing the matrix,
which fails the stable fan-in check **`docker-build ok`** (job id
`docker-build-ok`).

That fan-in is correctly built. The gate genuinely proves what it claims.

## Why it does not block a merge

**`docker-build ok` is not a required status check, and it cannot become one
as written.** A required context must come from a workflow that runs on
*every* PR. `docker-build.yml` is path-filtered — to Dockerfiles,
`package*.json`, `requirements*.txt`, `docker/docker-compose.yml`,
`docker/fips/**`, `docker/nginx/**` and friends — so on a PR outside that
filter the workflow never starts, the check never reports, and GitHub renders
the required-but-absent context as *"Expected — waiting for status to be
reported"* forever. The PR cannot merge and no amount of re-running fixes it.

This bites at the `on:` level, not per-job: a stable fan-in *inside* a
path-filtered workflow is still absent when the workflow does not run. See
[`docs/ci-required-checks.md`](../ci-required-checks.md) for the full
statement, the live verification commands, and the current required set
(`ci-summary`, `egress-gate`, `title carries a WARP key`).

## The rule, and the two routes that would work

> **A check blocks a merge only if it is a `ci-summary` leg, or is itself a
> required context.** Everything else is advisory no matter how red it goes.

So if the FIPS build-time gate should block, pick one — both are deliberate
decisions with real cost, not wiring fixes:

1. **Make it a `ci-summary` leg.** This is the preferred shape, and the one
   WARP-2481 and WARP-2493 used for the FIPS static lint, semgrep, gitleaks
   and hadolint. It needs no ruleset change at all. But `ci-summary` cannot
   `needs:` a job in another workflow, so this means relocating the whole
   13-image build matrix — GHCR layer cache, per-image `detect` filters,
   20–60 min runtime — into `ci.yml`. Weigh it against
   [`docs/ci-cost-budget.md`](../ci-cost-budget.md) first.
2. **Give `docker-build.yml` an unfiltered reporting job** that returns green
   when no image is in scope — a real fan-in over `needs`, not an `if:` that
   skips (a skipped job reports as skipped, which satisfies a required check
   without having tested anything). `docker-build ok` then becomes requireable
   and could be added to the rulesets. This is "safe shape 2" in
   `docs/ci-required-checks.md`, and it is the cheaper of the two.

Either way, adding a required context is a human action in repo settings, and
renaming an existing one is the dangerous edit — the ruleset stores the
check-run *name* as a wire contract. `docs/ci-required-checks.md` has the
ordered dance.

## Notes that still hold

- Do **not** require the matrix `build ${{ matrix.image }}` jobs directly —
  the image set is dynamic, so a check that doesn't run on a given PR would
  block it forever. `docker-build ok` is the right fan-in shape; its problem
  is the workflow's trigger, not the job.
- The sabotage proof (`tests/fips-sabotage.test.sh`, run by the
  `fips-sabotage` job in `test-fips.yml`) demonstrates the gate is not a
  no-op. It is a *capability* proof and is deliberately not part of any
  required set.
- The FIPS **static source lint** is a different gate and *does* block, since
  WARP-2481: it is the `fips / static lint` leg of `ci.yml`, aggregated by the
  required `ci-summary`. See [`docs/fips.md`](../fips.md).
