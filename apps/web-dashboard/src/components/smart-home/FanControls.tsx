"use client";

/**
 * WARP-897: fans — a speed slider plus the FanControl mode chips, mapped
 * to the sidecar's WARP-1371 `set_fan_speed` {percent} and `set_fan_mode`
 * {mode} attribute writes. Renders only when the device implements
 * FanControl (0x0202).
 */

import { useCallback, useRef, useState } from "react";
import type { MatterDevice } from "@/lib/types";

interface FanControlsProps {
  device: MatterDevice;
  onCommand: (nodeId: string, command: string, data?: Record<string, unknown>) => void;
}

const MODES = ["off", "low", "medium", "high", "auto"] as const;

/** Matter FanModeEnum → chip, for highlighting the active mode. */
const MODE_BY_ENUM: Record<number, (typeof MODES)[number]> = {
  0: "off",
  1: "low",
  2: "medium",
  3: "high",
  5: "auto",
};

export function FanControls({ device, onCommand }: FanControlsProps) {
  const speed = device.attributes.fanPercent as number | undefined;
  const modeEnum = device.attributes.fanMode as number | undefined;
  const activeMode = modeEnum != null ? MODE_BY_ENUM[modeEnum] : undefined;

  const [localPct, setLocalPct] = useState(speed ?? 0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const pct = Number(e.target.value);
      setLocalPct(pct);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onCommand(device.nodeId, "set_fan_speed", { percent: pct });
      }, 300);
    },
    [device.nodeId, onCommand],
  );

  return (
    <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          value={localPct}
          onChange={handleSlider}
          aria-label="Fan speed"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={localPct}
          aria-valuetext={`${localPct}%`}
          className="flex-1 h-1.5 rounded-full appearance-none bg-[var(--inset)]
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-[var(--brand)] [&::-webkit-slider-thumb]:cursor-pointer"
        />
        <span className="type-caption-1 w-8 text-right" style={{ color: "var(--text-muted)" }}>
          {localPct}%
        </span>
      </div>

      <div className="flex items-center gap-1.5" role="group" aria-label="Fan mode">
        {MODES.map((mode) => {
          const active = mode === activeMode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={active}
              onClick={() => onCommand(device.nodeId, "set_fan_mode", { mode })}
              className={`flex-1 py-1 rounded-lg type-caption-1 capitalize transition-colors
                duration-200 focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-[var(--brand)] ${
                  active
                    ? "bg-[var(--brand-subtle)] text-[var(--brand)]"
                    : "bg-[var(--card-inner)] text-[var(--text-muted)] hover:bg-[var(--hover)]"
                }`}
            >
              {mode}
            </button>
          );
        })}
      </div>
    </div>
  );
}
