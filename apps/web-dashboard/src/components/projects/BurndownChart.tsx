"use client";

// Burndown of one cycle (WARP-3521). recharts is already a dashboard dependency
// (components/context/ThroughputSparkline.tsx sets the house style), so the chart
// reuses it rather than draw a second charting approach.
//
// The picture is DECORATIVE to assistive technology: the SVG wrapper is
// aria-hidden and the same numbers are in a visually hidden data table beside a
// plain-language summary (brief §5.5 — the table is the screen-reader path).
// Nothing is colour-only either: the legend names every line, and the dashed /
// stepped / solid strokes differ in shape, not just hue.

import type { JSX } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtDay } from "./date-only";
import type { ProgressMode } from "./planning-bits";
import type { PmBurndown, PmBurndownPoint } from "./types";

interface Figures {
  scope: number | null;
  remaining: number | null;
  completed: number | null;
  ideal: number;
}

function figures(p: PmBurndownPoint, mode: ProgressMode): Figures {
  return mode === "estimate"
    ? { scope: p.scopeEstimate, remaining: p.remainingEstimate, completed: p.completedEstimate, ideal: p.idealEstimate }
    : { scope: p.scope, remaining: p.remaining, completed: p.completed, ideal: p.ideal };
}

/** The last day that has actual numbers (a day that has not started has none). */
function lastActual(b: PmBurndown): PmBurndownPoint | null {
  for (let i = b.days.length - 1; i >= 0; i -= 1) {
    if (b.days[i].scope !== null) return b.days[i];
  }
  return null;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The chart in one sentence — "5 of 12 items remaining · scope grew by 2" — which
 *  is what a screen reader hears before the table, and what a sighted reader gets
 *  without having to read a line chart. */
export function burndownSummary(b: PmBurndown, mode: ProgressMode): string {
  const last = lastActual(b);
  if (!last || b.days.length === 0) return "This cycle hasn't started yet.";
  const unit = mode === "estimate" ? plural(figures(last, mode).scope ?? 0, "point", "points") : plural(figures(last, mode).scope ?? 0, "item", "items");
  const now = figures(last, mode);
  const first = figures(b.days[0], mode);
  const base = `${now.remaining ?? 0} of ${now.scope ?? 0} ${unit} remaining`;
  const delta = (now.scope ?? 0) - (first.scope ?? 0);
  if (delta > 0) return `${base} · scope grew by ${delta}`;
  if (delta < 0) return `${base} · scope shrank by ${-delta}`;
  return `${base} · scope is unchanged`;
}

interface ChartRow {
  label: string;
  date: string;
  scope: number | null;
  remaining: number | null;
  ideal: number;
  added: number | null;
  removed: number | null;
}

function TooltipBody({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
  unit: string;
}): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  return (
    <div className="pm-surface pm-burndown-tip">
      <div className="pm-mono" style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 4 }}>
        {row.label}
      </div>
      <div>
        Remaining · <strong>{row.remaining ?? "—"}</strong> {unit}
      </div>
      <div>
        Scope · <strong>{row.scope ?? "—"}</strong>
      </div>
      <div>
        Ideal · <strong>{row.ideal}</strong>
      </div>
      {(row.added ?? 0) > 0 || (row.removed ?? 0) > 0 ? (
        <div style={{ color: "var(--text-2)", marginTop: 4 }}>
          {(row.added ?? 0) > 0 ? `+${row.added} added` : ""}
          {(row.added ?? 0) > 0 && (row.removed ?? 0) > 0 ? " · " : ""}
          {(row.removed ?? 0) > 0 ? `−${row.removed} removed` : ""}
        </div>
      ) : null}
    </div>
  );
}

export function BurndownChart({
  burndown,
  mode,
}: {
  burndown: PmBurndown;
  mode: ProgressMode;
}): JSX.Element {
  const unit = mode === "estimate" ? "points" : "items";
  const rows: ChartRow[] = burndown.days.map((p) => {
    const f = figures(p, mode);
    return {
      label: fmtDay(p.date),
      date: p.date,
      scope: f.scope,
      remaining: f.remaining,
      ideal: f.ideal,
      added: p.added,
      removed: p.removed,
    };
  });
  const through = burndown.through ? fmtDay(burndown.through) : null;
  const summary = burndownSummary(burndown, mode);
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <figure className="pm-burndown" aria-label="Burndown">
      <p className="pm-burndown-summary">{summary}</p>

      <div className="pm-burndown-plot" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              interval="preserveStartEnd"
              tick={{ fontSize: 11, fill: "var(--text-2)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
            />
            <YAxis
              width={32}
              allowDecimals={mode === "estimate"}
              domain={[0, "auto"]}
              tick={{ fontSize: 11, fill: "var(--text-2)" }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip content={<TooltipBody unit={unit} />} />
            {burndown.status === "active" && through && (
              <ReferenceLine x={through} stroke="var(--text-2)" strokeDasharray="2 3" />
            )}
            <Line
              type="stepAfter"
              dataKey="scope"
              stroke="var(--text-2)"
              strokeWidth={1.5}
              dot={false}
              connectNulls={false}
              isAnimationActive={!reduced}
            />
            <Line
              type="linear"
              dataKey="ideal"
              stroke="var(--text-2)"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={!reduced}
            />
            <Line
              type="monotone"
              dataKey="remaining"
              stroke="var(--accent)"
              strokeWidth={2.25}
              dot={{ r: 2.5 }}
              connectNulls={false}
              isAnimationActive={!reduced}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <ul className="pm-burndown-legend">
        <li>
          <span className="swatch remaining" aria-hidden="true" /> Remaining
        </li>
        <li>
          <span className="swatch scope" aria-hidden="true" /> Scope
        </li>
        <li>
          <span className="swatch ideal" aria-hidden="true" /> Ideal
        </li>
      </ul>

      <table className="pm-sr-only">
        <caption>Daily burndown</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Scope</th>
            <th scope="col">Remaining</th>
            <th scope="col">Ideal</th>
          </tr>
        </thead>
        <tbody>
          {burndown.days.map((p) => {
            const f = figures(p, mode);
            return (
              <tr key={p.date}>
                <th scope="row">{fmtDay(p.date)}</th>
                <td>{f.scope ?? "—"}</td>
                <td>{f.remaining ?? "—"}</td>
                <td>{f.ideal}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </figure>
  );
}
