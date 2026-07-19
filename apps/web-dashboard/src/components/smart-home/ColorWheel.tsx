"use client";

/**
 * WARP-897 / WARP-1395: the round hue/saturation picker — hue is the angle,
 * saturation is the distance from the white center (the picker every
 * smart-home app trains users on). Refined to the devices-rooms design
 * packet §3: a 13-stop conic hue sweep (replaces the bunched 6-stop), a
 * calibrated white desaturation core (fixes the 0/35/72% wash), a thumb
 * that scales + lifts on drag, a live readout row, an lg color-temperature
 * arc, and the four feedback states (pending / applied / failed / offline)
 * that give WARP-1374 a spec.
 *
 * Accessibility (unchanged contract): ARIA has no 2D slider, so the wheel
 * exposes the standard compromise — a single focusable `role="slider"`
 * where ←/→ steer hue (Shift = coarse), ↑/↓ steer saturation, and
 * `aria-valuetext` announces the human answer ("Purple, 80% saturated").
 * Hue 0° sits at the top, clockwise, matching the gradient. The visible
 * readout string and the announcement are the SAME string.
 *
 * Content-color exemption: the hue field, saturation core, thumb fill, and
 * readout dot are the light's ACTUAL output — data, not UI palette. Every
 * ring / border / label around them is tokens.
 */

import { useCallback, useRef, useState } from "react";
import { WifiOff, AlertTriangle } from "lucide-react";

export type WheelFeedback = "idle" | "pending" | "failed" | "offline";

// 13-stop conic hue sweep, 0° at top, clockwise (packet §3.1) — perceptually
// evener than the shipped 6-stop `hsl()` ring that bunched in cyan/blue.
const HUE_RING = `conic-gradient(from 0deg,
  hsl(0 90% 55%), hsl(30 90% 55%), hsl(60 88% 52%), hsl(90 78% 50%),
  hsl(120 72% 48%), hsl(150 70% 47%), hsl(180 72% 50%), hsl(210 82% 56%),
  hsl(240 84% 60%), hsl(270 78% 60%), hsl(300 80% 58%), hsl(330 84% 58%),
  hsl(360 90% 55%))`;

// Calibrated white desaturation core — mid-radius reads as genuine mid-sat.
const SAT_CORE = `radial-gradient(circle at 50% 50%,
  #fff 0%, rgba(255,255,255,0.78) 20%, rgba(255,255,255,0.42) 52%,
  rgba(255,255,255,0.12) 72%, rgba(255,255,255,0) 82%)`;

// The 8 named hues — swatches + the nearest-name readout.
export const NAMED_HUES: Array<{ name: string; hue: number }> = [
  { name: "Red", hue: 0 },
  { name: "Orange", hue: 30 },
  { name: "Yellow", hue: 52 },
  { name: "Green", hue: 120 },
  { name: "Teal", hue: 180 },
  { name: "Blue", hue: 240 },
  { name: "Purple", hue: 275 },
  { name: "Pink", hue: 320 },
];

export const TEMP = {
  warm: { kelvin: 2700, label: "Warm white", dot: "#ffd8a3" },
  cool: { kelvin: 5000, label: "Cool white", dot: "#eaf2ff" },
} as const;

const K_MIN = 2000;
const K_MAX = 6500;

export function nearestName(hue: number): string {
  return NAMED_HUES.reduce((best, n) => {
    const d = Math.min(Math.abs(n.hue - hue), 360 - Math.abs(n.hue - hue));
    const bd = Math.min(
      Math.abs(best.hue - hue),
      360 - Math.abs(best.hue - hue),
    );
    return d < bd ? n : best;
  }, NAMED_HUES[0]).name;
}

function thumbColor(hue: number, sat: number): string {
  return `hsl(${hue} ${Math.max(6, Math.round(sat))}% 52%)`;
}

