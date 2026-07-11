/**
 * WARP-279 — "Claude now" panel.
 *
 * The current task panel sits at the top of the dashboard. Surfaces the
 * `now` field from .claude/session-state.json: what is Claude doing right
 * now, against which ticket, on which branch, since when, and is it
 * blocked. When session-state has no `now` set we render a soft "idle"
 * placeholder rather than an empty panel.
 */

"use client";

import { Activity, Branch, Clock, ShieldAlert, Ticket } from "./icons";
import type { NowState } from "./types";
import { relativeTime } from "./time";

export function ClaudeNow({ now }: { now: NowState }) {
  const idle = !now.task || now.task.length === 0;

  return (
    <section
      className="card p-5"
      aria-labelledby="claude-now-heading"
    >
      <div className="flex items-center justify-between mb-3">
        <h2
          id="claude-now-heading"
          className="type-footnote uppercase tracking-wide flex items-center gap-2"
          style={{ color: "var(--text-muted)" }}
        >
          <Activity size={14} aria-hidden="true" />
          Claude now
        </h2>
        {now.blocked_on ? (
          <span className="type-caption-1 px-2 py-0.5 rounded-full bg-system-orange/15 text-system-orange flex items-center gap-1">
            <ShieldAlert size={11} aria-hidden="true" /> blocked
          </span>
        ) : !idle ? (
          <span className="type-caption-1 px-2 py-0.5 rounded-full bg-system-green/15 text-system-green">
            working
          </span>
        ) : (
          <span className="type-caption-1 px-2 py-0.5 rounded-full bg-[var(--inset)] text-[var(--text-muted)]">
            idle
          </span>
        )}
      </div>

      {idle ? (
        <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
          No active task. Drop a <code>.claude/session-state.json</code> in the
          repo root to populate this panel.
        </p>
      ) : (
        <>
          <p className="type-title-3 mb-2" style={{ color: "var(--text)" }}>{now.task}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 type-caption-1" style={{ color: "var(--text-muted)" }}>
            {now.ticket && (
              <span className="flex items-center gap-1">
                <Ticket size={11} aria-hidden="true" />
                {now.ticket}
              </span>
            )}
            {now.branch && (
              <span className="flex items-center gap-1">
                <Branch size={11} aria-hidden="true" />
                <code className="font-mono">{now.branch}</code>
              </span>
            )}
            {now.started_at && (
              <span className="flex items-center gap-1">
                <Clock size={11} aria-hidden="true" />
                started {relativeTime(now.started_at)}
              </span>
            )}
          </div>
          {now.blocked_on && (
            <p className="type-caption-1 text-system-orange mt-2">
              Blocked on: {now.blocked_on}
            </p>
          )}
        </>
      )}
    </section>
  );
}
