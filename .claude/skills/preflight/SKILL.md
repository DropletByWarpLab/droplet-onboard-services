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

Verify a change is genuinely ready for review. CI has **no eslint/tsc
gate** and `main` has known reds, so green-looking CI proves less than
it seems. A PR is finished when it is **ready for Romain's one-click
approval** — never merged by an agent.

## 1. Scope the change

`git diff --stat <base>...HEAD` — list touched workspaces; run only the
affected suites below. **Fresh worktree?** Run `npm install` and build
the four `@droplet/*` packages (`shared-types`, `tools-core`,
`fips-selftest`, `auth-policy`) first, or tsc/vitest fail on missing
workspace builds. (A ready-built shared worktree may exist under
`.claude/worktrees/` — check before paying that cost.)

## 2. Typecheck (any TS change)

```bash
cd apps/orchestrator && npx prisma generate && npx tsc --noEmit
```

`prisma generate` FIRST — a stale client produces phantom
scene-schedule `timezone`/`systemFlag` type errors. Repeat
`npx tsc --noEmit` in web-dashboard / packages if touched. There is no
`turbo run typecheck` task; CI will not catch type errors for you —
local tsc is the only gate.

## 3. Run the affected suites

| Touched | Command (from repo root) | Known local baseline (don't chase) |
|---|---|---|
| apps/orchestrator | `npm run test:orchestrator` | 1 env failure: `mcp-client.service.test.ts` (spawns stdio subprocess; green in CI) |
| apps/web-dashboard | `npm run test:dashboard` | — |
| services/ai-gateway | `cd services/ai-gateway && .venv/bin/python3 -m pytest --deselect tests/test_rate_limit.py::TestRateLimitEndpoint::test_chat_endpoint_has_rate_limit_headers` | deselected test hangs (real network call after full suite) — pre-existing |
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
services/ai-gateway/.venv/bin/python3 -m pip install --only-binary=:all: APScheduler==3.10.4 cryptography==44.0.0
```

## 4. Unexpected failure? Stash/replay before chasing

`git stash` → rerun the suite → note the failure set → `git stash pop`
→ rerun. Only failures absent from the baseline run are yours.

Known pre-existing reds in **CI on main** (check before blaming your
PR): the ai-gateway-tests job cancelled at ~15 min (the rate-limit hang
test above), routing-tests 3 failures (`test_upnp.py` ×2,
`test_system_firmware.py::…connection_drop…`).

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
| "tsc must pass since CI passed" | CI has no tsc gate. Only local `npx tsc --noEmit` (after `prisma generate`) counts. |
