"use client";

import { Shield, Lock, Check } from "lucide-react";
import { DropletMark } from "@/components/DropletMark";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

const TRUST = [
  { icon: Shield, label: "On-prem" },
  { icon: Lock, label: "Nothing leaves the box" },
  { icon: Check, label: "Set up once" },
] as const;

/**
 * Welcome splash. First thing the customer sees.
 *
 * No state of its own — calls `onContinue` when the customer taps
 * "Get Started" and the wizard advances to the account step. Renders in
 * the shared aurora-rail frame so the step rail is visible from step one.
 */
export function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <StepShell
      current="welcome"
      icon={
        <span className="aurora-brand inline-flex h-16 w-16 items-center justify-center rounded-[18px] text-white">
          <DropletMark size={34} className="text-white" />
        </span>
      }
      title="Welcome to Droplet"
      subtitle="Your private edge AI appliance"
      primary={{ label: "Get Started", onClick: onContinue, showArrow: true }}
    >
      <p
        data-testid="welcome-privacy-claim"
        className="type-headline text-label-primary max-w-md"
      >
        Your files, conversations, and connected devices stay on your premises
        — the AI that runs them lives on your own Droplet and never leaves it.
      </p>

      <ul className="mt-6 flex flex-wrap gap-2">
        {TRUST.map(({ icon: Icon, label }) => (
          <li
            key={label}
            className="inline-flex items-center gap-1.5 rounded-full bg-accent-subtle px-3 py-1.5 type-footnote font-semibold text-accent"
          >
            <Icon size={13} aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>

      <div className="mt-6 flex items-center gap-2 type-caption-1 text-label-tertiary">
        <span
          aria-hidden="true"
          className="h-[7px] w-[7px] rounded-full bg-system-green"
        />
        Appliance detected · ready to configure
      </div>

      <LearnMoreCard title="What is Droplet?" helpAnchor="privacy">
        <p>
          A single box on your own network that runs your files, conversations,
          cameras, and connected devices — your own private cloud, except it
          never leaves your premises.
        </p>
        <p>
          The AI runs locally on the hardware in front of you, so your data
          stays on the box. Tap “Learn more” for the full picture on how
          Droplet keeps everything private.
        </p>
      </LearnMoreCard>
    </StepShell>
  );
}
