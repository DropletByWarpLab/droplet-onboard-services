/**
 * WARP-279 — Decisions log widget.
 *
 * Renders the last 10 decisions from .claude/session-state.json. Each
 * decision is a one-line summary with a longer rationale; the rationale
 * is shown inline (not collapsed) so the panel reads as a narrative.
 */

"use client";

import { StickyNote } from "./icons";
import { relativeTime } from "./time";
import type { DecisionEntry } from "./types";

export function DecisionsLog({
  decisions,
}: {
  decisions: DecisionEntry[];
}) {
  // The reader caps at 20; we surface the most recent 10 here per the
  // ticket spec. Reversed because session-state stores newest at the end
  // (FIFO append), but newest-first reads better in the UI.
  const recent = [...decisions]
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, 10);

  return (
    <section className="dp-card p-5" aria-labelledby="decisions-heading">
      <h2
        id="decisions-heading"
        className="type-footnote text-label-secondary uppercase tracking-wide flex items-center gap-2 mb-3"
      >
        <StickyNote size={14} aria-hidden="true" />
        Decisions log
      </h2>
      {recent.length === 0 ? (
        <p className="type-subheadline text-label-tertiary">
          No decisions yet. Claude appends an entry to{" "}
          <code>session-state.json</code>'s <code>decisions</code> array
          whenever it picks a path with non-trivial trade-offs.
        </p>
      ) : (
        <ol className="space-y-3">
          {recent.map((d, i) => (
            <li key={`${d.ts}-${i}`} className="border-l-2 border-accent/40 pl-3">
              <p className="type-subheadline text-label-primary">{d.summary}</p>
              <p className="type-caption-1 text-label-tertiary mt-0.5">
                {d.rationale}
              </p>
              <p className="type-caption-2 text-label-quaternary mt-0.5">
                {relativeTime(d.ts)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
