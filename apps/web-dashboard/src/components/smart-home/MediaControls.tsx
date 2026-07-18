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
  const btn =
    "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg type-caption-1 " +
    "transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-[var(--brand)] hover:bg-[var(--hover)]";

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
        className={btn}
        aria-pressed={playing}
        onClick={() => onCommand(device.nodeId, "play_media")}
        style={
          playing
            ? { background: "var(--brand-subtle)", color: "var(--brand)" }
            : { background: "var(--card-inner)", color: "var(--text)" }
        }
      >
        <Play size={14} /> Play
      </button>
      <button
        type="button"
        className={btn}
        style={{ background: "var(--card-inner)", color: "var(--text)" }}
        onClick={() => onCommand(device.nodeId, "pause_media")}
      >
        <Pause size={14} /> Pause
      </button>
      <button
        type="button"
        className={btn}
        style={{ background: "var(--card-inner)", color: "var(--text)" }}
        onClick={() => onCommand(device.nodeId, "stop_media")}
      >
        <Square size={12} /> Stop
      </button>
    </div>
  );
}
