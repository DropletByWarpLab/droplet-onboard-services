# WARP-576 — Dashboard App Router error boundaries + harden HEALTH_COPY lookup

**Area:** frontend (`apps/web-dashboard`) · **Severity:** High · **Effort:** S

## Problem

The dashboard has no App Router error boundary, no global-error boundary, and
no not-found page. Any uncaught render throw white-screens the entire app —
there is no graceful failure surface and no styled 404.

The one known concrete trigger is `apps/web-dashboard/src/app/page.tsx:431`
(and the sibling reads at `:437` and `:780`), which index `HEALTH_COPY[ctx.systemHealth.status]`
unguarded. `HEALTH_COPY` (page.tsx:77) is typed as a total
`Record<SystemHealthStatus, …>` over `"ok" | "degraded" | "down"`, but the
runtime value comes from `fetchSystemHealth()` over the wire — a backend that
returns any other string (or a future status enum value) makes the lookup
return `undefined`, and `.dot` / `.label` then throws, white-screening the home
page.

## Plan (chosen approach — framework-native, two layers of defense)

Mirrors the launch-blocker fix plan (`LAUNCH_READINESS_FIX_PLANS.md` → WARP-576)
and the codebase's "declare the canonical representation, never derive from
absence" standard (CLAUDE.md "No guessing, ever").

1. **`src/app/error.tsx`** — `'use client'` segment boundary.
   `export default function Error({ error, reset })`. Renders a branded
   "Something went wrong" card (existing `dp-*` + `type-*` + `text-label-*`
   tokens) with a "Try again" button calling `reset()`, and
   `useEffect(() => console.error(error), [error])` so the throw stays
   observable.
2. **`src/app/global-error.tsx`** — `'use client'` layout-level boundary that
   renders its own `<html><body>` (it replaces the root layout on a layout
   throw, so it cannot depend on `layout.tsx`). Same card + `reset()`.
   Note: only exercised in production builds — the dev overlay masks it.
3. **`src/app/not-found.tsx`** — friendly styled 404 with a `next/link` back to
   `/`.
4. **Harden the lookup** in `page.tsx`: add an explicit fallback entry to
   `HEALTH_COPY` (`unknown`) and resolve every read through
   `HEALTH_COPY[status] ?? HEALTH_COPY.unknown` so an out-of-set status renders
   defined fallback copy instead of throwing. Widen the index key type so an
   arbitrary wire string is accepted at the lookup boundary.

Styling: Tailwind-only, reusing `dp-card`/`dp-btn-primary`/`type-*`/
`text-label-*`/`text-accent` tokens. The `scripts/check-dashboard-classes.sh`
class-lint + the vitest `dashboard-classes-guard` enforce this.

## Test strategy (TDD — Vitest + RTL, matching `src/__tests__/`)

New `src/__tests__/app/error-boundaries.test.tsx`:
- A child that throws renders the `error.tsx` boundary (heading visible), NOT a
  blank — and "Try again" invokes `reset`.
- `not-found.tsx` renders a home link to `/`.
- `global-error.tsx` renders the recovery card + retry.

New `src/__tests__/app/health-copy.test.ts` (pure unit, the regression guard):
- Resolving `HEALTH_COPY` for each known status returns a defined object.
- Resolving for an UNKNOWN status string returns the defined fallback (never
  `undefined`) — pins the `page.tsx:431` fix so CI fails if the guard regresses
  to an unguarded index access.

To make `HEALTH_COPY` unit-testable without rendering the whole page, extract
the map + a `resolveHealthCopy(status)` helper into a tiny colocated module
(`src/app/health-copy.ts`) and import it from `page.tsx`. This keeps the page
import-light for the test and gives the regression guard a direct target.

## Acceptance

- [ ] `src/app/error.tsx`, `global-error.tsx`, `not-found.tsx` all exist;
      `error.tsx` + `global-error.tsx` start with `'use client'`;
      `global-error.tsx` renders its own `<html>`/`<body>`.
- [ ] `error.tsx` + `global-error.tsx` expose a working `reset()`/retry control
      and log via `console.error`.
- [ ] A render throw inside the page tree shows the `error.tsx` surface (heading),
      not a blank; "Try again" re-attempts (test).
- [ ] A non-existent route renders `not-found.tsx` with a working link to `/`.
- [ ] `HEALTH_COPY` has an explicit fallback key and every `page.tsx` read
      resolves through `?? fallback` so an unexpected status renders fallback
      copy instead of throwing.
- [ ] A CI test fails if the lookup regresses to an unguarded index for an
      unknown status.
- [ ] `next build` succeeds, no new type errors; new files are valid Client
      Components; class-lint clean.

## Risks

- `global-error.tsx` only renders in production builds (dev overlay masks it) —
  verified via reasoning + a JSDOM render test, not a dev run. Called out in PR.
- `global-error` replaces the root layout, so providers/fonts from `layout.tsx`
  are absent on that last-resort screen — acceptable, noted in PR.

## Status: planned
