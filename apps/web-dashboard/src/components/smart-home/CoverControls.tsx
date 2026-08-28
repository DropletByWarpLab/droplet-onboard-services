"use client";

/**
 * WARP-897: blinds / shades. The old card put a ToggleSwitch on covers,
 * which sent an onOff command a WindowCovering never implements (June
 * audit — guaranteed 500). These are the real motion controls plus a
 * percent-open position slider, mapped to the sidecar's WARP-1371
 * commands (`open_cover` / `stop_cover` / `close_cover` /
 * `set_cover_position`).
 */

import { useCallback, useRef, useState } from "react";
import { ChevronUp, ChevronDown, Square } from "lucide-react";
import type { MatterDevice } from "@/lib/types";

interface CoverControlsProps {
  device: MatterDevice;
  onCommand: (nodeId: string, command: string, data?: Record<string, unknown>) => void;
}

export function CoverControls({ device, onCommand }: CoverControlsProps) {
  // Matter lift is hundredths CLOSED (10000 = fully closed); UX is % open.
  const lift = device.attributes.liftPercent100ths as number | undefined;
  const positionPct = lift != null ? Math.round(100 - lift / 100) : undefined;

  const [localPct, setLocalPct] = useState(positionPct ?? 50);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const pct = Number(e.target.value);
      setLocalPct(pct);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onCommand(device.nodeId, "set_cover_position", { position: pct });
      }, 300);
    },
    [device.nodeId, onCommand],
  );

  // Backgrounds are CLASSES, never inline styles - an inline background
  // beats the hover pseudo-class and kills the hover state (the WARP-1356
  // dead-state family).
  const motionBtn =
    "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg type-caption-1 " +
    "transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-[var(--brand)] bg-[var(--card-inner)] text-[var(--text)] " +
    "hover:bg-[var(--hover)]";

  return (
    <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2" role="group" aria-label="Cover motion">
        <button
          type="button"
          className={motionBtn}
          onClick={() => onCommand(device.nodeId, "open_cover")}
        >
          <ChevronUp size={14} /> Open
        </button>
        <button
          type="button"
          className={motionBtn}
          onClick={() => onCommand(device.nodeId, "stop_cover")}
        >
          <Square size={12} /> Stop
        </button>
        <button
          type="button"
          className={motionBtn}
          onClick={() => onCommand(device.nodeId, "close_cover")}
        >
          <ChevronDown size={14} /> Close
        </button>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          value={localPct}
          onChange={handleSlider}
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={localPct}
          aria-valuetext={`${localPct}% open`}
          className="flex-1 h-1.5 rounded-full appearance-none bg-[var(--inset)]
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-[var(--brand)] [&::-webkit-slider-thumb]:cursor-pointer"
        />
        <span className="type-caption-1 w-14 text-right" style={{ color: "var(--text-muted)" }}>
          {localPct}% open
        </span>
      </div>
    </div>
  );
}
