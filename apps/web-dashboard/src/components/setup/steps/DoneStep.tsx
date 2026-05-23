"use client";

import { WelcomeFlourish } from "@/components/auth/WelcomeFlourish";

/**
 * Terminal step. Renders the WelcomeFlourish animation that landed in
 * WARP-216 (replacing the legacy static "Sign In" screen). User is
 * already logged in by the time we reach here, so the redirect target
 * is the dashboard root.
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
