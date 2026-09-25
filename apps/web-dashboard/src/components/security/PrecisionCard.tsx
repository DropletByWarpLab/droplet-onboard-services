"use client";

/**
 * WARP-2980 (ADR-059 P5 PR-B, brief §4.4, §12) — "How often Droplet was
 * right" on /security/patterns: per pattern flag, how many of the incidents
 * it was on were marked Not expected. The counts from the first mark; a
 * percentage once that flag has 30 days of marks. Numbers and words, never
 * colour alone.
 *
 * Only for owner/admin: route 29 sends `precision: null` to anyone else (the
 * counts span every camera — DS-005), and this renders nothing for null.
 */
import { Target } from "lucide-react";
import type { SecurityPatternPrecision } from "@/lib/types";
import { PATTERN_NAME, PRECISION_COPY as P, fillCopy, siteDate } from "./patterns-copy";
import "./patterns.css";

type Row = SecurityPatternPrecision["codes"][number];

/** "Right 3 of 4 times (75%)" once shown, else "3 marks so far". */
export function precisionLine(row: Row): string {
  if (row.percentRight !== null) return fillCopy(P.right, { right: row.notExpected, n: row.marked, percent: row.percentRight });
  return row.marked === 1 ? P.soFarOne : fillCopy(P.soFarMany, { n: row.marked });
}

export function PrecisionCard({ precision, timezone, now }: { precision: SecurityPatternPrecision | null; timezone: string; now: Date }) {
  if (precision === null) return null;
  return (
    <section className="card" aria-labelledby="patterns-precision">
      <div className="card-h">
        <span className="ci">
          <Target size={16} />
        </span>
        <h2 className="ct" id="patterns-precision" style={{ margin: 0 }}>
          {P.title}
        </h2>
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--text-muted)" }}>{P.hint}</p>
      {precision.codes.length === 0 ? (
        <p className="expected-empty">{P.none}</p>
      ) : (
        <ul className="expected-list">
          {precision.codes.map((row) => (
            <li key={row.code} className="precision-row" data-code={row.code}>
              <span className="expected-what">{PATTERN_NAME[row.code]}</span>
              <span className="expected-line">
                {precisionLine(row)} · {fillCopy(P.since, { date: siteDate(row.firstMarkedAt, timezone, now) })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
