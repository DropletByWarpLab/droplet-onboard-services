"use client";

/**
 * WARP-225 — horizontal bar chart of indexed-text-bytes by category.
 *
 * Same data as the coverage donut, lensed by `bytes` instead of file
 * count. Useful because audio + video upload as small files but
 * extract into many chunks; document-heavy users vs. media-heavy users
 * read very different here.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SourceCategoryRow } from "@/lib/types-context-stats";
import { labelForCategory } from "@/lib/category-icons";

interface Props {
  data: SourceCategoryRow[];
}

// Mirrors the donut palette so the eye keeps a category-color binding
// across the two adjacent charts.
const BAR_COLORS: Record<string, string> = {
  audio: "#7c3aed",
  video: "#0ea5e9",
  pdf: "#10b981",
  image: "#f59e0b",
  email: "#ec4899",
  archive: "#64748b",
  text: "#6366f1",
  other: "#94a3b8",
};

function formatBytesShort(b: number): string {
  if (b < 1024) return `${b}`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}K`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}M`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)}G`;
}

// recharts 3 widened `Tooltip`'s formatter signature: the value arrives as
// `ValueType | undefined` (number | string | Array<number | string>) rather
// than the chart's own datum type, so the callback has to narrow it itself.
// Every series feeding these tooltips is numeric, so anything else is a
// no-data frame and formats as zero.
function asNumber(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}

function formatBytesLong(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function BytesBySource({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="dp-tile p-6 flex flex-col items-center justify-center min-h-[280px]">
        <p className="type-caption-1 text-label-tertiary">No bytes yet</p>
      </div>
    );
  }
  // Sorted desc by bytes for visual hierarchy.
  const sorted = [...data].sort((a, b) => b.bytes - a.bytes);
  const labelled = sorted.map((d) => ({
    ...d,
    label: labelForCategory(d.category),
  }));

  return (
    <div className="dp-tile p-6" data-testid="bytes-by-source">
      <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em] mb-4">
        Bytes by Source
      </p>
      <div className="h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={labelled}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--color-separator, #e5e7eb)"
              horizontal={false}
            />
            <XAxis
              type="number"
              tickFormatter={formatBytesShort}
              tick={{ fontSize: 11, fill: "var(--color-label-tertiary, #6b7280)" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              dataKey="label"
              type="category"
              width={80}
              tick={{ fontSize: 12, fill: "var(--color-label-secondary, #4b5563)" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: "var(--color-surface-secondary, #f3f4f6)" }}
              contentStyle={{
                background: "var(--color-surface-raised, #fff)",
                border: "1px solid var(--color-separator, #e5e7eb)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(v) => [formatBytesLong(asNumber(v)), "Bytes"]}
            />
            <Bar dataKey="bytes" radius={[0, 6, 6, 0]}>
              {labelled.map((d) => (
                <Cell
                  key={d.category}
                  fill={BAR_COLORS[d.category] ?? "#94a3b8"}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
