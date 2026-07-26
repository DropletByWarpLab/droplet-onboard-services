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
breaks Vite/vitest resolution. If the root checkout's install predates
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
cd apps/orchestrator && npx prisma generate && npx tsc --noEmit
```

`prisma generate` FIRST — a stale client produces phantom
scene-schedule `timezone`/`systemFlag` type errors. Repeat
`npx tsc --noEmit` in web-dashboard / packages if touched.

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
| apps/web-dashboard | `npm run test:dashboard` | ~26 env failures in 9 files locally (`localStorage` undefined, auth re-probe classes; all green in CI) — compare via stash/replay; single-file runs are reliable |
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

## 4. Unexpected failure? Stash/replay before chasing

`git stash` → rerun the suite → note the failure set → `git stash pop`
→ rerun. Only failures absent from the baseline run are yours.

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

A red not on this list: check whether main's latest run of the same
workflow fails the same way (the `ci-triage` agent does exactly this),
then stash/replay locally.

## 5. Diff hygiene

- No credentials or test logins in tracked files.
- Local-only files stay untracked: `docker-compose.override.yml`,
  `data/`, `.env`.
- Every changed line traces to the ticket (surgical-changes rule,
  CLAUDE.md §3).

## 6. End state

Push the branch, open/update the PR (repo squash-merges with the
`(#NNN)` suffix), and put the preflight evidence — suites run, results
vs baseline — in the PR body. Then **stop**: 1 approving human review
is required and repo auto-merge is disabled. Do not `gh pr merge`
(with or without `--admin`/`--auto`) unless Romain explicitly
instructs it for this named PR.

## Red flags

| Thought | Reality |
|---|---|
| "These failures look unrelated but I should fix them" | Stash/replay first (§4). The baseline reds above are documented; chasing them burns hours. |
| "The venv won't build, so I'll skip the Python tests" | The ai-gateway venv reuse (§3) exists precisely for this. |
| "I'll `pip install -r requirements.txt` into the shared venv" | That pulls pydantic-core/cryptography source builds and fails; install only the two pinned wheels above. |
| "CI is green, I'll merge" | The review gate is deliberate policy. Ready-for-review IS the finish line. |
| "tsc must pass since CI passed" | Only if your diff hit a leg that runs tsc (§2). Path-aware `detect` means an unmapped change is typechecked by nothing. |
| "CI has no tsc gate, so a type error can't block me" | Stale — WARP-1011/WARP-1296 added real ones (§2). A type error on a mapped leg fails `ci-summary`, the required check. |
