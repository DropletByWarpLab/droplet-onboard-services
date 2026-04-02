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

  // Arc geometry — padded viewBox so nothing is clipped
  const pad = 20;
  const innerSize = 220;
  const size = innerSize + pad * 2;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 90;
  const strokeWidth = 12;

  // 270-degree arc: 7 o'clock (225°) → 5 o'clock (135°) going clockwise through 12 o'clock
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

  // Full background arc path
  const fullArcPath = describeArc(radius, startAngle, startAngle + sweepAngle);

  // Color zone bands — rendered as colored arcs behind the fill
  const zones = [
    { from: 0, to: 75, color: "#30d158" },   // green
    { from: 75, to: 90, color: "#ff9f0a" },   // orange
    { from: 90, to: 100, color: "#ff453a" },   // red
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
    animatedPct > 90 ? "#ff453a" : animatedPct > 75 ? "#ff9f0a" : "#30d158";

  // Compute the fill arc end angle
  const fillEndAngle =
    startAngle + (sweepAngle * Math.min(animatedPct, 100)) / 100;
  const showFill = animatedPct > 0.5;

  // SVG rendered height — crop bottom gap of the arc
  const svgHeight = size * 0.85;

  if (isLoading) {
    return (
      <div
        className="dp-card p-8 flex items-center justify-center"
        style={{ minHeight: 340 }}
      >
        <div className="w-[240px] h-[240px] rounded-full animate-shimmer" />
      </div>
    );
  }

  return (
    <div className="dp-card p-8">
      <div className="flex items-center gap-2 mb-4">
        <HardDrive size={16} style={{ color: "rgba(235,235,245,0.6)" }} />
        <h3
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "rgba(235,235,245,0.6)",
            textTransform: "uppercase",
            letterSpacing: 1.2,
          }}
        >
          Storage
        </h3>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <svg
          width={size}
          height={svgHeight}
          viewBox={`0 0 ${size} ${svgHeight}`}
          overflow="visible"
        >
          {/* Subtle background track */}
          <path
            d={fullArcPath}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />

          {/* Color zone bands */}
          {zones.map((zone, idx) => {
            const zoneStart = startAngle + (sweepAngle * zone.from) / 100;
            const zoneEnd = startAngle + (sweepAngle * zone.to) / 100;
            return (
              <path
                key={idx}
                d={describeArc(radius, zoneStart, zoneEnd)}
                fill="none"
                stroke={zone.color}
                strokeWidth={5}
                strokeLinecap="round"
                opacity={0.3}
              />
            );
          })}

          {/* Fill arc */}
          {showFill && (
            <path
              d={describeArc(radius, startAngle, fillEndAngle)}
              fill="none"
              stroke={fillColor}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
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
              stroke={t.isMajor ? "rgba(235,235,245,0.4)" : "rgba(235,235,245,0.2)"}
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
            fill="rgba(255,255,255,0.92)"
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
            fill="rgba(235,235,245,0.4)"
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

        {/* Storage details */}
        {storage && storage.total > 0 && (
          <div
            style={{
              textAlign: "center",
              marginTop: 20,
              paddingTop: 16,
              borderTop: "1px solid rgba(255,255,255,0.08)",
              width: "100%",
            }}
          >
            <p className="type-subheadline text-label-primary">
              {formatBytes(storage.used)}{" "}
              <span className="text-label-tertiary">of</span>{" "}
              {formatBytes(storage.total)}
            </p>
            <p className="type-caption-1 text-label-tertiary" style={{ marginTop: 4 }}>
              {formatBytes(storage.available)} available
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