// 2000K amber → 6500K blue-white, coarse lerp for the readout dot only.
function kelvinDot(k: number): string {
  const t = Math.max(0, Math.min(1, (k - K_MIN) / (K_MAX - K_MIN)));
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${lerp(255, 214)} ${lerp(190, 232)} ${lerp(120, 255)})`;
}

interface ColorWheelProps {
  /** 0-360 degrees */
  hue: number;
  /** 0-100 percent */
  saturation: number;
  /** "hue" = full-color picker; "temp" = white mode (thumb parks center) */
  mode: "hue" | "temp";
  /** Selected color temperature when mode === "temp" */
  kelvin?: number;
  size?: "sm" | "lg";
  feedback?: WheelFeedback;
  /** When to show the readout row (default: lg only) */
  showReadout?: boolean;
  onChange: (hue: number, saturation: number) => void;
}

export function ColorWheel({
  hue,
  saturation,
  mode,
  kelvin = TEMP.warm.kelvin,
  size = "sm",
  feedback = "idle",
  showReadout,
  onChange,
}: ColorWheelProps) {
  const wheelPx = size === "lg" ? 180 : 120;
  const thumbPx = size === "lg" ? 24 : 20;
  const showRead = showReadout ?? size === "lg";
  const wheelRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const disabled = feedback === "offline";
  const white = mode === "temp";
  const radius = wheelPx / 2;
  const usable = radius - thumbPx / 2;

  const angleRad = ((hue - 90) * Math.PI) / 180;
  const dist = (Math.min(Math.max(saturation, 0), 100) / 100) * usable;
  const thumbX = radius + dist * Math.cos(angleRad);
  const thumbY = radius + dist * Math.sin(angleRad);

  const fromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = wheelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      const dx = clientX - (rect.left + rect.width / 2);
      const dy = clientY - (rect.top + rect.height / 2);
      const h = (Math.atan2(dy, dx) * (180 / Math.PI) + 90 + 360) % 360;
      const s = Math.min(
        100,
        Math.round((Math.hypot(dx, dy) / (rect.width / 2 - thumbPx / 2)) * 100),
      );
      onChange(Math.round(h), s);
    },
    [onChange, thumbPx],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus();
      setDragging(true);
      fromPointer(e.clientX, e.clientY);
    },
    [fromPointer, disabled],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons !== 1 || disabled) return;
      fromPointer(e.clientX, e.clientY);
    },
    [fromPointer, disabled],
  );

  const endDrag = useCallback(() => setDragging(false), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const hueStep = e.shiftKey ? 15 : 5;
      const satStep = 5;
      let h = hue;
      let s = saturation;
      switch (e.key) {
        case "ArrowRight":
          h = (hue + hueStep) % 360;
          break;
        case "ArrowLeft":
          h = (hue - hueStep + 360) % 360;
          break;
        case "ArrowUp":
          s = Math.min(100, saturation + satStep);
          break;
        case "ArrowDown":
          s = Math.max(0, saturation - satStep);
          break;
        default:
          return;
      }
      e.preventDefault();
      onChange(h, s);
    },
    [hue, saturation, onChange, disabled],
  );

  // Readout content — the same string the screen reader announces.
  const readout = white
    ? {
        dot: kelvinDot(kelvin),
        name: kelvin <= 3500 ? TEMP.warm.label : TEMP.cool.label,
        meta: `${kelvin}K`,
        announce: `${kelvin <= 3500 ? TEMP.warm.label : TEMP.cool.label}, ${kelvin}K`,
      }
    : {
        dot: thumbColor(hue, saturation),
        name: nearestName(hue),
        meta: `${Math.round(saturation)}%`,
        announce: `${nearestName(hue)}, ${Math.round(saturation)}% saturated`,
      };

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        ref={wheelRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Color"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hue)}
        aria-valuetext={readout.announce}
        aria-disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        className={`relative flex-shrink-0 rounded-full touch-none
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]
          focus-visible:ring-offset-2 ${disabled ? "opacity-40 cursor-default" : "cursor-crosshair"}`}
        style={{
          width: wheelPx,
          height: wheelPx,
          background: `${SAT_CORE}, ${HUE_RING}`,
          border: "1px solid var(--card-bd)",
        }}
      >
        {white ? (
          // White mode — the thumb parks at center with the temperature dot.
          <span
            aria-hidden="true"
            className="absolute rounded-full pointer-events-none"
            style={{
              width: thumbPx,
              height: thumbPx,
              left: radius - thumbPx / 2,
              top: radius - thumbPx / 2,
              background: readout.dot,
              border: "2px solid #ffffff",
              boxShadow: "0 0 0 1px var(--card-bd), 0 1px 3px rgba(0,0,0,0.25)",
            }}
          />
        ) : (
          !disabled && (
            <span
              aria-hidden="true"
              className={`absolute rounded-full pointer-events-none transition-[transform,box-shadow] duration-200 ease-smooth ${
                feedback === "pending" ? "cw-pending-ring" : ""
              }`}
              style={{
                width: thumbPx,
                height: thumbPx,
                left: thumbX - thumbPx / 2,
                top: thumbY - thumbPx / 2,
                background: thumbColor(hue, saturation),
                border: "2px solid #ffffff",
                boxShadow: dragging
                  ? "0 0 0 1px var(--card-bd), 0 3px 8px rgba(0,0,0,0.28)"
                  : "0 0 0 1px var(--card-bd), 0 1px 3px rgba(0,0,0,0.25)",
                transform: dragging ? "scale(1.15)" : "scale(1)",
                ...(feedback === "pending"
                  ? { animation: "cw-pulse 2s var(--ease-smooth, ease) infinite" }
                  : {}),
              }}
            />
          )
        )}
      </div>

      {showRead && (
        <div
          role="status"
          className={`flex items-center gap-2 min-h-[20px] text-[13px] ${
            feedback === "failed"
              ? "type-footnote text-system-red bg-system-red/10 rounded-md px-2.5 py-1.5"
              : ""
          }`}
          style={feedback === "failed" ? undefined : { color: "var(--text-muted)" }}
        >
          {feedback === "offline" ? (
            <>
              <WifiOff size={13} className="flex-none" />
              <span>Offline — showing last color</span>
            </>
          ) : feedback === "failed" ? (
            <>
              <AlertTriangle size={13} className="flex-none" />
              <span>That didn&rsquo;t apply — showing the light&rsquo;s actual color.</span>
            </>
          ) : (
            <>
              <span
                aria-hidden="true"
                className={`w-3.5 h-3.5 rounded-full flex-none ${
                  feedback === "pending" ? "cw-pending-ring" : ""
                }`}
                style={{
                  background: readout.dot,
                  boxShadow: "0 0 0 1px var(--card-bd)",
                  ...(feedback === "pending"
                    ? { animation: "cw-pulse 2s var(--ease-smooth, ease) infinite" }
                    : {}),
                }}
              />
              <span className="font-medium" style={{ color: "var(--text)" }}>
                {readout.name}
              </span>
              {size === "lg" && (
                <span
                  className="font-mono text-[12px]"
                  style={{ color: "var(--text-faint)" }}
                >
                  {readout.meta}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface TempArcProps {
  mode: "hue" | "temp";
  kelvin: number;
  onPick: (kelvin: number) => void;
}

/**
 * WARP-1395 §3.3: the color-temperature arc (lg only). A slim gradient
 * capsule from 2000K amber to 6500K blue-white with the two labeled detents
 * (Warm / Cool) that are the only points `sm` exposes as its two white
 * swatches. Selecting temperature puts the wheel in white mode.
 */
export function TempArc({ mode, kelvin, onPick }: TempArcProps) {
  const white = mode === "temp";
  const trackRef = useRef<HTMLDivElement>(null);

  const setFrom = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onPick(Math.round((K_MIN + t * (K_MAX - K_MIN)) / 100) * 100);
  }, [onPick]);

  const handleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setFrom(e.clientX);
    },
    [setFrom],
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const base = white ? kelvin : TEMP.warm.kelvin;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        onPick(Math.min(K_MAX, base + 100));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        onPick(Math.max(K_MIN, base - 100));
      }
    },
    [white, kelvin, onPick],
  );

  const pos = white ? ((kelvin - K_MIN) / (K_MAX - K_MIN)) * 100 : null;

  return (
    <div className="w-full max-w-[220px] flex flex-col gap-1.5">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Color temperature"
        aria-valuemin={K_MIN}
        aria-valuemax={K_MAX}
        aria-valuenow={white ? kelvin : TEMP.warm.kelvin}
        aria-valuetext={white ? `${kelvin} kelvin` : "Not in white mode"}
        onPointerDown={handleDown}
        onPointerMove={(e) => e.buttons === 1 && setFrom(e.clientX)}
        onKeyDown={handleKey}
        className="relative h-5 rounded-full cursor-pointer touch-none
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        style={{
          background:
            "linear-gradient(90deg, #ffb765, #fff2e0 46%, #e9f1ff 62%, #cfe0ff)",
          boxShadow: "inset 0 0 0 1px var(--card-bd)",
        }}
      >
        {pos != null && (
          <span
            aria-hidden="true"
            className="absolute top-1/2 w-4 h-4 rounded-full"
            style={{
              left: `${pos}%`,
              transform: "translate(-50%, -50%)",
              background: "#ffffff",
              boxShadow: "0 0 0 1px var(--card-bd), 0 1px 3px rgba(0,0,0,0.25)",
            }}
          />
        )}
      </div>
      <div className="flex justify-between">
        <button
          type="button"
          onClick={() => onPick(TEMP.warm.kelvin)}
          className={`text-[12px] px-1.5 py-0.5 rounded-md transition-colors ${
            white && kelvin <= 3500
              ? "text-[var(--brand)] font-semibold"
              : "text-[var(--text-muted)] hover:text-[var(--text)]"
          }`}
        >
          Warm
        </button>
        <button
          type="button"
          onClick={() => onPick(TEMP.cool.kelvin)}
          className={`text-[12px] px-1.5 py-0.5 rounded-md transition-colors ${
            white && kelvin > 3500
              ? "text-[var(--brand)] font-semibold"
              : "text-[var(--text-muted)] hover:text-[var(--text)]"
          }`}
        >
          Cool
        </button>
      </div>
    </div>
  );
}
