"use client";

/**
 * WARP-225 — 7-day indexing throughput area-chart with gradient fill.
 *
 * Recharts `AreaChart` rendered into a responsive container so the
 * sparkline scales with the hero band. Smooth (`monotone`) curve;
 * 4-color palette uses the indigo accent for the line + a fading
 * gradient for the fill.
 */

import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ThroughputDay } from "@/lib/types-context-stats";

interface Props {
  data: ThroughputDay[];
}

// recharts 3 widened `Tooltip`'s formatter signature: the value arrives as
// `ValueType | undefined` (number | string | Array<number | string>) rather
// than the chart's own datum type, so the callback has to narrow it itself.
// `count` is always numeric, so anything else is a no-data frame → 0.
function asNumber(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}

export function ThroughputSparkline({ data }: Props) {
  // Densified upstream — assume 7 entries oldest-first. If empty (zero
  // files anywhere), the parent shows the empty-state card instead;
  // here we just render a flat ribbon so a transient zero-state in the
  // SWR cache doesn't shift the layout.
  return (
    <div className="dp-tile p-6" data-testid="throughput-sparkline">
      <div className="flex items-baseline justify-between mb-3">
        <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em]">
          Indexing Throughput
        </p>
        <p className="type-caption-1 text-label-tertiary">Last 7 days</p>
      </div>
      <div className="h-[120px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient id="sparklineFill" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="var(--color-accent, #6366f1)"
                  stopOpacity={0.45}
                />
                <stop
                  offset="100%"
                  stopColor="var(--color-accent, #6366f1)"
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>
            <XAxis dataKey="day" hide />
            <YAxis hide />
            <Tooltip
              contentStyle={{
                background: "var(--color-surface-raised, #fff)",
                border: "1px solid var(--color-separator, #e5e7eb)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(v) => [`${asNumber(v)} files`, "Indexed"]}
              // recharts 3 types `label` as ReactNode; this stays an identity
              // passthrough (same as the default) so the day string renders
              // verbatim.
              labelFormatter={(label) => label}
            />
            <Area
              type="monotone"
              dataKey="count"
              stroke="var(--color-accent, #6366f1)"
              strokeWidth={2}
              fill="url(#sparklineFill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
