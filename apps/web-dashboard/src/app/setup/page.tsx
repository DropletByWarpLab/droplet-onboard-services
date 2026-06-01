"use client";

import { useState } from "react";
import { ProgressDots } from "@/components/setup/ProgressDots";
import { WelcomeStep } from "@/components/setup/steps/WelcomeStep";
import { AccountStep } from "@/components/setup/steps/AccountStep";
import { TwoFactorStep } from "@/components/setup/steps/TwoFactorStep";
import { InternetStep } from "@/components/setup/steps/InternetStep";
import { StorageStep } from "@/components/setup/steps/StorageStep";
import { DiscoveryStep } from "@/components/setup/steps/DiscoveryStep";
import { CamerasStep } from "@/components/setup/steps/CamerasStep";
import { VpnStep } from "@/components/setup/steps/VpnStep";
import { AiStep } from "@/components/setup/steps/AiStep";
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
  | "account"
  | "twofactor"
  | "internet"
  | "storage"
  | "discovery"
  | "cameras"
  | "vpn"
  | "ai"
  | "done";
const STEPS: Step[] = [
  "welcome",
  "account",
  "twofactor",
  "internet",
  "storage",
  "discovery",
  "cameras",
  "vpn",
  "ai",
  "done",
];

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
              setStep("twofactor");
            }}
          />
        )}

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
