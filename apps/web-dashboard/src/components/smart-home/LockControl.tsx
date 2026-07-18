"use client";

/**
 * WARP-897: door locks were completely uncontrollable from the dashboard
 * (no widget) and their state read "unknown" forever (no lockState
 * derivation — fixed sidecar-side in the same change). Lock / Unlock
 * dispatch through the page's existing Tier-2 confirm flow: the
 * orchestrator answers `confirmation_required` and the device page opens
 * its "Write · confirm to apply" dialog — this component never bypasses
 * that.
 */

import { Lock, LockOpen } from "lucide-react";
import type { MatterDevice } from "@/lib/types";

interface LockControlProps {
  device: MatterDevice;
  onCommand: (nodeId: string, command: string, data?: Record<string, unknown>) => void;
}

export function LockControl({ device, onCommand }: LockControlProps) {
  const isLocked = device.state === "locked";

  // Backgrounds are CLASSES, never inline styles - an inline background
  // beats the hover pseudo-class and kills the hover state (the WARP-1356
  // dead-state family). The active state swaps classes instead.
  const btn =
    "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg type-caption-1 " +
    "transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-[var(--brand)]";
  const inactive = btn + " bg-[var(--card-inner)] text-[var(--text)] hover:bg-[var(--hover)]";
  const active = btn + " bg-[var(--brand-subtle)] text-[var(--brand)]";

  return (
    <div
      className="flex items-center gap-2"
      role="group"
      aria-label="Lock"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={isLocked ? active : inactive}
        aria-pressed={isLocked}
        onClick={() => onCommand(device.nodeId, "lock")}
      >
        <Lock size={14} /> Lock
      </button>
      <button
        type="button"
        className={device.state === "unlocked" ? active : inactive}
        aria-pressed={!isLocked && device.state === "unlocked"}
        onClick={() => onCommand(device.nodeId, "unlock")}
      >
        <LockOpen size={14} /> Unlock
      </button>
    </div>
  );
}
