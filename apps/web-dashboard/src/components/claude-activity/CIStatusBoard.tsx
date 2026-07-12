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
  neutral: "bg-[var(--inset)] border-[var(--card-bd)]",
};
const TONE_FG: Record<"ok" | "error" | "warning" | "neutral", string> = {
  ok: "text-system-green",
  error: "text-system-red",
  warning: "text-system-orange",
  neutral: "text-[var(--text-muted)]",
};

export function CIStatusBoard({ runs }: { runs: GitHubCIRun[] | null }) {
  return (
    <section className="card" style={{ padding: "20px" }} aria-labelledby="ci-status-heading">
      <h2
        id="ci-status-heading"
        className="type-footnote uppercase tracking-wide mb-3"
        style={{ color: "var(--text-muted)" }}
      >
        CI status
      </h2>
      {runs === null ? (
        <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
          GitHub unavailable.
        </p>
      ) : runs.length === 0 ? (
        <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
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
                  <span className="type-subheadline truncate" style={{ color: "var(--text)" }}>
                    {run.workflow_name}
                  </span>
                  <Icon
                    size={14}
                    className={TONE_FG[tone]}
                    aria-hidden="true"
                  />
                </div>
                <div className="flex items-center justify-between type-caption-2" style={{ color: "var(--text-muted)" }}>
                  <span className={`${TONE_FG[tone]}`}>{label}</span>
                  {/*
                    WARP-300 audit: the opacity-0 group-hover:opacity-100
                    here is preserved intentionally. This ExternalLink
                    icon is a decorative hover cue layered inside the
                    parent <a> — the entire card is already a single
                    actionable target with its accessible name supplied
                    by `run.workflow_name`, and the icon carries
                    `aria-hidden="true"` so it's not announced. Touch +
                    keyboard users reach the action by activating the
                    card itself (tab to focus, enter to open), not by
                    targeting this glyph, so the hover-only reveal is a
                    progressive-enhancement affordance rather than the
                    sole discovery channel for a destructive action.
                  */}
                  <span className="flex items-center gap-1" style={{ color: "var(--text-faint)" }}>
                    {relativeTime(run.updated_at)}
                    <ExternalLink
                      size={10}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
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
