/**
 * WARP-279 — Workstream rollup table.
 *
 * Renders the workstream-rollup table from docs/compliance-progress.md.
 * One row per workstream, with done / in-progress / not-started counts
 * and a small progress bar.
 */

"use client";

import { Code } from "./icons";
import type { WorkstreamRow } from "./types";

export function WorkstreamRollup({ rows }: { rows: WorkstreamRow[] | undefined }) {
  return (
    <section className="card" style={{ padding: "20px" }} aria-labelledby="workstream-heading">
      <h2
        id="workstream-heading"
        className="type-footnote uppercase tracking-wide flex items-center gap-2 mb-3"
        style={{ color: "var(--text-muted)" }}
      >
        <Code size={14} aria-hidden="true" />
        Compliance workstreams
      </h2>
      {!rows || rows.length === 0 ? (
        <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
          docs/compliance-progress.md isn't parsing. Either the file is missing,
          its workstream-rollup table moved, or its format drifted.
        </p>
      ) : (
        <table className="w-full type-caption-1">
          <thead>
            <tr style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--card-bd)" }}>
              <th className="text-left py-2 font-normal">Workstream</th>
              <th className="text-right py-2 font-normal">Total</th>
              <th className="text-right py-2 font-normal">Done</th>
              <th className="text-right py-2 font-normal">In progress</th>
              <th className="text-right py-2 font-normal">Not started</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = r.total === 0 ? 0 : Math.round((r.done / r.total) * 100);
              return (
                <tr key={r.workstream} style={{ borderBottom: "1px solid color-mix(in srgb, var(--card-bd) 50%, transparent)" }}>
                  <td className="py-2" style={{ color: "var(--text)" }}>
                    <div className="flex items-center gap-2">
                      <span>{r.workstream}</span>
                      <div className="flex-1 h-1 rounded-sm max-w-[80px]" style={{ background: "var(--inset)" }}>
                        <div
                          className="h-1 bg-system-green rounded-sm"
                          style={{ width: `${pct}%` }}
                          aria-hidden="true"
                        />
                      </div>
                      <span className="type-caption-2 w-9 text-right" style={{ color: "var(--text-faint)" }}>
                        {pct}%
                      </span>
                    </div>
                  </td>
                  <td className="text-right py-2" style={{ color: "var(--text-muted)" }}>{r.total}</td>
                  <td className="text-right text-system-green py-2">{r.done}</td>
                  <td className="text-right text-system-orange py-2">{r.in_progress}</td>
                  <td className="text-right py-2" style={{ color: "var(--text-muted)" }}>{r.not_started}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
