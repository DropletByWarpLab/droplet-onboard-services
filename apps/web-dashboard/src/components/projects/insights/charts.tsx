"use client";

// Chart primitives for Insights. The time series use recharts, the dashboard's
// existing chart library (components/context/*); the two ranked lists (workload,
// aging) are real tables with a bar in the cell, which is both the picture and
// its accessible alternative.
//
// Colours are the Projects surface's own tokens (projects.css `.pm-scope`):
// `--accent`, `--ok`, `--warn`, `--err`, `--text-*`, `--border*`, `--bg-*`.
// Nothing here introduces one, and state groups map the way brief §2.3 maps
// them. A colour never carries meaning alone: every series has a text label in
// the legend, and every chart has its numbers as a table (ChartCard).

import type { JSX, ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { bucketLabel, bucketTitle, ymdLabel } from "./readings";
import type { InsightsBand, InsightsCfdDay, InsightsGroupBy } from "./types";

const CHART_HEIGHT = 220;
const AXIS_TICK = { fontSize: 11, fill: "var(--text-3)" };
const TOOLTIP_STYLE = {
  background: "var(--bg-canvas)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--text)",
};
const CURSOR = { fill: "var(--bg-hover)" };

/** recharts 3 hands a tooltip value over as `ValueType | undefined`. */
const asText = (v: unknown): string => (typeof v === "number" ? String(v) : String(v ?? ""));

/** Title for a tooltip, carried on each datum so it need not be rebuilt from the axis label. */
const titleOf = (_label: unknown, payload: ReadonlyArray<{ payload?: unknown }> | undefined): string =>
  (payload?.[0]?.payload as { title?: string } | undefined)?.title ?? "";

// ── State groups ─────────────────────────────────────────────────────────────

/** Bottom to top of the cumulative flow: finished work at the base, the backlog on top. */
export const BAND_STACK_ORDER: readonly InsightsBand[] = [
  "completed",
  "cancelled",
  "started",
  "unstarted",
  "backlog",
  "unknown",
];

export const BAND_META: Record<InsightsBand, { label: string; color: string }> = {
  completed: { label: "Done", color: "var(--ok)" },
  cancelled: { label: "Cancelled", color: "var(--err)" },
  started: { label: "In progress", color: "var(--warn)" },
  unstarted: { label: "To do", color: "var(--accent)" },
  backlog: { label: "Backlog", color: "var(--text-4)" },
  unknown: { label: "Unplaced", color: "var(--border-strong)" },
};

export function Legend({ items }: { items: Array<{ label: string; color: string }> }): JSX.Element {
  return (
    <ul className="pm-legend">
      {items.map((i) => (
        <li key={i.label}>
          <span className="sw" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

// ── Time series ──────────────────────────────────────────────────────────────

export function ThroughputChart({
  buckets,
  groupBy,
}: {
  buckets: Array<{ start: string; completed: number }>;
  groupBy: InsightsGroupBy;
}): JSX.Element {
  const data = buckets.map((b) => ({
    label: bucketLabel(b.start, groupBy),
    title: bucketTitle(b.start, groupBy),
    completed: b.completed,
  }));
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer={false}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
        <Tooltip cursor={CURSOR} contentStyle={TOOLTIP_STYLE} labelFormatter={titleOf} formatter={(v) => [asText(v), "Finished"]} />
        <Bar dataKey="completed" name="Finished" fill="var(--ok)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export const FLOW_LEGEND = [
  { label: "Added", color: "var(--accent)" },
  { label: "Finished", color: "var(--ok)" },
];

export function FlowChart({
  buckets,
  groupBy,
}: {
  buckets: Array<{ start: string; created: number; completed: number }>;
  groupBy: InsightsGroupBy;
}): JSX.Element {
  const data = buckets.map((b) => ({
    label: bucketLabel(b.start, groupBy),
    title: bucketTitle(b.start, groupBy),
    created: b.created,
    completed: b.completed,
  }));
  return (
    <>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer={false}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
          <Tooltip cursor={CURSOR} contentStyle={TOOLTIP_STYLE} labelFormatter={titleOf} formatter={(v, name) => [asText(v), String(name)]} />
          <Bar dataKey="created" name="Added" fill="var(--accent)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="completed" name="Finished" fill="var(--ok)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <Legend items={FLOW_LEGEND} />
    </>
  );
}

export function CumulativeFlowChart({
  days,
  groups,
}: {
  days: InsightsCfdDay[];
  groups: InsightsBand[];
}): JSX.Element {
  const bands = BAND_STACK_ORDER.filter((b) => groups.includes(b));
  const data = days.map((d) => ({ ...d, label: ymdLabel(d.date), title: ymdLabel(d.date) }));
  return (
    <>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer={false}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={40} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={titleOf} formatter={(v, name) => [asText(v), String(name)]} />
          {bands.map((b) => (
            <Area
              key={b}
              dataKey={b}
              name={BAND_META[b].label}
              stackId="flow"
              type="monotone"
              fill={BAND_META[b].color}
              fillOpacity={0.85}
              // A hairline of the card colour between bands keeps the boundary
              // visible even where two band colours sit close in lightness.
              stroke="var(--bg-canvas)"
              strokeWidth={1}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      {/* Listed top to bottom in the order they stack, so the legend reads like the chart. */}
      <Legend items={[...bands].reverse().map((b) => BAND_META[b])} />
    </>
  );
}

export function DurationChart({
  labels,
  shortLabels,
  counts,
}: {
  /** Full bucket names, for the tooltip. */
  labels: string[];
  /** The same buckets as compact axis labels (days). */
  shortLabels: string[];
  counts: number[];
}): JSX.Element {
  const data = counts.map((n, i) => ({ label: shortLabels[i], title: labels[i], count: n }));
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer={false}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={0} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
        <Tooltip cursor={CURSOR} contentStyle={TOOLTIP_STYLE} labelFormatter={titleOf} formatter={(v) => [asText(v), "Items"]} />
        <Bar dataKey="count" name="Items" fill="var(--accent)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Ranked lists: a table with a bar in the cell ─────────────────────────────

export interface BarRow {
  key: string;
  /** The row header: who or what this row is about. */
  header: ReactNode;
  value: number;
  valueLabel: string;
  color: string;
  /** A second plain column, when the table has one. */
  extra?: string;
}

export function BarTable({
  caption,
  headers,
  rows,
  max,
  mark,
  markTitle,
}: {
  caption: string;
  headers: { row: string; value: string; extra?: string };
  rows: BarRow[];
  /** The value the longest bar stands for. */
  max: number;
  /** A reference value drawn as a tick across every bar (visual only; the reading says it in words). */
  mark?: number | null;
  markTitle?: string;
}): JSX.Element {
  return (
    <div className="pm-datatable-wrap pm-bartable-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="pm-datatable pm-bartable">
        <caption className="pm-sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{headers.row}</th>
            <th scope="col">{headers.value}</th>
            {headers.extra && <th scope="col">{headers.extra}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.header}</th>
              <td>
                <span className="pm-barcell">
                  <span className="pm-bar" aria-hidden="true">
                    <span className="fill" style={{ width: `${Math.max(2, (r.value / Math.max(max, 1)) * 100)}%`, background: r.color }} />
                    {mark != null && mark > 0 && mark <= max && (
                      <span className="mark" title={markTitle} style={{ left: `${(mark / max) * 100}%` }} />
                    )}
                  </span>
                  <span className="pm-mono n">{r.valueLabel}</span>
                </span>
              </td>
              {headers.extra && <td className="pm-mono">{r.extra}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
