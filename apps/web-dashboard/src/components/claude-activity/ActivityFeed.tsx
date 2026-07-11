/**
 * WARP-279 — Recent activity feed.
 *
 * Interleaves commits + open-PR updates + CI runs + Jira in-flight
 * tickets + the AI engineer's recent_actions, sorted newest-first,
 * capped at 25 items. Each row is a link out to the underlying source.
 */

"use client";

import {
  ArrowUpRight,
  GitCommit,
  GitPullRequest,
  PlayCircle,
  ScrollText,
  StickyNote,
  Ticket,
} from "./icons";
import type {
  ClaudeActivityResponse,
  FeedItem,
} from "./types";
import { relativeTime } from "./time";

function buildFeed(data: ClaudeActivityResponse): FeedItem[] {
  const items: FeedItem[] = [];

  // Session-state recent_actions — most-trusted signal of "what Claude
  // just did", since they don't depend on GitHub/Jira being reachable.
  for (const a of data.recent_actions) {
    items.push({
      ts: a.ts,
      kind: "action",
      title: a.summary,
      subtitle: a.kind + (a.ref ? ` · ${a.ref}` : ""),
    });
  }

  // GitHub commits.
  for (const c of data.github?.commits ?? []) {
    items.push({
      ts: c.ts,
      kind: "commit",
      title: c.message,
      subtitle: `${c.short_sha}${c.author ? ` · ${c.author}` : ""}`,
      url: c.url,
    });
  }

  // Open PRs (the dashboard surfaces them under "Open PRs" too — feed
  // entry highlights the most recent activity).
  for (const p of data.github?.prs ?? []) {
    items.push({
      ts: p.updated_at,
      kind: "pr",
      title: `#${p.number} ${p.title}`,
      subtitle: `${p.branch}${p.user ? ` · ${p.user}` : ""}${p.draft ? " · draft" : ""}`,
      url: p.url,
      badge: p.ci_state,
      badge_tone:
        p.ci_state === "success"
          ? "ok"
          : p.ci_state === "failure"
          ? "error"
          : p.ci_state === "pending"
          ? "warning"
          : "neutral",
    });
  }

  // CI runs.
  for (const r of data.github?.ci_runs ?? []) {
    const tone =
      r.conclusion === "success"
        ? "ok"
        : r.conclusion === "failure" || r.conclusion === "timed_out"
        ? "error"
        : r.status !== "completed"
        ? "warning"
        : "neutral";
    items.push({
      ts: r.updated_at,
      kind: "ci",
      title: `${r.workflow_name}`,
      subtitle: `${r.branch ?? "?"} · ${r.conclusion ?? r.status}`,
      url: r.url,
      badge: r.conclusion ?? r.status,
      badge_tone: tone,
    });
  }

  // Jira in-flight tickets.
  for (const t of data.jira?.in_flight ?? []) {
    if (!t.updated) continue;
    items.push({
      ts: t.updated,
      kind: "ticket",
      title: `${t.key} ${t.summary}`,
      subtitle: `${t.status_name}${t.assignee ? ` · ${t.assignee}` : ""}`,
      url: t.url,
    });
  }

  // Decisions live in their own panel; we mirror them into the feed too
  // so the "interleaved" spec is honored.
  for (const d of data.decisions) {
    items.push({
      ts: d.ts,
      kind: "decision",
      title: d.summary,
      subtitle: d.rationale,
    });
  }

  items.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return items.slice(0, 25);
}

const ICONS = {
  commit: GitCommit,
  pr: GitPullRequest,
  ci: PlayCircle,
  ticket: Ticket,
  decision: StickyNote,
  action: ScrollText,
} as const;

export function ActivityFeed({ data }: { data: ClaudeActivityResponse }) {
  const items = buildFeed(data);
  return (
    <section className="card p-5" aria-labelledby="activity-feed-heading">
      <h2
        id="activity-feed-heading"
        className="type-footnote uppercase tracking-wide mb-4"
        style={{ color: "var(--text-muted)" }}
      >
        Recent activity
      </h2>
      {items.length === 0 ? (
        <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
          No activity yet. New commits, PR updates, CI runs, ticket transitions,
          and Claude's recorded actions all appear here.
        </p>
      ) : (
        <ol className="space-y-3">
          {items.map((item, i) => {
            const Icon = ICONS[item.kind];
            const row = (
              <>
                <Icon
                  size={14}
                  className="mt-0.5 flex-shrink-0"
                  style={{ color: "var(--text-muted)" }}
                  aria-hidden="true"
                />
                <div className="flex-1 min-w-0">
                  <p className="type-subheadline truncate" style={{ color: "var(--text)" }}>
                    {item.title}
                  </p>
                  {item.subtitle && (
                    <p className="type-caption-1 truncate" style={{ color: "var(--text-muted)" }}>
                      {item.subtitle}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <span className="type-caption-2 whitespace-nowrap" style={{ color: "var(--text-faint)" }}>
                    {relativeTime(item.ts)}
                  </span>
                  {item.badge && (
                    <span
                      className={`type-caption-2 px-1.5 py-0.5 rounded ${badgeClasses(
                        item.badge_tone,
                      )}`}
                    >
                      {item.badge}
                    </span>
                  )}
                </div>
                {item.url && (
                  <ArrowUpRight
                    size={12}
                    className="flex-shrink-0 text-[var(--text-faint)] group-hover:text-[var(--brand)]"
                    aria-hidden="true"
                  />
                )}
              </>
            );
            return (
              <li key={`${item.kind}-${item.ts}-${i}`}>
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex items-start gap-3"
                  >
                    {row}
                  </a>
                ) : (
                  <div className="flex items-start gap-3">{row}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function badgeClasses(tone: FeedItem["badge_tone"]): string {
  switch (tone) {
    case "ok":
      return "bg-system-green/15 text-system-green";
    case "warning":
      return "bg-system-orange/15 text-system-orange";
    case "error":
      return "bg-system-red/15 text-system-red";
    case "info":
      return "bg-[var(--brand-subtle)] text-[var(--brand)]";
    default:
      return "bg-[var(--inset)] text-[var(--text-muted)]";
  }
}
