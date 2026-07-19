"use client";

/**
 * WARP-897: speakers / displays — the three MediaPlayback verbs every
 * player supports, mapped to the sidecar's WARP-1371 `play_media` /
 * `pause_media` / `stop_media` void commands.
 */

import { Play, Pause, Square } from "lucide-react";
import type { MatterDevice } from "@/lib/types";

interface MediaControlsProps {
  device: MatterDevice;
  onCommand: (nodeId: string, command: string, data?: Record<string, unknown>) => void;
}

export function MediaControls({ device, onCommand }: MediaControlsProps) {
  // Backgrounds are CLASSES, never inline styles - an inline background
  // beats the hover pseudo-class and kills the hover state (the WARP-1356
  // dead-state family). The active state swaps classes instead.
  const btn =
    "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg type-caption-1 " +
    "transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-[var(--brand)]";
  const inactive = btn + " bg-[var(--card-inner)] text-[var(--text)] hover:bg-[var(--hover)]";
  const active = btn + " bg-[var(--brand-subtle)] text-[var(--brand)]";

  const playing = device.state === "playing";

  return (
    <div
      className="flex items-center gap-2"
      role="group"
      aria-label="Playback"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={playing ? active : inactive}
        aria-pressed={playing}
        onClick={() => onCommand(device.nodeId, "play_media")}
      >
        <Play size={14} /> Play
      </button>
      <button
        type="button"
        className={inactive}
        onClick={() => onCommand(device.nodeId, "pause_media")}
      >
        <Pause size={14} /> Pause
      </button>
      <button
        type="button"
        className={inactive}
        onClick={() => onCommand(device.nodeId, "stop_media")}
      >
        <Square size={12} /> Stop
      </button>
    </div>
  );
}
