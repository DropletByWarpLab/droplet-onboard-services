---
name: preflight
description: |
  PR-readiness check for this monorepo. Use before opening or updating
  any PR, before calling a change "ready", when deciding whether a
  local or CI test failure is yours or a known pre-existing baseline
  red, or when a Python service venv won't build (pydantic-core /
  cryptography on Python 3.14).
---

# Preflight — PR readiness check

Verify a change is genuinely ready for review. CI **does** have tsc
gates now (WARP-1011/WARP-1296) but still **no eslint gate**, and its
legs are **path-aware** — a diff that maps to no leg is typechecked by
nothing. `main` also has known reds. Green-looking CI still proves less
than it seems, just for a different reason than it used to. A PR is
finished when it is **ready for Romain's one-click approval** — never
merged by an agent.

## 1. Scope the change

`git diff --stat <base>...HEAD` — list touched workspaces; run only the
affected suites below. **Fresh worktree?** Run `npm install` and build
the five `@droplet/*` packages (`shared-types`, `tools-core`,
`fips-selftest`, `auth-policy`, `erp-connector` — that last one lives
under `services/`, not `packages/`) first, or tsc/vitest fail on
missing workspace builds. (A ready-built shared worktree may exist
under `.claude/worktrees/` — check before paying that cost.)

