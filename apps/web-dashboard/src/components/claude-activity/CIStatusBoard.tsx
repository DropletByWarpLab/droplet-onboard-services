/**
 * WARP-279 — CI status board.
 *
 * Grid of every GitHub Actions workflow's latest run + state. Replaces
 * the old "is the build green?" Slack ritual with an at-a-glance view.
 */

"use client";

import { CheckCircle2, ExternalLink, Loader2, MinusCircle, XCircle } from "./icons";
import type { GitHubCIRun } from "./types";
import { relativeTime } from "./time";

function statusOf(run: GitHubCIRun): {
  tone: "ok" | "error" | "warning" | "neutral";
  Icon: typeof CheckCircle2;
  label: string;
} {
  if (run.status !== "completed") {
    return { tone: "warning", Icon: Loader2, label: run.status };
  }
  if (run.conclusion === "success") {
    return { tone: "ok", Icon: CheckCircle2, label: "passing" };
  }
  if (run.conclusion === "failure" || run.conclusion === "timed_out") {
    return { tone: "error", Icon: XCircle, label: run.conclusion };
  }
  return { tone: "neutral", Icon: MinusCircle, label: run.conclusion ?? "neutral" };
}

const TONE_BG: Record<"ok" | "error" | "warning" | "neutral", string> = {
  ok: "bg-system-green/10 border-system-green/30",
  error: "bg-system-red/10 border-system-red/30",
  warning: "bg-system-orange/10 border-system-orange/30",
  neutral: "bg-label-quaternary/10 border-separator",
};
const TONE_FG: Record<"ok" | "error" | "warning" | "neutral", string> = {
  ok: "text-system-green",
  error: "text-system-red",
  warning: "text-system-orange",
  neutral: "text-label-tertiary",
};

export function CIStatusBoard({ runs }: { runs: GitHubCIRun[] | null }) {
  return (
    <section className="dp-card p-5" aria-labelledby="ci-status-heading">
      <h2
        id="ci-status-heading"
        className="type-footnote text-label-secondary uppercase tracking-wide mb-3"
      >
        CI status
      </h2>
      {runs === null ? (
        <p className="type-subheadline text-label-tertiary">
          GitHub unavailable.
        </p>
      ) : runs.length === 0 ? (
        <p className="type-subheadline text-label-tertiary">
          No workflow runs yet.
        </p>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
          {runs.map((run) => {
            const { tone, Icon, label } = statusOf(run);
            return (
              <a
                key={run.id}
                href={run.url}
                target="_blank"
                rel="noreferrer"
                className={`group flex flex-col gap-1 p-2.5 rounded-md border ${TONE_BG[tone]} hover:shadow-sm transition`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="type-subheadline text-label-primary truncate">
                    {run.workflow_name}
                  </span>
                  <Icon
                    size={14}
                    className={TONE_FG[tone]}
                    aria-hidden="true"
                  />
                </div>
                <div className="flex items-center justify-between type-caption-2 text-label-tertiary">
                  <span className={`${TONE_FG[tone]}`}>{label}</span>
                  <span className="text-label-quaternary flex items-center gap-1">
                    {relativeTime(run.updated_at)}
                    <ExternalLink
                      size={10}
                      className="opacity-0 group-hover:opacity-100"
                      aria-hidden="true"
                    />
                  </span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
