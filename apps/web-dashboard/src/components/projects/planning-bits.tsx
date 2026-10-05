"use client";

// Shared primitives for the planning surfaces — cycles (sprints) and modules
// (milestones), WARP-3521. The progress arithmetic lives here once so a cycle
// card, a module card and a detail header can never disagree about "how far
// along", and so it is testable without rendering anything.

import type { JSX } from "react";
import { PmIcon } from "./icons";
import type { CycleStatus, ModuleStatus, PmCycle, PmPlanningProgress } from "./types";

export type ProgressMode = "count" | "estimate";

export interface ProgressFigures {
  /** Finished work: items (or points) in a `completed` state. */
  done: number;
  /** What it is finished OUT OF: everything planned, cancelled work excluded —
   *  an item that was dropped is not work that failed to get done. */
  of: number;
  cancelled: number;
  /** 0-100, whole number. 0 when there is nothing to finish. */
  percent: number;
}

export function progressFigures(p: PmPlanningProgress, mode: ProgressMode = "count"): ProgressFigures {
  const total = mode === "count" ? p.total : p.totalEstimate;
  const done = mode === "count" ? p.completed : p.completedEstimate;
  const cancelled = mode === "count" ? p.cancelled : p.cancelledEstimate;
  const of = Math.max(0, total - cancelled);
  const percent = of <= 0 ? 0 : Math.min(100, Math.round((done / of) * 100));
  return { done, of, cancelled, percent };
}

/** "7 of 12 done · 1 cancelled", "18 of 30 points done", or "No items yet". */
export function progressText(p: PmPlanningProgress, mode: ProgressMode = "count"): string {
  const f = progressFigures(p, mode);
  const unit = mode === "count" ? "" : " points";
  if (mode === "count" ? p.total === 0 : p.totalEstimate === 0) {
    return mode === "count" ? "No items yet" : "No estimates yet";
  }
  const base = `${f.done} of ${f.of}${unit} done`;
  return f.cancelled > 0 ? `${base} · ${f.cancelled} cancelled` : base;
}

/** The bar. Accessible as a progressbar; the figure beside it says it in words. */
export function ProgressBar({
  progress,
  mode = "count",
  label,
  tone = "accent",
}: {
  progress: PmPlanningProgress;
  mode?: ProgressMode;
  /** What this is the progress OF, for the accessible name: "Sprint 12". */
  label: string;
  tone?: "accent" | "ok";
}): JSX.Element {
  const { percent } = progressFigures(progress, mode);
  return (
    <div
      className="pm-progress"
      role="progressbar"
      aria-label={`${label} progress`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}% — ${progressText(progress, mode)}`}
    >
      <span className={tone === "ok" ? "fill ok" : "fill"} style={{ width: `${percent}%` }} />
    </div>
  );
}

// ── Status badges ────────────────────────────────────────────────────────────
// Reuse the state-chip colour classes the work-item state pill already has, so
// a status reads in the same hues everywhere on the surface: info for planned,
// amber for running, green for done, red only for cancelled.

export const CYCLE_STATUS_LABEL: Record<CycleStatus, string> = {
  draft: "Upcoming",
  active: "Active",
  completed: "Completed",
};

const CYCLE_STATUS_CLASS: Record<CycleStatus, string> = {
  draft: "unstarted",
  active: "started",
  completed: "completed",
};

export function CycleStatusBadge({ status }: { status: CycleStatus }): JSX.Element {
  return <span className={"pm-statechip " + CYCLE_STATUS_CLASS[status]}>{CYCLE_STATUS_LABEL[status]}</span>;
}

export const MODULE_STATUS_LABEL: Record<ModuleStatus, string> = {
  backlog: "Backlog",
  planned: "Planned",
  in_progress: "In progress",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const MODULE_STATUS_ORDER: ModuleStatus[] = [
  "backlog",
  "planned",
  "in_progress",
  "paused",
  "completed",
  "cancelled",
];

const MODULE_STATUS_CLASS: Record<ModuleStatus, string> = {
  backlog: "backlog",
  planned: "unstarted",
  in_progress: "started",
  paused: "backlog",
  completed: "completed",
  cancelled: "cancelled",
};

export function ModuleStatusBadge({ status }: { status: ModuleStatus }): JSX.Element {
  return <span className={"pm-statechip " + MODULE_STATUS_CLASS[status]}>{MODULE_STATUS_LABEL[status]}</span>;
}

// ── The cycle chip on a board card / list row ────────────────────────────────

/** The cycle an item is planned into, as a small chip. Renders nothing when the
 *  item has no cycle, or when the cycle is not (yet) in the map — a chip that
 *  says "undefined" while the cycle list loads is worse than no chip. */
export function CycleTag({
  cycleId,
  cycles,
  small,
}: {
  cycleId: string | null | undefined;
  cycles: ReadonlyMap<string, Pick<PmCycle, "id" | "name">> | undefined;
  small?: boolean;
}): JSX.Element | null {
  if (!cycleId) return null;
  const cycle = cycles?.get(cycleId);
  if (!cycle) return null;
  return (
    <span className={"pm-tag" + (small ? " sm" : "")} title={`Cycle: ${cycle.name}`}>
      <PmIcon name="target" size={small ? 10 : 12} />
      <span className="pm-cycle-tag-name">{cycle.name}</span>
    </span>
  );
}
