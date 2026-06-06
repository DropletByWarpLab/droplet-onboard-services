"use client";

import { useCallback, useState } from "react";
import { useAuth } from "@/lib/auth";
import { patchSetupStep } from "@/lib/api";
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
import { STEPS, type Step } from "@/components/setup/wizard-steps";
import { SetupNavProvider } from "@/components/setup/setup-nav";

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
 *
 * PR #384 — the visual frame is the aurora left-rail `StepShell` (rail on
 * `lg+`, compact progress header below). Each step renders its own
 * `StepShell`; this page no longer paints a centered card or progress
 * dots. The rail's step list is derived from the shared `STEPS` list
 * (`components/setup/wizard-steps`), so the frame and this state machine
 * can never drift. The state machine (STEPS, resumeStepFrom,
 * patchSetupStep) is unchanged.
 */
// The `Step` union and the canonical `STEPS` order now live in
// `components/setup/wizard-steps.ts` (imported above). A Next.js App Router
// `page` module may only export an allow-listed set of names, so exporting
// `STEPS`/`Step` from here breaks `next build`. The list there stays the
// single source of truth the aurora rail derives from.

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
  // Furthest step reached this session — drives the clickable rail so a step
  // the customer already completed stays navigable after they jump back to an
  // earlier one. Seeded from the resumed step so a refresh mid-wizard keeps
  // everything up to here unlocked. Not persisted: the orchestrator's
  // `setupStep` is the single resume pointer; "furthest reached" is session UI.
  const [maxReachedIdx, setMaxReachedIdx] = useState<number>(() =>
    Math.max(0, STEPS.indexOf(resumeStepFrom(setupState?.setupStep))),
  );
  const [displayName, setDisplayName] = useState("");
  const [discoveredCount, setDiscoveredCount] = useState(0);

  // Move the wizard AND persist the new step so a refresh resumes here. The
  // PATCH is fire-and-forget (patchSetupStep swallows network errors) — local
  // progress must never be gated on the round-trip. Used for forward completion
  // AND backward navigation (the rail rows + the Back button); `maxReachedIdx`
  // only ever grows, so jumping back never relocks an already-completed step.
  const setStep = useCallback((next: Step) => {
    setStepState(next);
    setMaxReachedIdx((prev) => Math.max(prev, STEPS.indexOf(next)));
    void patchSetupStep(next);
  }, []);

  // PR #384 — each step paints its own full-bleed aurora-rail `StepShell`, so
  // the page is just the step switch. The terminal `done` step is the
  // exception: it's a centered celebration (WelcomeFlourish), so it gets its
  // own centering wrapper rather than the rail frame.
  if (step === "done") {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface-primary p-4">
        <DoneStep displayName={displayName} discoveredCount={discoveredCount} />
      </div>
    );
  }

  return (
    <SetupNavProvider value={{ navigate: setStep, maxReachedIdx }}>
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
    </SetupNavProvider>
  );
}
