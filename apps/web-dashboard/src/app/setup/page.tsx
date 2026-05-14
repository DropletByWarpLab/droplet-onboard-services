"use client";

import { useState } from "react";
import { ProgressDots } from "@/components/setup/ProgressDots";
import { WelcomeStep } from "@/components/setup/steps/WelcomeStep";
import { AccountStep } from "@/components/setup/steps/AccountStep";
import { DiscoveryStep } from "@/components/setup/steps/DiscoveryStep";
import { DoneStep } from "@/components/setup/steps/DoneStep";

/**
 * Customer-facing first-run wizard.
 *
 * Stateless setup detection (Nextcloud user check via /api/auth/setup)
 * gates whether `AuthGate` routes the customer here at all; once they
 * land we walk them through the wizard step machine.
 *
 * Each step is its own component under `components/setup/steps/`. This
 * page only owns:
 *   - the current step + cross-step values (displayName, discoveredCount)
 *     that later steps need to render
 *   - the per-step callback wiring that advances `step` on completion
 *
 * The 4-step base flow (welcome → account → discovery → done) shipped in
 * WARP-216 / WARP-298 / WARP-302. The walkthrough extension (internet,
 * storage, cameras, vpn, ai) — see `docs/SETUP_WIZARD_WALKTHROUGH.md` —
 * slots in between discovery and done.
 */
type Step = "welcome" | "account" | "discovery" | "done";
const STEPS: Step[] = ["welcome", "account", "discovery", "done"];

export default function SetupPage() {
  const [step, setStep] = useState<Step>("welcome");
  const [displayName, setDisplayName] = useState("");
  const [discoveredCount, setDiscoveredCount] = useState(0);

  return (
    <div className="min-h-screen bg-surface-primary flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <ProgressDots steps={STEPS} current={step} />

        {step === "welcome" && (
          <WelcomeStep onContinue={() => setStep("account")} />
        )}

        {step === "account" && (
          <AccountStep
            onComplete={(name) => {
              setDisplayName(name);
              setStep("discovery");
            }}
          />
        )}

        {step === "discovery" && (
          <DiscoveryStep
            onContinue={(count) => {
              setDiscoveredCount(count);
              setStep("done");
            }}
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
