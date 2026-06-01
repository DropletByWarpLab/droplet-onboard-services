"use client";

import { useCallback, useState } from "react";
import { useAuth } from "@/lib/auth";
import { patchSetupStep } from "@/lib/api";
import { ProgressDots } from "@/components/setup/ProgressDots";
import { WelcomeStep } from "@/components/setup/steps/WelcomeStep";
import { ClaimStep } from "@/components/setup/steps/ClaimStep";
import { AccountStep } from "@/components/setup/steps/AccountStep";
import { OrgStep } from "@/components/setup/steps/OrgStep";
import { TwoFactorStep } from "@/components/setup/steps/TwoFactorStep";
import { InternetStep } from "@/components/setup/steps/InternetStep";
import { StorageStep } from "@/components/setup/steps/StorageStep";
import { DiscoveryStep } from "@/components/setup/steps/DiscoveryStep";
import { CamerasStep } from "@/components/setup/steps/CamerasStep";
import { VpnStep } from "@/components/setup/steps/VpnStep";
import { AiStep } from "@/components/setup/steps/AiStep";
import { TeamStep } from "@/components/setup/steps/TeamStep";
import { DoneStep } from "@/components/setup/steps/DoneStep";

/**
 * Customer-facing first-run wizard.
 *
 * PR #372 — `AuthGate` routes the customer here when the explicit
 * `/api/setup/state` machine reports the appliance is "unclaimed" (no
 * longer the stateless Nextcloud `installed` check). Once they land we
 * walk them through the wizard step machine, resuming at the persisted
 * `setupState.setupStep`.
 *
 * Each step is its own component under `components/setup/steps/`. This
 * page only owns:
 *   - the current step + cross-step values (displayName, duckdnsSubdomain,
 *     discoveredCount) that later steps need to render
 *   - the per-step callback wiring that advances `step` on completion
 *
 * The 4-step base flow (welcome → account → discovery → done) shipped in
 * WARP-216 / WARP-298 / WARP-302. The walkthrough extension (WARP-174)
 * slots Internet / Storage / Cameras / VPN / AI between discovery and
 * done in subsequent commits — see `docs/SETUP_WIZARD_WALKTHROUGH.md`
 * and its addendum for the contract.
 */
type Step =
  | "welcome"
  | "claim"
  | "account"
  | "org"
  | "twofactor"
  | "internet"
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
const STEPS: Step[] = [
  "welcome",
  "claim",
  "account",
  "org",
  "twofactor",
  "internet",
  "storage",
  "discovery",
  "cameras",
  "vpn",
  "ai",
  "team",
  "done",
];

/**
 * PR #372 — the persisted `setupStep` comes from `/api/setup/state` via the
 * auth context. Resume there if it's a step this wizard can render; fall
 * back to welcome otherwise (e.g. the terminal `done`, which has nothing to
 * resume into). With PR #381 every SETUP_STEPS value (claim / org / team
 * included) is now a renderable step. Keeps the resume target congruent with
 * the steps the wizard actually has — no blank screen.
 */
function resumeStepFrom(setupStep: string | undefined): Step {
  if (setupStep && setupStep !== "done" && (STEPS as readonly string[]).includes(setupStep)) {
    return setupStep as Step;
  }
  return "welcome";
}

export default function SetupPage() {
  const { setupState } = useAuth();
  // Hydrate once from the persisted step (resumability). useState's
  // initializer runs only on first render, so later context updates don't
  // yank the customer back mid-wizard.
  const [step, setStepState] = useState<Step>(() =>
    resumeStepFrom(setupState?.setupStep),
  );
  const [displayName, setDisplayName] = useState("");
  const [discoveredCount, setDiscoveredCount] = useState(0);

  // Advance the wizard AND persist the new step so a refresh resumes here.
  // The PATCH is fire-and-forget (patchSetupStep swallows network errors) —
  // local progress must never be gated on the round-trip.
  const setStep = useCallback((next: Step) => {
    setStepState(next);
    void patchSetupStep(next);
  }, []);

  return (
    <div className="min-h-screen bg-surface-primary flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <ProgressDots steps={STEPS} current={step} />

        {step === "welcome" && (
          <WelcomeStep onContinue={() => setStep("claim")} />
        )}

        {step === "claim" && (
          <ClaimStep onComplete={() => setStep("account")} />
        )}

        {step === "account" && (
          <AccountStep
            onComplete={(name) => {
              setDisplayName(name);
              setStep("org");
            }}
          />
        )}

        {step === "org" && <OrgStep onComplete={() => setStep("twofactor")} />}

        {step === "twofactor" && (
          <TwoFactorStep
            onComplete={() => setStep("internet")}
            onSkip={() => setStep("internet")}
          />
        )}

        {step === "internet" && (
          <InternetStep
            onComplete={() => setStep("storage")}
            onSkip={() => setStep("storage")}
          />
        )}

        {step === "storage" && (
          <StorageStep
            onComplete={() => setStep("discovery")}
            onSkip={() => setStep("discovery")}
          />
        )}

        {step === "discovery" && (
          <DiscoveryStep
            onContinue={(count) => {
              setDiscoveredCount(count);
              setStep("cameras");
            }}
          />
        )}

        {step === "cameras" && (
          <CamerasStep
            onComplete={() => setStep("vpn")}
            onSkip={() => setStep("vpn")}
          />
        )}

        {step === "vpn" && (
          <VpnStep
            onComplete={() => setStep("ai")}
            onSkip={() => setStep("ai")}
            onBackToInternet={() => setStep("internet")}
          />
        )}

        {step === "ai" && (
          <AiStep
            onComplete={() => setStep("team")}
            onSkip={() => setStep("team")}
          />
        )}

        {step === "team" && (
          <TeamStep
            onComplete={() => setStep("done")}
            onSkip={() => setStep("done")}
          />
        )}

        {step === "done" && (
          <DoneStep
            displayName={displayName}
            discoveredCount={discoveredCount}
          />
        )}
      </div>
    </div>
  );
}
