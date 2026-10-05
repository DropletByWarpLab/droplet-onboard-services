// Wire types for GET /api/pm/insights — mirror ApiPmInsights in the
// orchestrator (apps/orchestrator/src/services/pm/pm-insights.service.ts).
// Dates are `YYYY-MM-DD` in the workspace's own calendar; durations are days.

export type InsightsGroupBy = "day" | "week" | "month";

/** The five state groups, plus `unknown`: a state that has since been deleted. */
export type InsightsBand = "backlog" | "unstarted" | "started" | "completed" | "cancelled" | "unknown";

export interface InsightsDuration {
  /** Items measured. */
  count: number;
  /** Null when nothing was measured. */
  p50: number | null;
  p85: number | null;
  p95: number | null;
  /** `counts[i]` items took under `edgesDays[i]` days; the last entry took at least the last edge. */
  edgesDays: number[];
  counts: number[];
}

export type InsightsCfdDay = { date: string } & Record<InsightsBand, number>;

export interface PmInsights {
  meta: {
    scope: "project" | "workspace";
    projectId: string | null;
    from: string;
    to: string;
    groupBy: InsightsGroupBy;
    timezone: string;
    generatedAt: string;
    /** Live items in scope, in any state. Zero: nothing to chart yet. */
    itemCount: number;
  };
  throughput: {
    total: number;
    buckets: Array<{ start: string; completed: number }>;
  };
  createdVsCompleted: {
    created: number;
    completed: number;
    buckets: Array<{ start: string; created: number; completed: number }>;
  };
  cycleTime: InsightsDuration;
  leadTime: InsightsDuration;
  cumulativeFlow: {
    groups: InsightsBand[];
    days: InsightsCfdDay[];
  };
  workload: {
    /** False until the orchestrator has an estimate column; every `openEstimate` is then 0. */
    estimateAvailable: boolean;
    /** Largest first. `userId` null is the unassigned row. */
    assignees: Array<{ userId: string | null; openItems: number; openEstimate: number }>;
  };
  agingWip: {
    total: number;
    items: Array<{
      id: string;
      key: string;
      name: string;
      stateName: string;
      since: string;
      ageDays: number;
    }>;
  };
}
