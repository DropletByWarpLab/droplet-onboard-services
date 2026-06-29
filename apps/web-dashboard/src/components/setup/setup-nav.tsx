"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Step } from "@/components/setup/wizard-steps";

/**
 * Wizard navigation context (clickable rail + Back button).
 *
 * The setup page owns the step state machine; this context lets the shared
 * `StepShell` chrome drive it WITHOUT every one of the 11 step components
 * having to prop-drill a navigate callback. The page wraps the wizard in
 * `<SetupNavProvider>`; `StepShell` reads it via `useSetupNav()`.
 *
 * Rendered OUTSIDE the provider (e.g. a single step under test, or the
 * terminal `done` celebration) `useSetupNav()` returns `null` — `StepShell`
 * then falls back to the pre-nav behaviour: a static, non-clickable rail and
 * no Back button. That keeps the existing per-step tests (which mount a step in
 * isolation) green and makes the new navigation purely additive.
 */
export interface SetupNav {
  /** Jump to an already-reached step (the rail rows). */
  navigate: (step: Step) => void;
  /**
   * Highest step index the customer has reached this session. A step at or
   * before this index is navigable; anything beyond it is still "to-do" and
   * stays locked. Tracked by the page (not derived from the current step) so
   * going back doesn't relock the steps you already completed.
   */
  maxReachedIdx: number;
  /**
   * WARP-929 — the LOWEST step index the rail/Back may target. Steps before it
   * (welcome → claim → account → workspace) are a one-way floor: once passed,
   * the customer can't navigate back to them, so a created owner / claimed
   * appliance can never be un-done from the wizard. `StepShell` hides Back and
   * makes the rail rows static for any index at or below this floor. Optional
   * (and defaulted to 0 in StepShell) so a step rendered without the page
   * provider behaves exactly as before.
   */
  firstNavigableIdx?: number;
  /**
   * Step back one VISITED step (the Back button). Pops the page's visited
   * stack, which skips hardware steps that auto-skipped themselves on the way
   * forward (storage/cameras with nothing to show) — so Back never lands on a
   * step that immediately bounces forward again. Optional so a `StepShell`
   * rendered without the page provider (a step under test) falls back to the
   * previous step in `STEPS`.
   */
  back?: () => void;
}

const SetupNavContext = createContext<SetupNav | null>(null);

export function SetupNavProvider({
  value,
  children,
}: {
  value: SetupNav;
  children: ReactNode;
}) {
  return (
    <SetupNavContext.Provider value={value}>
      {children}
    </SetupNavContext.Provider>
  );
}

/** The wizard nav, or `null` when rendered outside the wizard page. */
export function useSetupNav(): SetupNav | null {
  return useContext(SetupNavContext);
}
