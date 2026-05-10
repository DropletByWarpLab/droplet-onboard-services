"use client";

/**
 * WARP-225 — coverage donut by MIME category.
 *
 * Hover/tap a slice → that category's count + bytes float in the
 * center. A small legend below names the slices; we don't use
 * recharts' default legend because the design uses our own type
 * tokens.
 *
 * Visual palette:
 *   - We pick from a small distinctly-perceptible HSL ramp keyed on
 *     category. The 4-color semantic palette (green/amber/red/indigo)
 *     reads "states" in this app, so we need a separate but coherent
 *     8-slice ramp here. Saturation is muted to keep it readable next
 *     to the indigo CTAs.
 */

import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import type { SourceCategoryRow } from "@/lib/types-context-stats";
import { labelForCategory } from "@/lib/category-icons";

interface Props {
  data: SourceCategoryRow[];
}

const SLICE_COLORS: Record<string, string> = {
  audio: "#7c3aed",   // violet
  video: "#0ea5e9",   // sky
  pdf: "#10b981",     // emerald
  image: "#f59e0b",   // amber-but-warm (state amber stays red-orange)
  email: "#ec4899",   // pink
  archive: "#64748b", // slate
  text: "#6366f1",    // indigo (matches CTAs)
  other: "#94a3b8",   // slate-light
};

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function CoverageDonut({ data }: Props) {
  const [active, setActive] = useState<number | null>(null);
  const totalFiles = data.reduce((acc, d) => acc + d.files, 0);
  const focused = active !== null ? data[active] : null;

  if (data.length === 0) {
    return (
      <div className="dp-tile p-6 flex flex-col items-center justify-center min-h-[280px]">
        <p className="type-caption-1 text-label-tertiary">No coverage yet</p>
      </div>
    );
  }

  return (
    <div className="dp-tile p-6" data-testid="coverage-donut">
      <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em] mb-4">
        Coverage
      </p>
      <div className="relative h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="files"
              nameKey="category"
              innerRadius={68}
              outerRadius={96}
              paddingAngle={2}
              stroke="none"
              onMouseEnter={(_, idx) => setActive(idx)}
              onMouseLeave={() => setActive(null)}
              isAnimationActive={true}
            >
              {data.map((d, i) => (
                <Cell
                  key={d.category}
                  fill={SLICE_COLORS[d.category] ?? "#94a3b8"}
                  opacity={active === null || active === i ? 1 : 0.45}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {focused ? (
            <>
              <p className="type-caption-1 text-label-tertiary uppercase tracking-wider">
                {labelForCategory(focused.category)}
              </p>
              <p className="type-title-2 text-label-primary tabular-nums font-semibold">
                {focused.files}
              </p>
              <p className="type-caption-1 text-label-tertiary">
                {formatBytes(focused.bytes)}
              </p>
            </>
          ) : (
            <>
              <p className="type-title-2 text-label-primary tabular-nums font-semibold">
                {totalFiles}
              </p>
              <p className="type-caption-1 text-label-tertiary uppercase tracking-wider">
                files
              </p>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 mt-4">
        {data.map((d) => (
          <span
            key={d.category}
            className="inline-flex items-center gap-1.5 type-caption-1 text-label-secondary"
          >
            <span
              className="w-2 h-2 rounded-sm"
              style={{ background: SLICE_COLORS[d.category] ?? "#94a3b8" }}
            />
            {labelForCategory(d.category)}
            <span className="text-label-tertiary">· {d.files}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
