"use client";

import { useEffect, useRef, useState } from "react";
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
 * M4 (PR #372 re-review) — if the finish PATCH fails, `completeSetup` rolls
 * the optimistic flip back and exposes `completeSetupError`. We surface that
 * here with a RETRY button instead of showing the celebratory flourish while
 * the server is still `unclaimed` — otherwise the owner gets bounced back
 * into the wizard on the next refresh with no explanation.
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
  const { completeSetup, completeSetupError } = useAuth();
  const finishedRef = useRef(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    // Fire-and-forget at the call site: completeSetup never rejects (it
    // captures any failure into `completeSetupError`), so there's nothing to
    // catch here. On success the flourish/redirect proceeds; on failure the
    // error branch below renders the retry.
    void completeSetup();
  }, [completeSetup]);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await completeSetup();
    } finally {
      setRetrying(false);
    }
  };

  // M4 — the persist failed; don't pretend we're done. Offer a retry.
  if (completeSetupError) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 text-center">
        <p className="type-headline text-label-primary">
          Almost there — we couldn&apos;t finish setting up your appliance.
        </p>
        <p className="type-subheadline text-label-tertiary">
          {completeSetupError}
        </p>
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying}
          className="rounded-full bg-accent px-5 py-2 text-on-accent type-subheadline disabled:opacity-60"
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </div>
    );
  }

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
