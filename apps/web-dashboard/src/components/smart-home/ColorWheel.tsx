"use client";

/**
 * WARP-897: the round hue/saturation picker — hue is the angle, saturation
 * is the distance from the white center (the picker every smart-home app
 * trains users on). Pure CSS disc (conic hue ring over a radial white
 * falloff), a positioned thumb, pointer capture for dragging.
 *
 * Accessibility: ARIA has no 2D slider, so the wheel exposes the standard
 * compromise — a single focusable `role="slider"` where ←/→ steer hue,
 * ↑/↓ steer saturation, and `aria-valuetext` announces the human answer
 * ("Purple, 80% saturated"). Hue 0° sits at the top, clockwise, matching
 * the gradient.
 */

import { useCallback, useRef } from "react";

interface ColorWheelProps {
  /** 0-360 degrees */
  hue: number;
  /** 0-100 percent */
  saturation: number;
  /** Wheel diameter in px */
  size?: number;
  /** Human-readable announcement, e.g. "Purple, 80% saturated" */
  ariaValueText: string;
  onChange: (hue: number, saturation: number) => void;
}

const THUMB = 16;

export function ColorWheel({
  hue,
  saturation,
  size = 148,
  ariaValueText,
  onChange,
}: ColorWheelProps) {
  const wheelRef = useRef<HTMLDivElement>(null);
  const radius = size / 2;
  const usable = radius - THUMB / 2;

  // Thumb position from hue/sat — hue 0° at the top, clockwise.
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
        Math.round((Math.hypot(dx, dy) / (rect.width / 2 - THUMB / 2)) * 100),
      );
      onChange(Math.round(h), s);
    },
    [onChange],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus();
      fromPointer(e.clientX, e.clientY);
    },
    [fromPointer],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons !== 1) return;
      fromPointer(e.clientX, e.clientY);
    },
    [fromPointer],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
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
    [hue, saturation, onChange],
  );

  return (
    <div
      ref={wheelRef}
      role="slider"
      tabIndex={0}
      aria-label="Color"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(hue)}
      aria-valuetext={ariaValueText}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onKeyDown={handleKeyDown}
      className="relative flex-shrink-0 rounded-full cursor-crosshair touch-none
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]
        focus-visible:ring-offset-2"
      style={{
        width: size,
        height: size,
        // Content colors — the light's actual output, not UI palette (same
        // exemption as the swatches). Conic hue ring, white desaturation
        // core, hairline border.
        background:
          "radial-gradient(circle closest-side, #ffffff 0%, rgba(255,255,255,0.55) 35%, rgba(255,255,255,0) 72%), " +
          "conic-gradient(from 0deg, hsl(0 90% 55%), hsl(60 90% 55%), hsl(120 90% 55%), hsl(180 90% 55%), hsl(240 90% 55%), hsl(300 90% 55%), hsl(360 90% 55%))",
        border: "1px solid var(--card-bd)",
      }}
    >
      <span
        aria-hidden="true"
        className="absolute rounded-full pointer-events-none"
        style={{
          width: THUMB,
          height: THUMB,
          left: thumbX - THUMB / 2,
          top: thumbY - THUMB / 2,
          background: `hsl(${hue} ${saturation}% 55%)`,
          border: "2px solid #ffffff",
          boxShadow: "0 0 0 1px var(--card-bd), 0 1px 3px rgba(0,0,0,0.25)",
        }}
      />
    </div>
  );
}
