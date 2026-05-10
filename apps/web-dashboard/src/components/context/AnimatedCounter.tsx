"use client";

/**
 * WARP-225 — animated tick-up counter.
 *
 * Uses framer-motion's `useMotionValue` + `animate` to ease between two
 * numeric values over 300ms (ease-out per spec). Re-running on `value`
 * change makes the home widget and stat cards feel live without us
 * needing a real WebSocket — the eye reads the tick as freshness.
 *
 * Renders the rounded integer with `tabular-nums` so the digits don't
 * jitter horizontally as they tick.
 */

import { useEffect, useState } from "react";
import { animate, useMotionValue, useTransform } from "framer-motion";

export function AnimatedCounter({
  value,
  className,
  durationMs = 300,
}: {
  value: number;
  className?: string;
  durationMs?: number;
}) {
  const mv = useMotionValue(value);
  const rounded = useTransform(mv, (n) => Math.round(n).toLocaleString());
  const [display, setDisplay] = useState(rounded.get());

  useEffect(() => {
    const controls = animate(mv, value, {
      duration: durationMs / 1000,
      ease: [0.16, 1, 0.3, 1], // ease-out cubic-ish
    });
    return controls.stop;
  }, [value, mv, durationMs]);

  useEffect(() => {
    const unsub = rounded.on("change", (v) => setDisplay(v));
    return () => unsub();
  }, [rounded]);

  return <span className={`tabular-nums ${className ?? ""}`}>{display}</span>;
}
