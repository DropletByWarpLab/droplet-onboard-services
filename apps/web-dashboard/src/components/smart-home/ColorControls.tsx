"use client";

/**
 * WARP-897 / WARP-1395: color controls for a light with the ColorControl
 * cluster. A swatch strip (eight named hues + warm/cool white) plus the
 * refined color wheel — one-tap color for the home user, the wheel for
 * anything between, and (lg only) a temperature arc for tunable white.
 * Commands map to the sidecar's WARP-1371 surface: `set_color`
 * {hue °, saturation %} and `set_color_temperature` {kelvin}.
 *
 * `size`: "sm" on the device card (compact wheel, no arc); "lg" in the
 * detail panel (larger wheel + readout + temperature arc).
 *
 * WARP-1374 feedback: color writes flip the wheel to `pending` while in
 * flight; a failure flips it to `failed` (readout error line) and snaps
 * back to the device-reported color. No toast for color — the wheel
 * reflecting reality IS the confirmation.
 */

import { useCallback, useRef, useState } from "react";
import type { MatterDevice } from "@/lib/types";
import {
  ColorWheel,
  TempArc,
  NAMED_HUES,
  TEMP,
  nearestName,
  type WheelFeedback,
} from "./ColorWheel";

interface ColorControlsProps {
  device: MatterDevice;
  onCommand: (nodeId: string, command: string, data?: Record<string, unknown>) => void;
  size?: "sm" | "lg";
}

export function ColorControls({ device, onCommand, size = "sm" }: ColorControlsProps) {
  // Matter hue/sat are 0-254; the wheel speaks degrees + percent.
  const currentHueRaw = device.attributes.currentHue as number | undefined;
  const currentHueDeg =
    currentHueRaw != null ? Math.round((currentHueRaw / 254) * 360) : 0;
  const currentSatRaw = device.attributes.currentSaturation as number | undefined;
  const currentSatPct =
    currentSatRaw != null ? Math.round((currentSatRaw / 254) * 100) : 100;
  const currentMireds = device.attributes.colorTemperatureMireds as number | undefined;

  const [localHue, setLocalHue] = useState(currentHueDeg);
  const [localSat, setLocalSat] = useState(currentSatPct);
  const [mode, setMode] = useState<"hue" | "temp">("hue");
  const [kelvin, setKelvin] = useState(
    currentMireds ? Math.round(1_000_000 / currentMireds) : TEMP.warm.kelvin,
  );
  const [feedback, setFeedback] = useState<WheelFeedback>(
    device.connectionState === "connected" ? "idle" : "offline",
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const failTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const offline = device.connectionState !== "connected";

  const nearest = nearestName(localHue);

  // Fire a color write and reflect its outcome on the wheel (WARP-1374).
  const dispatch = useCallback(
    async (command: string, data: Record<string, unknown>) => {
      if (failTimer.current) clearTimeout(failTimer.current);
      setFeedback("pending");
      try {
        await onCommand(device.nodeId, command, data);
        setFeedback("idle");
      } catch {
        setFeedback("failed");
        // Snap back to the device-reported color, then clear the error line.
        setLocalHue(currentHueDeg);
        setLocalSat(currentSatPct);
        failTimer.current = setTimeout(() => setFeedback("idle"), 4000);
      }
    },
    [device.nodeId, onCommand, currentHueDeg, currentSatPct],
  );

  const setColor = useCallback(
    (hue: number, saturation = 100) => {
      void dispatch("set_color", { hue, saturation });
    },
    [dispatch],
  );

  // Swatch taps are discrete choices — apply immediately.
  const setTemp = useCallback(
    (k: number) => {
      setMode("temp");
      setKelvin(k);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void dispatch("set_color_temperature", { kelvin: k });
    },
    [dispatch],
  );

  // The arc drags continuously — debounce like the wheel.
  const setTempDebounced = useCallback(
    (k: number) => {
      setMode("temp");
      setKelvin(k);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(
        () => void dispatch("set_color_temperature", { kelvin: k }),
        300,
      );
    },
    [dispatch],
  );

  // Wheel moves update instantly on screen and debounce the device write —
  // same 300ms discipline as the sliders. Any hue interaction leaves white mode.
  const handleWheel = useCallback(
    (hue: number, saturation: number) => {
      setMode("hue");
      setLocalHue(hue);
      setLocalSat(saturation);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setColor(hue, saturation), 300);
    },
    [setColor],
  );

  const swatchSize = size === "lg" ? "w-7 h-7" : "w-6 h-6";

  return (
    <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Color presets">
        {NAMED_HUES.map((s) => {
          const selected = mode === "hue" && s.name === nearest;
          return (
            <button
              key={s.name}
              type="button"
              aria-label={s.name}
              aria-pressed={selected}
              title={s.name}
              disabled={offline}
              onClick={() => {
                setMode("hue");
                setLocalHue(s.hue);
                setLocalSat(100);
                setColor(s.hue, 100);
              }}
              className={`${swatchSize} rounded-full flex-shrink-0 transition-transform duration-200
                hover:scale-110 disabled:opacity-40 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2
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
        {(
          [
            { name: "Warm white", kelvin: TEMP.warm.kelvin, swatch: "#ffe4c4" },
            { name: "Cool white", kelvin: TEMP.cool.kelvin, swatch: "#eef4ff" },
          ] as const
        ).map((w) => {
          const selected =
            mode === "temp" &&
            (w.kelvin <= 3500 ? kelvin <= 3500 : kelvin > 3500);
          return (
            <button
              key={w.name}
              type="button"
              aria-label={w.name}
              aria-pressed={selected}
              title={w.name}
              disabled={offline}
              onClick={() => setTemp(w.kelvin)}
              className={`${swatchSize} rounded-full flex-shrink-0 transition-transform duration-200
                hover:scale-110 disabled:opacity-40 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-[var(--brand)] focus-visible:ring-offset-1 ${
                  selected ? "ring-2 ring-[var(--brand)] ring-offset-1" : ""
                }`}
              style={{ background: w.swatch, border: "1px solid var(--card-bd)" }}
            />
          );
        })}
      </div>

      <div className="flex justify-center">
        <ColorWheel
          hue={localHue}
          saturation={localSat}
          mode={mode}
          kelvin={kelvin}
          size={size}
          feedback={feedback}
          onChange={handleWheel}
        />
      </div>

      {/* WARP-1395 §3.3: temperature arc, large context only. */}
      {size === "lg" && (
        <div className="flex justify-center">
          <TempArc mode={mode} kelvin={kelvin} onPick={setTempDebounced} />
        </div>
      )}
    </div>
  );
}
