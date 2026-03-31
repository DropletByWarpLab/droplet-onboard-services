"use client";

import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import type { StorageStats } from "@/lib/types";

interface StorageGaugeProps {
  storage: StorageStats | null;
  isLoading?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function StorageGauge({ storage, isLoading }: StorageGaugeProps) {
  const [animatedPct, setAnimatedPct] = useState(0);
  const percentage = storage?.percentage ?? 0;

  useEffect(() => {
    const timeout = setTimeout(() => setAnimatedPct(percentage), 120);
    return () => clearTimeout(timeout);
  }, [percentage]);

  // Arc geometry
  const size = 260;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 95;
  const strokeWidth = 12;

  // 270-degree arc: 7 o'clock (225°) sweeping clockwise to 5 o'clock (495°/135°)
  const startAngle = 225;
  const sweepAngle = 270;

  function toRad(deg: number) {
    return ((deg - 90) * Math.PI) / 180;
  }

  function pointOnCircle(angleDeg: number, r: number) {
    const rad = toRad(angleDeg);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeArc(r: number, startDeg: number, endDeg: number): string {
    const start = pointOnCircle(startDeg, r);
    const end = pointOnCircle(endDeg, r);
    const sweep = endDeg - startDeg;
    const largeArc = sweep > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
  }

  // Color zone bands
  const zones = [
    { from: 0, to: 75, color: "var(--color-system-green)" },
    { from: 75, to: 90, color: "var(--color-system-orange)" },
    { from: 90, to: 100, color: "var(--color-system-red)" },
  ];

  // Tick marks
  const tickCount = 27;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const angle = startAngle + (sweepAngle * i) / tickCount;
    const rad = toRad(angle);
    const isMajor = i % 9 === 0;
    const innerR = radius + (isMajor ? 6 : 8);
    const outerR = radius + (isMajor ? 16 : 13);
    return {
      x1: cx + innerR * Math.cos(rad),
      y1: cy + innerR * Math.sin(rad),
      x2: cx + outerR * Math.cos(rad),
      y2: cy + outerR * Math.sin(rad),
      isMajor,
    };
  });

  // Fill color based on usage
  const fillColor =
    animatedPct > 90
      ? "var(--color-system-red)"
      : animatedPct > 75
      ? "var(--color-system-orange)"
      : "var(--color-system-green)";

  // Compute the fill arc end angle (draw from start to fill%)
  const fillEndAngle = startAngle + (sweepAngle * Math.min(animatedPct, 100)) / 100;
  // Need at least a tiny arc to render
  const showFill = animatedPct > 0.5;

  if (isLoading) {
    return (
      <div className="dp-card p-8 flex items-center justify-center" style={{ minHeight: 340 }}>
        <div className="w-[240px] h-[240px] rounded-full animate-shimmer" />
      </div>
    );
  }

  return (
    <div className="dp-card p-8">
      <div className="flex items-center gap-2 mb-6">
        <HardDrive size={16} className="text-label-secondary" />
        <h3 className="type-footnote text-label-secondary uppercase tracking-wide">
          Storage
        </h3>
      </div>

      <div className="flex flex-col items-center">
        <svg
          width={size}
          height={size * 0.72}
          viewBox={`0 ${size * 0.08} ${size} ${size * 0.72}`}
          className="overflow-visible"
        >
          {/* Zone bands (green / yellow / red background arcs) */}
          {zones.map((zone, idx) => {
            const zoneStart = startAngle + (sweepAngle * zone.from) / 100;
            const zoneEnd = startAngle + (sweepAngle * zone.to) / 100;
            return (
              <path
                key={idx}
                d={describeArc(radius, zoneStart, zoneEnd)}
                fill="none"
                stroke={zone.color}
                strokeWidth={3}
                strokeLinecap="round"
                opacity={0.2}
              />
            );
          })}

          {/* Fill arc — drawn from start angle to the computed fill angle */}
          {showFill && (
            <path
              d={describeArc(radius, startAngle, fillEndAngle)}
              fill="none"
              stroke={fillColor}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              style={{
                transition: "d 1s cubic-bezier(0.34, 1.56, 0.64, 1), stroke 0.5s ease",
              }}
            />
          )}

          {/* Tick marks */}
          {ticks.map((t, i) => (
            <line
              key={i}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke="var(--color-label-quaternary)"
              strokeWidth={t.isMajor ? 2 : 1}
              strokeLinecap="round"
            />
          ))}

          {/* Center percentage text */}
          <text
            x={cx}
            y={cy - 2}
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-label-primary"
            style={{
              fontSize: 44,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {Math.round(animatedPct)}
            <tspan style={{ fontSize: 20, fontWeight: 500 }}>%</tspan>
          </text>
          <text
            x={cx}
            y={cy + 28}
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-label-tertiary"
            style={{
              fontSize: 11,
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: 1.5,
            }}
          >
            used
          </text>
        </svg>

        {/* Storage details — with clear separation from the gauge */}
        {storage && storage.total > 0 && (
          <div className="text-center mt-6 pt-4 border-t border-separator w-full">
            <p className="type-subheadline text-label-primary">
              {formatBytes(storage.used)}{" "}
              <span className="text-label-tertiary">of</span>{" "}
              {formatBytes(storage.total)}
            </p>
            <p className="type-caption-1 text-label-tertiary mt-1">
              {formatBytes(storage.available)} available
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
