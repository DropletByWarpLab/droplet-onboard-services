# ADR-006: Reconcile `feat/poc-single-box-rebuild` branch with `main`

**Status:** Proposed
**Date:** 2026-05-24
**Deciders:** Engineering team
**Source:** Phase 0–3 of the "PoC = repo" alignment work (PRs #247, #249, #250, #251, #252, droplet-local-LLM #19)

## Context

The single-box PoC at `192.168.1.87` (`droplet-sys`) runs from branch
`feat/poc-single-box-rebuild`, not `main`. As of 2026-05-24:

- **30 non-merge commits** on `feat/poc-single-box-rebuild` not on `main`.
- **10 non-merge commits** on `main` not on the feat branch.
- **Merge-base** is `3f6ef13` (early-May 2026, several weeks back).
- **159 files** diverge; ~20 850 LoC added, ~3 775 removed in the
  feat-only direction (raw diff before considering common ancestor moves).

The divergence has THREE distinct kinds of work mixed into one branch:

### 1. PoC-specific patches (~10 commits)

PR-by-PR, these are the on-box iterations: docker-compose.override.yml
declaring ollama + openwrt; `droplet-openwrt-attach` script (and its
fixes for eth0 bridge trap, watchdog, race conditions); ops-console
restore; oled-display one-shot deploys. **These are precisely what
Phases 0–3 already absorb into main**:

| feat commit | Captured by |
|---|---|
| `feat(poc): source-control droplet-openwrt-attach` (`afeb7cf`) | Phase 0 PR #249 — `scripts/host/usr-local-sbin/droplet-openwrt-attach` |
| `fix(poc): eth0 watchdog daemon` (`acf7e3e`) | Same — captured script includes the watchdog |
| `fix(poc): rerun unbridge_eth0 + bootstrap_net at end of attach` (`e6f4242`) | Same |
| `fix(poc): kill apostrophe in heredoc comment` (`b2079bd`) | Same |
| `fix(poc): unconditional routing restart in attach script` (`f0cf84a`) | Same |
| `chore(compose): restore ops-console + ops-audit volume + OPS_TOKEN` (`4e81c5a`) | Already on main (ops-console PR #228) |
| `fix(setup): auto-merge docker-compose.override.yml in scripts/lib/compose.sh` (`34bfb52`) | Phase 1 PR #250 makes the override unnecessary (compose profile) |
| `chore(oled-display): one-shot deploy script for the POC box` (`cfff923`, `2c14f97`) | Reviewed in Phase 0 `_uncommitted-on-box.md` — recommended as separate small PR |
| `rescue: integrate WIP from droplet-sys before wiping the box` (`b989cdb`) | Sweep PR — diff-by-file review |
| `fix(dev): three real bugs surfaced while spinning the dev stack locally` (`e3e15b7`) | Cherry-pick |

**Once Phases 0–3 land on main, this category is 100 % redundant.**

### 2. Feature work that has no clean equivalent on main (~15 commits)

This is the substantive UI / API / data-model work that landed on the
feat branch since the divergence:

- **Dashboard redesign (Phases 1–2c):** violet brand, workspace
  variants, Topbar retrofit across Cameras / Settings / Network / Files /
  Devices / Calendar / Knowledge / Remote Access / Events. ~6 commits.
- **Workspace concept (Phase 4a):** `workspace_type` persisted in
  Prisma, `/api/settings/workspace` endpoint, home view per workspace.
  ~3 commits + a migration.
- **ADR-004:** native mobile design system + API contract (referenced
  by `droplet-ios`, `droplet-android`, `droplet-windows`).
- **ADR-005:** canonical system architecture from whiteboard (referenced
  by `droplet-windows`).
- **Workspace storage routes** (`drive_displayname` migration,
  `settings-workspace.ts` route, ddns / vpn / files / auth route patches).
- **Theme system** (user-selectable accent, drop Instrument Serif).
- **Auth `?return=body` patch** on `/auth/login` + body refresh.
- **Help page + admin pages** (billing, groups, keys, roles) — new pages.
- **Dev-stack work:** Windows / Docker Desktop dev stack + lockfile sync
  for `@zxing/*`.
- **Setup-wizard polish on top of Stefan's blocker-fix commit.**

These commits represent real product progress and **must land on main**
before the feat branch can be retired. They are NOT covered by Phase 0–3.

### 3. The merge commits

Several merge commits exist on the feat branch (`12f1314` for
setup-wizard, `d861673` for front-panel-redesign-v2). These are
fast-forward-eligible noise once main and feat are aligned on content.

## Decision

**Hybrid reconciliation, in this order:**

### Step 1 — Land Phases 0–3 on `main` (in progress)

Already in flight as PRs:

- **#247** — `secrets.sh` default `JETSON_OLLAMA_URL` fix
- **#249** — Phase 0 capture (`scripts/host/`)
- **#250** — Phase 1 unify compose under `profiles: [poc]`
- **#251** — Phase 2 `setup.sh --poc` automation (stacked on #250)
- **#252** — Phase 3b orchestrator first-boot model pull (stacked on #251)
- **droplet-local-LLM #19** — Phase 3a `gpt-oss:20b` in manifest

When these merge, category 1 above is fully absorbed by `main`.

### Step 2 — Cherry-pick category 2 onto `main` as small reviewable PRs

Do NOT do a `git merge feat/poc-single-box-rebuild` — the diff is too
big to review meaningfully in one bite. Instead, file PRs in this
order (smallest-blast-radius first):

1. **ADR-004** (`docs/ADR-004-native-mobile-design-system-and-api-contract.md`) +
   `docs/mobile-api-contract.md` — docs-only, no code change. The
   mobile clients (`droplet-ios`, `droplet-android`, `droplet-windows`)
   already reference these paths — they're 404 against `main` today.
   **Highest priority** — unblocks the mobile repos' CI.
2. **ADR-005** (`docs/ADR-005-canonical-system-architecture.md`) — same
   reason. `droplet-windows` references this too.
3. **Auth `?return=body` patch** + body-refresh on `/auth/refresh`. Small
   API change; native mobile clients depend on this shape.
4. **Drive `displayname` migration** + workspace settings route.
   Includes a Prisma migration — needs a clean test run before merge.
5. **Workspace concept (Phase 4a)** — `workspace_type` enum + persistence +
   API. Touches Prisma + multiple routes. Standalone PR with full test
   coverage.
6. **Dashboard redesign Phase 1** (violet brand foundation). UI-only PR.
   Visual review required.
7. **Dashboard redesign Phases 2a/2b/2c** (Topbar retrofit on each page
   group). Three PRs, one per group, so reviewers can validate per page.
8. **Help page + admin pages.** Mostly additive, low conflict risk.
9. **Theme system** (accent color, typography simplification). UI polish.
10. **Dev-stack improvements** (Windows / Docker Desktop, lockfile sync).

Each PR opened by cherry-picking the relevant feat-branch commit(s)
onto a fresh branch off `main`. Conflicts resolved in favor of `main`
where Phases 0–3 already settled the question (compose, host scripts,
secrets defaults).

### Step 3 — Delete `feat/poc-single-box-rebuild`

Once Step 2 is complete and the box has been validated (Phase 5
rebuild from `main` produces the same operational state), the feat
branch has no remaining unique content. Delete it on the remote and
update the box's clone to track `main`:

```bash
ssh droplet@192.168.1.87
cd /home/droplet/edge-platform
git fetch origin
git checkout main
git pull --ff-only
sudo systemctl restart droplet.service  # in case anything got recreated
git branch -D feat/poc-single-box-rebuild  # local delete
```

```bash
# From a dev machine:
gh api -X DELETE repos/DropletByWarpLab/droplet-pi-platform/git/refs/heads/feat/poc-single-box-rebuild
```

### Step 4 — Update the photo-studio snapshot

The `droplet-poc-photo-studio` repo captures a snapshot of the box on
2026-05-18 (`d58d0fd` on `poc/single-box` + 47 uncommitted files). After
Step 3 the box is on `main`; re-snapshot so the historical record
matches the new reality.

## Why this order

Three reasons:

1. **Phases 0–3 strictly reduce divergence.** Every PR they land
   absorbs feat-only content. By the time Step 2 starts, the diff
   shrinks substantially.
2. **Feature PRs are easier to review one at a time.** ADR-004/5 alone
   are ~500 lines of docs; mobile/workspace/dashboard each touch dozens
   of files. Mixing them with PoC patches makes review intractable.
3. **The PoC must keep working throughout.** Step 1 brings main to
   functional parity with the feat branch via the profile mechanism;
   Step 2 ports new features without breaking the PoC; Step 3 deletes
   only when the box can demonstrably rebuild from main.

## Risks + mitigations

- **Prisma migration conflicts** — feat branch has two new migrations
  (`20260514_warp_174_drive_displayname`, `20260518_add_workspace`)
  not on main. When cherry-picked, they need to be re-numbered with
  `npx prisma migrate dev` so they sort cleanly after main's latest
  migration timestamp. **Don't** keep the original timestamps if other
  migrations have landed in between.
- **Dashboard CSS / component conflicts** — the violet-brand + Topbar
  retrofit touches globals.css and many page files. Conflict resolution
  needs design review, not just code review.
- **Workspace concept might collide with admin/groups/roles work** —
  both touch the user model. Cherry-pick order matters: workspace
  before admin pages.
- **PoC keeps drifting during reconciliation.** The box may accumulate
  new hand-rolled fixes while this multi-PR effort proceeds. Mitigation:
  capture-and-commit cycle from Phase 0 becomes the recurring discipline.
  Anything new on the box that's worth keeping gets a same-day PR.
- **`droplet-windows` / `droplet-ios` / `droplet-android` CI may already
  be broken** by stale ADR-004/5 references. Steps 2.1–2.2 (ADRs first)
  unblock them.

## Open questions

- Should the box's git remote be migrated to `droplet-onboard-services`
  (the renamed canonical name) during Step 3? Currently it tracks
  `droplet-pi-platform` via GitHub's redirect. Probably yes — clean URL
  beats redirect — but it's a separate one-line change worth its own
  PR description.
- Should `droplet-poc-photo-studio` migrate from a static snapshot to
  an automated capture (a scheduled job that snapshots the box weekly)?
  Out of scope for this ADR; flag as a follow-up if Step 4 surfaces
  the same staleness problem next time.

## Status

**Step 1 — IN FLIGHT.** PRs #247, #249, #250, #251, #252, droplet-local-LLM #19 open and stacked.
**Step 2 — NOT STARTED.** Requires Step 1 to merge first.
**Step 3 — BLOCKED on Step 2.**
**Step 4 — BLOCKED on Step 3.**

This ADR documents the strategy; the actual cherry-pick PRs in Step 2 are NOT in this PR.
