"use client";

import { ArrowRight } from "lucide-react";
import { DropletMark } from "@/components/DropletMark";

/**
 * Welcome splash. First thing the customer sees.
 *
 * No state of its own — calls `onContinue` when the customer taps
 * "Get Started" and the wizard advances to the account step.
 */
export function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="text-center animate-in fade-in duration-300">
      <div className="flex items-center justify-center mx-auto mb-6">
        <DropletMark size={48} className="text-accent" />
      </div>

      <h1 className="type-large-title text-label-primary mb-3">
        Welcome to Droplet
      </h1>
      <p className="type-body text-label-secondary mb-2">
        Your private edge AI appliance
      </p>
      <p className="type-subheadline text-label-tertiary mb-10 max-w-sm mx-auto">
        Droplet keeps your files, conversations, and smart home control
        completely private — powered by local AI running on your hardware.
      </p>

      <button onClick={onContinue} className="dp-btn-primary w-full">
        Get Started
        <ArrowRight size={16} />
      </button>
    </div>
  );
}
