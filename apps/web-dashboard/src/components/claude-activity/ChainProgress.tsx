/**
 * WARP-279 — WARP-228 chain progress bar.
 *
 * Renders a 50-cell strip — one per WARP-229..WARP-278 ticket — colored by
 * status, plus a numeric breakdown and percent. When Jira is unconfigured
 * we still render the strip from the local compliance-progress.md so the
 * widget is useful before Atlassian credentials are wired in.
 */

"use client";

import { ListChecks } from "./icons";
import type { JiraSnapshot, JiraTicket, QueueRow } from "./types";

interface ChainProgressProps {
  jira: JiraSnapshot | null;
  fallbackQueue?: QueueRow[]; // from compliance-progress.md
}

interface Cell {
  key: string;
  status: string;
  href?: string;
  title: string;
}

function jiraToCells(chain: JiraTicket[]): Cell[] {
  return chain.map((t) => ({
    key: t.key,
    status: t.status === "todo" ? "not_started" : t.status,
    href: t.url,
    title: `${t.key} ${t.summary} — ${t.status_name}`,
  }));
}

function queueToCells(queue: QueueRow[]): Cell[] {
  return queue.map((r) => ({
    key: r.ticket,
    status: r.status,
    title: `${r.ticket} ${r.title} — ${r.status}`,
  }));
}

const CELL_COLOR: Record<string, string> = {
  done: "bg-system-green",
  in_progress: "bg-system-orange",
  blocked: "bg-system-red",
  not_started: "bg-[var(--inset-strong)]",
  deferred: "bg-[var(--inset-strong)]",
  na: "bg-[var(--inset)]",
  unknown: "bg-[var(--inset)]",
};

export function ChainProgress({ jira, fallbackQueue }: ChainProgressProps) {
  const useJira = !!jira && jira.configured && jira.chain.length > 0;
  const cells = useJira
    ? jiraToCells(jira!.chain)
    : queueToCells(fallbackQueue ?? []);

  const total = cells.length;
  const counts = cells.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});
  const done = counts.done ?? 0;
  const inProgress = counts.in_progress ?? 0;
  const blocked = counts.blocked ?? 0;
  const notStarted = total - done - inProgress - blocked;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <section className="card p-5" aria-labelledby="chain-progress-heading">
      <div className="flex items-center justify-between mb-3">
        <h2
          id="chain-progress-heading"
          className="type-footnote uppercase tracking-wide flex items-center gap-2"
          style={{ color: "var(--text-muted)" }}
        >
          <ListChecks size={14} aria-hidden="true" />
          WARP-228 chain
        </h2>
        <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          {useJira ? "Jira" : "compliance-progress.md"}
        </span>
      </div>

      {total === 0 ? (
        <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
          No chain data. Configure Jira or land docs/compliance-progress.md.
        </p>
      ) : (
        <>
          <div className="flex items-end justify-between mb-2">
            <p className="type-title-2" style={{ color: "var(--text)" }}>
              {done} / {total}
            </p>
            <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>{percent}% done</p>
          </div>

          {/* 50-cell strip — one per ticket. Hover gives ticket + status. */}
          <div
            className="grid gap-0.5 mb-3"
            style={{
              gridTemplateColumns: `repeat(${Math.min(total, 25)}, minmax(0, 1fr))`,
            }}
            role="list"
            aria-label={`Chain progress, ${total} tickets`}
          >
            {cells.map((c) => {
              const cls = CELL_COLOR[c.status] ?? CELL_COLOR.unknown;
              return (
                <a
                  key={c.key}
                  href={c.href}
                  target="_blank"
                  rel="noreferrer"
                  title={c.title}
                  role="listitem"
                  className={`h-3 rounded-sm ${cls} ${
                    c.href
                      ? "hover:scale-110 transition-transform"
                      : "pointer-events-none"
                  }`}
                />
              );
            })}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 type-caption-2" style={{ color: "var(--text-muted)" }}>
            <Legend tone="bg-system-green" label={`done ${done}`} />
            <Legend tone="bg-system-orange" label={`in progress ${inProgress}`} />
            <Legend tone="bg-system-red" label={`blocked ${blocked}`} />
            <Legend
              tone="bg-[var(--inset-strong)]"
              label={`not started ${notStarted}`}
            />
          </div>
        </>
      )}
    </section>
  );
}

function Legend({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-sm ${tone}`} aria-hidden="true" />
      {label}
    </span>
  );
}