**Worktree with NO `node_modules` of its own** (resolution falls
through to the root checkout's install): do **not** full-`npm install`
inside the worktree — the competing local tree shadows the root one and
breaks Vite/vitest resolution. Equally, do **not** symlink the root's
`node_modules` wholesale: a workspace package that exists only on your
branch line then resolves into the **root checkout**, which is often on
a long-stale branch — silently testing the wrong code. Not theoretical:
it took one orchestrator run from 1 failed file to **31**, all
`@droplet/erp-connector` collection failures. The sparse tree below
avoids it because every link points at the *worktree's own* packages.
If the root checkout's install predates
deps your branch needs (symptoms: `TS2307 Cannot find module
'@droplet/erp-connector'` — the package is real, its types resolve from
`dist/` — and/or phantom Prisma-drift errors such as `VpnPeer.kind`
missing), bootstrap a **sparse** worktree `node_modules` instead of
touching the root checkout:

```bash
WT=<worktree-root>; MAIN=<root-checkout>
mkdir -p "$WT/node_modules/@droplet"
ln -sfn ../../services/erp-connector "$WT/node_modules/@droplet/erp-connector"
(cd "$WT/services/erp-connector" && npx tsc)           # build dist/ (what CI does pre-typecheck)
cp -R "$MAIN/node_modules/@prisma/client" "$WT/node_modules/@prisma/client"
(cd "$WT/apps/orchestrator" && npx prisma generate)    # now writes $WT/node_modules/.prisma
git -C "$WT" restore apps/orchestrator/package.json package-lock.json
```

Node walks past per-package misses up to the root, so a sparse tree
shadows nothing — extend the same pattern (symlink + build) to any
other workspace dep the root install is missing. Order matters: copy
`@prisma/client` BEFORE generating, or `prisma generate` resolves the
root checkout's client and writes into the ROOT install; the final
`git restore` drops the `@prisma/client` version bump that
`prisma generate` auto-writes into package.json + lockfile when the
CLI is newer than the declared range.

## 2. Typecheck (any TS change)

```bash
npm run bootstrap                              # prisma generate + the five leaf builds
cd apps/orchestrator && npx tsc --noEmit
```

`npm run bootstrap` FIRST (WARP-2620) — it generates the Prisma client and
builds the leaf workspaces that resolve through `dist/`. A stale or
placeholder client produces phantom scene-schedule `timezone`/`systemFlag`
type errors and `TS7031`s in `tools-core`; unbuilt leaves produce `TS2305`/
`TS2724` from `@droplet/erp-connector` and `Failed to resolve entry for
package "@droplet/fips-selftest"`. `npm run bootstrap:check` says in one line
whether the tree is bootstrapped. Repeat `npx tsc --noEmit` in web-dashboard /
packages if touched.

CI typechecks too, as steps inside ci.yml's path-aware legs:

| Leg | Compile-time gate |
|---|---|
| orchestrator | `npm run -w @droplet/orchestrator typecheck` (WARP-1011) |
| web-dashboard | `npx tsc --noEmit`, then `next build` (WARP-1296) |
| matter-controller | `npm run -w @droplet/matter-controller build` — build IS the typecheck |
| tools-core-mcp-server, erp-connector | workspace `build` (tsc) runs before `test` |

Still absent: any **eslint** gate, and any `turbo run typecheck` task.
The dashboard's only lint is `scripts/check-dashboard-classes.sh`
(WARP-288, Tailwind classes); hadolint and the FIPS lint cover
Dockerfiles and crypto sources, not TS.

**The catch is `detect`.** A leg runs only when the PR touches its
declared paths (`.github/workflows/ci.yml` → `detect.filters`). Useful
fan-outs: `package.json`/`package-lock.json` trigger *every* node leg;
`packages/shared-types/**` and `packages/auth-policy/**` trigger both
orchestrator and dashboard. But a diff matching **no** filter gets no
typecheck at all. Run tsc locally when your change doesn't clearly map
to a leg — or when you'd rather not wait 20 minutes to find out.

## 3. Run the affected suites

| Touched | Command (from repo root) | Known local baseline (don't chase) |
|---|---|---|
| apps/orchestrator | `npm run test:orchestrator` | 1 env failure: `mcp-client.service.test.ts` (spawns stdio subprocess; green in CI) |
| apps/web-dashboard | `npm run test:dashboard` | ~26-37 env failures in 9-10 files locally (`localStorage` undefined, auth re-probe, `tour.*`, `setup.finish-persist`, `WizardThemeToggle`; all green in CI) — compare via patch/replay (§4); single-file runs are reliable. Use the script, not a bare root `vitest` — see §4 on the `@` alias |
| services/ai-gateway | `cd services/ai-gateway && .venv/bin/python3 -m pytest` | if `test_chat_endpoint_has_rate_limit_headers` hangs, the branch predates the #770 fix — deselect it and rebase |
| services/routing | `cd services/routing && ../ai-gateway/.venv/bin/python3 -m pytest` | clean run = all pass |
| services/voice-io | `cd services/voice-io && ../ai-gateway/.venv/bin/python3 -m pytest` | clean run = all pass |
| services/mcp-server | `cd services/mcp-server && npx vitest run` | 1 env failure: `stdio-roundtrip.test.ts` (green in CI) |

**Python venvs on the dev Mac:** system python3 is 3.14 (Homebrew);
pydantic-core and cryptography ship no cp314 wheels, so
`python3 -m venv` + `pip install -r requirements.txt` **fails** for
routing/voice-io — do not try. Reuse `services/ai-gateway/.venv` as in
the table. Its `bin/pip` shebang is stale: always
`.venv/bin/python3 -m pip`, never `.venv/bin/pip`. If routing deps are
missing from that venv:

```bash
services/ai-gateway/.venv/bin/python3 -m pip install --only-binary=:all: APScheduler==3.10.4 cryptography==49.0.0
```

One more 3.14 quirk: litellm releases currently cap
`requires-python <3.14`, so installing/upgrading litellm in this venv
needs `--ignore-requires-python` (CI and the Docker images run 3.12
and resolve normally).

## 4. Unexpected failure? Patch/replay before chasing

> ⚠ **Never use `git stash` for this.** The stash stack is **shared
> across every worktree of the repo**, not per-worktree. If any other
> agent or session is working in a sibling worktree, `git stash pop`
> takes whatever is on top of the shared stack — **which may be their
> work, not yours.** This has happened: during a 9-agent run one
> agent's pop pulled another agent's files into its tree and dropped
> the entry from the stack. It was recoverable only because stash
> commits stay reachable by SHA.

Use a patch file — worktree-local, and safe under concurrency:

```bash
git diff > /tmp/my-work-<ticket>.patch
git apply -R /tmp/my-work-<ticket>.patch   # clean tree
# rerun the suite FROM THE SAME cwd as the real run → baseline set
git apply /tmp/my-work-<ticket>.patch      # restore
# rerun → only failures absent from the baseline are yours
```

**Run the baseline from the same directory as the real run.** The
dashboard's `@` alias is defined in `apps/web-dashboard/vitest.config.ts`
(`alias: { "@": path.resolve(__dirname, "./src") }`), so it resolves
only when that config loads. A root-level `npx vitest` yields ~355 bogus
collect failures. `npm run test:dashboard` does `cd apps/web-dashboard`
first, which is why the scripts in §3 are the safe entry points.

Compare the **failing file set**, not the counts — a rotating flake can
swap one red for another while the total stays equal.

Already stashed and the stack looks wrong? Do **not** pop blind. Find
your entry with `git stash list` / `git log -g refs/stash`, recover it
by SHA, then put back anything that wasn't yours with
`git stash store <sha>`.

Known pre-existing reds in **CI on main** (as of 2026-07-08 — verify
with the `ci-triage` agent before trusting this list; the previous
ai-gateway hang and routing reds were fixed by #770/#768):

- web-dashboard: `add-matter.ble-notice.test.tsx` (WARP-851 pre-flight
  copy assertion) — intermittent flake on main; re-run before chasing.
- publish-release: fails deterministically at "Sign release manifest"
  (`COSIGN_PRIVATE_KEY` repo secret unset — needs the key ceremony in
  `scripts/README.md`, not a code fix).
- osv-nightly: never been green (standing dependency-vuln debt plus
  intermittent OSV resolver errors).

Known **local-only** reds — environment artifacts, not repo reds.
Confirm by patch/replay rather than re-diagnosing each time:

- **`TeamStep.tsx(17,10) TS2305: '@droplet/auth-policy' has no exported
  member 'generateTempPassword'`** — stale `packages/auth-policy` build.
  The export is real (`packages/auth-policy/src/generate.ts:86`);
  rebuild that package.
- **`Failed to resolve entry for package "@droplet/erp-connector"`**
  across ~26-31 orchestrator files at collection — the §1 build list was
  skipped, or a worktree resolved `@droplet/*` into the root checkout.
- **`TS7031` in `tools-core`'s `list-network-devices.ts`** — `prisma
  generate` didn't run before the package builds (§2).
- **~355 dashboard collect failures** — run from the repo root instead
  of `apps/web-dashboard`; the `@` alias never loaded (§4).
- **`apps/orchestrator/src/__tests__/files.test.ts` en masse** —
  order-dependent (WARP-1600); fails when any file is added to that
  directory.
- **`*.schema.test.ts`** (20+ files) resolve `prisma/schema.prisma`
  relative to cwd — they need cwd=`apps/orchestrator`.

Rotating flakes that pass in isolation and swap between runs:
`mcp-client.service.test.ts`, `rbac.test.ts`,
`admin-retrieval-eval.test.ts`, `voice-profiles.test.ts`,
`activity-verify.test.ts`, `setup.cameras.test.tsx`. Their *presence* is
not signal; a change in the failing **file set** is.

A red not on either list: check whether main's latest run of the same
workflow fails the same way (the `ci-triage` agent does exactly this),
then patch/replay locally.

## 5. Diff hygiene

- No credentials or test logins in tracked files.
- Local-only files stay untracked: `docker-compose.override.yml`,
  `data/`, `.env`.
- Every changed line traces to the ticket (surgical-changes rule,
  CLAUDE.md §3).

## 6. Ship-check gate

`./scripts/test/ship-check.sh` is the repo's pre-PR gate. Run
`tsc-full` and `lifecycle-naming` before every PR — `lifecycle-naming`
has no other runner (it is not one of the `ci.yml` legs), so a diff that
violates the ADR-018 naming rule is caught by nothing else before review.

**Interpreter prerequisite: bash 3.2 or newer.** The script is written to
the bash 3.2 feature set — the version macOS still ships as `/bin/bash` —
so it runs on the dev Mac as-is, with no `brew install bash` needed
(WARP-2449). It asserts that floor at startup: on an older interpreter it
exits **4** with a message naming the required version and the remedy.

**Exit 4 means COULD NOT RUN, not "a check failed."** Only exit 1 means a
check ran and failed. Never record a run that exited 4 as a passing gate —
that conflation is exactly what WARP-2449 was filed about.

## 7. End state

Push the branch, open/update the PR (repo squash-merges with the
`(#NNN)` suffix), and put the preflight evidence — suites run, results
vs baseline — in the PR body. Then **stop**: 1 approving human review
is required and repo auto-merge is disabled. Do not `gh pr merge`
(with or without `--admin`/`--auto`) unless Romain explicitly
instructs it for this named PR.

## Red flags

| Thought | Reality |
|---|---|
| "These failures look unrelated but I should fix them" | Patch/replay first (§4). The baseline reds above are documented; chasing them burns hours. |
| "I'll just `git stash` to get a clean tree for the baseline" | The stash stack is **repo-global, not per-worktree**. Under parallel agents your `pop` can take someone else's work. Use the patch file in §4 — always. |
| "`tools-core` won't build, so `main` must be broken" | Run `npm run bootstrap` first (§2). This exact misdiagnosis was reported upstream as a repo red and wasn't one — four more times on 2026-09-02 (WARP-2620). `npm run bootstrap:check` settles it in one line. |
| "I'll read the source from the checkout I'm sitting in" | That checkout may be on a long-stale branch — this repo's working tree routinely is. Read from `origin/main` (`git show origin/main:<path>`) before trusting any file:line, and never symlink its `node_modules` into a worktree (§1). |
| "The venv won't build, so I'll skip the Python tests" | The ai-gateway venv reuse (§3) exists precisely for this. |
| "I'll `pip install -r requirements.txt` into the shared venv" | That pulls pydantic-core/cryptography source builds and fails; install only the two pinned wheels above. |
| "CI is green, I'll merge" | The review gate is deliberate policy. Ready-for-review IS the finish line. |
| "tsc must pass since CI passed" | Only if your diff hit a leg that runs tsc (§2). Path-aware `detect` means an unmapped change is typechecked by nothing. |
| "CI has no tsc gate, so a type error can't block me" | Stale — WARP-1011/WARP-1296 added real ones (§2). A type error on a mapped leg fails `ci-summary`, the required check. |
