"use client";

import { useEffect, useRef } from "react";
import { WelcomeFlourish } from "@/components/auth/WelcomeFlourish";
import { useAuth } from "@/lib/auth";

/**
 * Terminal step. Renders the WelcomeFlourish animation that landed in
 * WARP-216 (replacing the legacy static "Sign In" screen). User is
 * already logged in by the time we reach here, so the redirect target
 * is the dashboard root.
 *
 * PR #372 regression fix — this is also the wizard-FINISH seam: on mount we
 * fire `completeSetup()`, which optimistically flips the appliance to
 * "ready" AND durably PATCHes `appliance:"ready"` to the orchestrator
 * (`markApplianceReady`). Without this the only writer of `ready` was the
 * in-memory optimistic setter, so `ApplianceSetup.state` stayed "unclaimed"
 * server-side and the next hard refresh re-trapped the owner in the wizard.
 * Guarded to fire exactly once — re-renders, React 18 StrictMode double-mount,
 * or a refresh landing back on `done` must not matter (the server call is an
 * idempotent 200 no-op on an already-ready appliance regardless).
 *
 * Subtitle reflects whether the discovery step actually found anything:
 *   - >0 devices: "N device(s) connected and ready to control."
 *   - 0 devices: hint that they can add devices later.
 */
export function DoneStep({
  displayName,
  discoveredCount,
}: {
  displayName?: string;
  discoveredCount: number;
}) {
  const { completeSetup } = useAuth();
  const finishedRef = useRef(false);

  useEffect(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    // Fire-and-forget at the call site: completeSetup awaits the server PATCH
    // internally and never rejects (patchSetupReady swallows network errors),
    // so there is nothing to catch here and the flourish/redirect proceeds
    // independently of the round-trip.
    void completeSetup();
  }, [completeSetup]);

  return (
    <WelcomeFlourish
      displayName={displayName || undefined}
      subtitle={
        discoveredCount > 0
          ? `${discoveredCount} device${
              discoveredCount !== 1 ? "s" : ""
            } connected and ready to control.`
          : "You can add smart home devices later from the Devices page."
      }
      redirectTo="/"
    />
  );
}
