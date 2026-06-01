# WARP-559 — RBAC guard on managed-switch control API

**Type:** Bug (Highest / launch blocker) · **Area:** auth
**Jira:** https://warp-lab.atlassian.net/browse/WARP-559
**Branch:** `WARP-559/switch-rbac` (supersedes one-shot PR #340 on `fix/warp-559-switch-rbac`)

## Problem

`apps/orchestrator/src/routes/switch.ts` is the lone hardware-control router
mounted (`app.ts:165`, `app.use("/api", createSwitchRouter(prisma))`) with **no
authorization guard**. Every sibling hardware router (cameras, matter,
network-wifi, vpn, routing, aps, ddns) gates its mutating routes with
`requireRole(...)`. The only check on switch mutations is
`evalSwitchCommand(... req.user?.id)` — a WARP-76 safety/confirmation/audit
tier, NOT an authz gate; it does not inspect role and explicitly tolerates an
undefined user id. Result: a `guest`/`family` (or stolen low-priv) session can
disable PoE to cameras, disable switch ports, and rewrite VLAN membership.

## Convention to match

`network-wifi.routes.ts` and `vpn.ts` mount **bare** at `/api` and apply
`requireRole("owner", "admin")` **per mutating route** (WARP-171). GETs stay
open (auth middleware still applies, no role gate). ADR-004 §3 matrix puts
`/api/network/*` and `/api/vpn/*` at `owner`+`admin`. Switch is
network-infrastructure → same `owner`+`admin` posture. We follow the per-route
`requireRole` convention (NOT `requireScope` — that is the orthogonal WARP-455
information-bucket axis, not what this surface needs); the bare mount in app.ts
is left unchanged, exactly like vpn/wifi.

## Plan

1. Add `import { requireRole } from "../middleware/auth.js";` to `switch.ts`.
2. Add a `requireUserId(userId): string` helper in `switch.ts` that throws if
   the id is missing/empty (defense in depth — once `requireRole` runs, a
   missing id is a middleware-ordering bug, not a client condition). Use its
   return value where the handlers currently pass `req.user?.id` into
   `evalSwitchCommand` / `confirmNetworkCommand`. **`evalSwitchCommand` itself
   is unchanged** — only the call sites stop forwarding `undefined`.
3. Insert `requireRole("owner", "admin")` as route middleware on every mutating
   route (10 total): `POST /switch/command/confirm`, `POST /switch/ports/:port/enable`,
   `POST /switch/ports/:port/disable`, `POST /switch/vlans`,
   `DELETE /switch/vlans/:vlanId`, `POST /switch/vlans/:vlanId/membership`,
   `POST /switch/poe/:port/enable`, `POST /switch/poe/:port/disable`,
   `POST /switch/wan/detect`, `POST /switch/setup/cameras`. Leave all 7 read
   GETs untouched (open to every auth role).
4. Extend `apps/orchestrator/src/__tests__/rbac.test.ts`:
   - Add the 10 switch mutations to the declarative `MATRIX` (`owner`,`admin`).
   - Add a `switch router RBAC wiring` block that mounts the **real**
     `createSwitchRouter` (with switch.client + network-safety mocked) and
     asserts guest/family/no-session → 403 on every mutation, owner/admin →
     not-403, and that the read GETs stay 200 for guest/family.
5. Update `docs/ADR-004-rbac-per-route-guards.md` §3 matrix to list the switch
   routes under the `owner`+`admin` network-infrastructure row.

## Acceptance checks

- AC1: every mutating `/api/switch/*` route returns 403 for `guest`/`family`
  (and no-session), and not-403 for `owner`/`admin`. — rbac.test.ts matrix +
  real-router wiring block.
- AC2: rbac.test.ts MATRIX extended to cover all 10 switch routes × role.
- AC3: `evalSwitchCommand`/`confirmNetworkCommand` no longer receive an
  undefined user id on the API path (`requireUserId` asserts). `evalSwitchCommand`
  signature/body unchanged.
- AC4: ADR-004 matrix updated to list switch routes.
- AC5: a switch mutation regression test fails on `main` (no guard) — proves
  the test actually exercises the fix.
- AC6: read GETs remain open to all authenticated roles (no over-restriction).
- AC7: `npm run test:orchestrator` green; `npx tsc --noEmit` clean;
  `npm run build` clean; `scripts/test-security.sh` passes (modulo the
  documented env-only lines).

## TDD order (one conventional commit per check)

1. `test(switch): RBAC matrix + real-router wiring for /api/switch/* (WARP-559)`
   — add failing tests first, confirm red for the right reason (mutations
   reachable / 200 for guest).
2. `fix(switch): guard mutating routes with requireRole + requireUserId (WARP-559)`
   — implement, tests go green.
3. `docs(adr): list switch routes in ADR-004 RBAC matrix (WARP-559)`.

## Dev self-assessment

**What I did**
- `apps/orchestrator/src/routes/switch.ts`: added `requireRole` import; added
  `requireUserId()` helper (AC3); added `requireRole("owner","admin")` to all
  10 mutating routes (AC1); threaded the asserted `userId` into every
  `evalSwitchCommand`/`confirmNetworkCommand` call. `evalSwitchCommand` body +
  signature unchanged.
- `apps/orchestrator/src/__tests__/rbac.test.ts`: 10 switch rows in MATRIX +
  `switch router RBAC wiring` block mounting the real `createSwitchRouter`
  (AC1/AC2/AC5/AC6).
- `docs/ADR-004-rbac-per-route-guards.md`: §3 row + WARP-559 subsection (AC4).

**What I skipped**
- `app.ts` mount left bare (`app.use("/api", createSwitchRouter(prisma))`) —
  intentional. The convention the ticket names (vpn.ts / network-wifi.routes.ts)
  guards *per route*, not at the mount; vpn/wifi mount bare too. Per-route guards
  are grep-able at registration and the test matrix catches a future unguarded
  route. No app.ts change needed.

**Risks**
- `requireUserId` throws → 500 if the guard chain is ever bypassed. Deliberate
  fail-loud (defense in depth); never reachable on the normal path because
  `requireRole` 403s a roleless session first. QA: confirm no normal-path 500.
- The MATRIX rows pass even without the fix (synthetic guarded stand-ins); the
  real-router wiring block is the actual regression canary. QA: confirm that
  block fails on `main`.

**Handoff notes**
- 3 commits: `test(switch)…`, `fix(switch)…`, `docs(adr)…`.
- Full orchestrator suite: 780/801 pass. The 21 failures are in 6 files —
  redis-resilience, session-state, mcp.streamable-http.contract,
  llm.tools.contract, openwrt.client, routing.integration — all in the
  documented env-only known-failure set (redis-down, session-state JSON,
  mcp-server tsc-in-worktree, router-unreachable). None import `routes/switch`
  (verified: only `rbac.test.ts` does) and zero failing assertions reference
  switch/rbac. tsc --noEmit clean; `npm run build` clean.

## QA report

**Verdict: PASS**

| Check | Result |
|---|---|
| `npx tsc --noEmit` (orchestrator) | clean |
| `npx vitest run` (orchestrator) | 780/801 pass; 21 fails in 6 env-only files |
| `npm run build` (orchestrator) | clean |
| `scripts/test-security.sh` | 1 `[FAIL]` = documented compose.sh `--env-file` env-only line; no switch/rbac involvement |
| rbac.test.ts (switch scope) | 306/306 pass |
| Regression proof | swapped in `main:switch.ts` → 30 new switch wiring tests fail (guest/family/no-session → 403 on all 10 mutations). Restored byte-exact. |

**AC coverage**
- AC1 every mutating `/api/switch/*` → 403 guest/family/no-session, not-403 owner/admin — ✓ rbac.test.ts wiring block + MATRIX.
- AC2 rbac.test.ts MATRIX extended (10 switch routes × role) — ✓.
- AC3 `evalSwitchCommand`/`confirmNetworkCommand` no longer receive undefined user id (`requireUserId` asserts); evalSwitchCommand unchanged — ✓.
- AC4 ADR-004 matrix updated — ✓.
- AC5 regression fails on main — ✓ (proven above).
- AC6 read GETs open to all roles — ✓ wiring block GET cases (guest/family → 200).

**Env-only failures (NOT attributable to this change, per controller note):**
redis-resilience, session-state, mcp.streamable-http.contract,
llm.tools.contract, openwrt.client, routing.integration (redis-down /
session-state JSON / mcp-server tsc-in-worktree / router-unreachable) +
the compose.sh `--env-file` security-script line. Verified: only
`rbac.test.ts` imports `routes/switch`; zero failing assertions mention
switch/rbac; the security FAIL never references switch.

## Status: qa-pass

## Code review

**Reviewer verdict: APPROVE.** `git diff main...HEAD` is exactly 3 files
(switch.ts, rbac.test.ts, ADR-004) — no `.env`/secrets/unrelated files. Follows
the per-route `requireRole` convention; `evalSwitchCommand` untouched;
`command/confirm` guarded (no execution bypass); reads stay open; `requireUserId`
is sound fail-loud defense-in-depth. Regression confirmed to fail without the fix
(QA section: main's switch.ts → 30 wiring-test failures; fix → 306/306).

- **PR:** https://github.com/DropletByWarpLab/droplet-onboard-services/pull/349
- **Supersedes:** #340 (comment posted directing review to #349).

## Status: approved
