"use client";

import { ConnectedAccounts } from "@/components/settings/ConnectedAccounts";
import { StepShell } from "@/components/setup/StepShell";
import "@/components/shell/indigo-tokens.css";
import "@/components/shell/droplet-shell.css";

export function AccountsStep({ onComplete, onSkip, beforeConnect }: {
  onComplete: () => void;
  onSkip: () => void;
  beforeConnect: () => Promise<void>;
}) {
  return (
    <StepShell
      current="accounts"
      title="Connect your accounts"
      subtitle="Connect Google or your Microsoft work or school account, or skip this step and connect later in Settings."
      primary={{ label: "Continue", onClick: onComplete, showArrow: true }}
      skip={{ label: "Skip for now", onClick: onSkip }}
    >
      {/* The reusable settings cards need the shell's scoped tokens and primitives. */}
      <div className="droplet-shell" style={{ minHeight: 0, background: "transparent" }}>
        <ConnectedAccounts returnTo="/setup?step=accounts" beforeConnect={beforeConnect} />
      </div>
    </StepShell>
  );
}
