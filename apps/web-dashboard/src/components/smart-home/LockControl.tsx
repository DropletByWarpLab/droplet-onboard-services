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

  const btn =
    "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg type-caption-1 " +
    "transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-[var(--brand)] hover:bg-[var(--hover)]";

  return (
    <div
      className="flex items-center gap-2"
      role="group"
      aria-label="Lock"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={btn}
        aria-pressed={isLocked}
        onClick={() => onCommand(device.nodeId, "lock")}
        style={
          isLocked
            ? { background: "var(--brand-subtle)", color: "var(--brand)" }
            : { background: "var(--card-inner)", color: "var(--text)" }
        }
      >
        <Lock size={14} /> Lock
      </button>
      <button
        type="button"
        className={btn}
        aria-pressed={!isLocked && device.state === "unlocked"}
        onClick={() => onCommand(device.nodeId, "unlock")}
        style={
          device.state === "unlocked"
            ? { background: "var(--brand-subtle)", color: "var(--brand)" }
            : { background: "var(--card-inner)", color: "var(--text)" }
        }
      >
        <LockOpen size={14} /> Unlock
      </button>
    </div>
  );
}
