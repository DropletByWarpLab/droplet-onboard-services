"use client";

/**
 * WARP-897: color controls for a light with the ColorControl cluster.
 * A swatch strip (eight hues + warm/cool white) plus a hue slider —
 * one-tap color for the home user, fine control for everyone else.
 * Commands map to the sidecar's WARP-1371 surface: `set_color`
 * {hue °, saturation %} and `set_color_temperature` {kelvin}.
 */

import { useCallback, useRef, useState } from "react";
import type { MatterDevice } from "@/lib/types";

interface ColorControlsProps {
  device: MatterDevice;
  onCommand: (nodeId: string, command: string, data?: Record<string, unknown>) => void;
}

/** The tap-to-set palette — named for a11y, hsl for the swatch fill. */
const SWATCHES: Array<{ name: string; hue: number }> = [
  { name: "Red", hue: 0 },
  { name: "Orange", hue: 30 },
  { name: "Yellow", hue: 60 },
  { name: "Green", hue: 120 },
  { name: "Teal", hue: 180 },
  { name: "Blue", hue: 240 },
  { name: "Purple", hue: 275 },
  { name: "Pink", hue: 320 },
];

const WHITES: Array<{ name: string; kelvin: number; swatch: string }> = [
  { name: "Warm white", kelvin: 2700, swatch: "#ffe4c4" },
  { name: "Cool white", kelvin: 5000, swatch: "#eef4ff" },
];

export function ColorControls({ device, onCommand }: ColorControlsProps) {
  // Matter hue is 0-254; the slider speaks degrees.
  const currentHueRaw = device.attributes.currentHue as number | undefined;
  const currentHueDeg =
    currentHueRaw != null ? Math.round((currentHueRaw / 254) * 360) : 0;

  const [localHue, setLocalHue] = useState(currentHueDeg);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Nearest named swatch - drives the selected ring and the slider
  // announcement (a home user hears "Purple", not raw degrees).
  const nearest = SWATCHES.reduce((best, sw) => {
    const d = Math.min(Math.abs(sw.hue - localHue), 360 - Math.abs(sw.hue - localHue));
    const bd = Math.min(Math.abs(best.hue - localHue), 360 - Math.abs(best.hue - localHue));
    return d < bd ? sw : best;
  }, SWATCHES[0]);

  const setColor = useCallback(
    (hue: number) => {
      onCommand(device.nodeId, "set_color", { hue, saturation: 100 });
    },
    [device.nodeId, onCommand],
  );

  const handleSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const hue = Number(e.target.value);
      setLocalHue(hue);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setColor(hue), 300);
    },
    [setColor],
  );

  return (
    <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Color presets">
        {SWATCHES.map((s) => {
          const selected = s.name === nearest.name;
          return (
            <button
              key={s.name}
              type="button"
              aria-label={s.name}
              aria-pressed={selected}
              title={s.name}
              onClick={() => {
                setLocalHue(s.hue);
                setColor(s.hue);
              }}
              className={`w-6 h-6 rounded-full flex-shrink-0 transition-transform duration-200
                hover:scale-110 focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-[var(--brand)] focus-visible:ring-offset-1 ${
                  selected ? "ring-2 ring-[var(--brand)] ring-offset-1" : ""
                }`}
              style={{
                background: `hsl(${s.hue} 85% 55%)`,
                border: "1px solid var(--card-bd)",
              }}
            />
          );
        })}
        {WHITES.map((w) => (
          <button
            key={w.name}
            type="button"
            aria-label={w.name}
            title={w.name}
            onClick={() =>
              onCommand(device.nodeId, "set_color_temperature", { kelvin: w.kelvin })
            }
            className="w-6 h-6 rounded-full flex-shrink-0 transition-transform duration-200
              hover:scale-110 focus-visible:outline-none focus-visible:ring-2
              focus-visible:ring-[var(--brand)] focus-visible:ring-offset-1"
            style={{ background: w.swatch, border: "1px solid var(--card-bd)" }}
          />
        ))}
      </div>

      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={360}
          value={localHue}
          onChange={handleSlider}
          aria-label="Color hue"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={localHue}
          aria-valuetext={nearest.name}
          className="flex-1 h-1.5 rounded-full appearance-none
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-sm
            [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-[var(--card-bd)]
            [&::-webkit-slider-thumb]:cursor-pointer"
          style={{
            background:
              "linear-gradient(to right, hsl(0 85% 55%), hsl(60 85% 55%), hsl(120 85% 55%), hsl(180 85% 55%), hsl(240 85% 55%), hsl(300 85% 55%), hsl(360 85% 55%))",
          }}
        />
        <span
          aria-hidden="true"
          className="w-4 h-4 rounded-full flex-shrink-0"
          style={{
            background: `hsl(${localHue} 85% 55%)`,
            border: "1px solid var(--card-bd)",
          }}
        />
      </div>
    </div>
  );
}
