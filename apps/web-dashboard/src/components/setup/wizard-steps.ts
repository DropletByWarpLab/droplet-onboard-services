/**
 * Canonical first-run wizard step order + the `Step` union.
 *
 * Shared single source of truth for the setup page's state machine
 * (`app/setup/page.tsx`) and the aurora rail (`StepShell`), so the frame and
 * the resumable state machine can never drift.
 *
 * Lives here, NOT in `app/setup/page.tsx`, because a Next.js App Router `page`
 * module may only export a fixed allow-list of names (`default`, `metadata`,
 * route-segment config, …). Exporting `STEPS`/`Step` from the page fails the
 * production build with:
 *   Type error: Page "src/app/setup/page.tsx" does not match the required
 *   types of a Next.js Page. "STEPS" is not a valid Page export field.
 * (The check is page-types validation — `next dev` skips it, so it only bites
 * `next build`.) Keeping the list in this plain module lets the page export
 * just its default component while every consumer still imports the one list.
 */

export type Step =
  | "welcome"
  | "claim"
  | "account"
  | "org"
  | "twofactor"
  | "wifi"
  | "address"
  | "storage"
  | "discovery"
  | "cameras"
  | "vpn"
  | "ai"
  | "team"
  | "done";

// §1. PR #380 — `org` slots AFTER account (… → account → org → …), per the
// #380 spec. `org` directly follows `account` to mirror the orchestrator
// `SETUP_STEPS` order 1:1 for the PERSISTED steps, so a persisted `setupStep`
// always maps to a step this wizard can render. PR #375's `twofactor` is a
// client-only step (no `SetupStep` enum value / no backend `SETUP_STEPS`
// entry — it skips straight to internet), so it sits after `org` without
// disturbing that 1:1 mapping. PR #381 — `team` slots near the END, after `ai`
// and before `done` (… → ai → team → done): once the box is set up, the owner
// brings people in. It is a persisted `SETUP_STEPS` value, so the same 1:1
// mapping holds and a resumed `setupStep === "team"` renders cleanly.
//
// PR #384 — `StepShell` derives its aurora rail from this exact array (order +
// membership), keyed into `RAIL_LABELS` for the plain-language label + icon,
// so the rail can't drift from the state machine.
//
// Onboarding-Flow redesign — the single `internet` step is split into two
// ordered steps, `wifi` (the local network the box broadcasts) and `address`
// (the secure address the box gives itself, which powers remote access), so each maps to one
// backend and one mental model (WIFI-ADDRESS-THEME-HANDOFF §1). Like
// `twofactor`, both are CLIENT-ONLY steps: the orchestrator's Prisma
// `SetupStep` enum has no `wifi`/`address` members, so the page persists both
// as the existing `internet` SetupStep and resumes a persisted `internet` at
// `wifi` (see `app/setup/page.tsx` resumeStepFrom + persistedStep). The enum
// is deliberately NOT migrated for a presentation-only split.
export const STEPS: Step[] = [
  "welcome",
  "claim",
  "account",
  "org",
  "twofactor",
  "wifi",
  "address",
  "storage",
  "discovery",
  "cameras",
  "vpn",
  "ai",
  "team",
  "done",
];
