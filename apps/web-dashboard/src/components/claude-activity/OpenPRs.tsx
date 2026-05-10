/**
 * WARP-279 — Open PRs widget.
 *
 * Lists every open PR with its CI badge. Empty state when there are no
 * open PRs (the most common state).
 */

"use client";

import { GitPullRequest } from "./icons";
import { relativeTime } from "./time";
import type { CIBadge, GitHubPR } from "./types";

const BADGE_COPY: Record<CIBadge, { label: string; cls: string }> = {
  success: { label: "passing", cls: "bg-system-green/15 text-system-green" },
  failure: { label: "failing", cls: "bg-system-red/15 text-system-red" },
  pending: { label: "pending", cls: "bg-system-orange/15 text-system-orange" },
  neutral: { label: "neutral", cls: "bg-label-quaternary/15 text-label-tertiary" },
  unknown: { label: "no checks", cls: "bg-label-quaternary/15 text-label-tertiary" },
};

export function OpenPRs({ prs }: { prs: GitHubPR[] | null }) {
  return (
    <section className="dp-card p-5" aria-labelledby="open-prs-heading">
      <div className="flex items-center justify-between mb-3">
        <h2
          id="open-prs-heading"
          className="type-footnote text-label-secondary uppercase tracking-wide flex items-center gap-2"
        >
          <GitPullRequest size={14} aria-hidden="true" />
          Open PRs
        </h2>
        <span className="type-caption-2 text-label-quaternary">
          {prs ? `${prs.length} open` : "—"}
        </span>
      </div>
      {prs === null ? (
        <p className="type-subheadline text-label-tertiary">
          GitHub unavailable. Check the orchestrator logs and{" "}
          <code>GITHUB_TOKEN</code>.
        </p>
      ) : prs.length === 0 ? (
        <p className="type-subheadline text-label-tertiary">
          No open PRs. Nice.
        </p>
      ) : (
        <ul className="space-y-2">
          {prs.map((pr) => {
            const badge = BADGE_COPY[pr.ci_state];
            return (
              <li key={pr.number}>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex items-center gap-3 hover:bg-surface-secondary -mx-2 px-2 py-1.5 rounded-md transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="type-subheadline text-label-primary truncate">
                      <span className="text-label-tertiary">#{pr.number}</span>{" "}
                      {pr.title}
                      {pr.draft && (
                        <span className="ml-2 type-caption-2 text-label-tertiary">
                          (draft)
                        </span>
                      )}
                    </p>
                    <p className="type-caption-1 text-label-tertiary truncate">
                      <code className="font-mono">{pr.branch}</code>
                      {pr.user && <> · {pr.user}</>} · {relativeTime(pr.updated_at)}
                    </p>
                  </div>
                  <span
                    className={`type-caption-2 px-2 py-0.5 rounded ${badge.cls} whitespace-nowrap`}
                  >
                    {badge.label}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
