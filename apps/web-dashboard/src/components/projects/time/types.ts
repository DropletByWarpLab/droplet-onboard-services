// Wire types for time tracking (WARP-3526) — mirror the orchestrator's
// /api/pm time routes (apps/orchestrator/src/routes/pm/time.ts and
// services/pm/pm-time.service.ts). Kept beside the time components so the
// shared Projects types stay untouched.

/** Enough of a work item to label time against it. */
export interface PmTimeItemRef {
  id: string;
  /** The human key, e.g. INBOX-42. */
  key: string;
  name: string;
  projectId: string;
  /** The item, or its project, is archived. */
  archived: boolean;
}

export interface PmWorklog {
  id: string;
  workItemId: string;
  /** The person who spent the time. */
  userId: string;
  startedAt: string;
  minutes: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface PmTimer {
  userId: string;
  workItemId: string;
  startedAt: string;
  workItem: PmTimeItemRef;
}

export interface PmWorklogList {
  worklogs: PmWorklog[];
  /** Over every entry on the item, not only the ones listed. */
  total_minutes: number;
  total_entries: number;
}

export interface PmTimesheetEntry extends PmWorklog {
  workItem: PmTimeItemRef;
}

export interface PmTimesheet {
  userId: string;
  tz: string;
  /** The Monday that opens the week, YYYY-MM-DD in `tz`. */
  weekStart: string;
  /** Seven local dates, Monday to Sunday. */
  days: string[];
  rows: Array<{
    workItem: PmTimeItemRef;
    /** Minutes per day, aligned with `days`. */
    minutes: number[];
    totalMinutes: number;
  }>;
  dayTotals: number[];
  totalMinutes: number;
  entries: PmTimesheetEntry[];
}

export type ReportGroupBy = "user" | "item" | "day";

export interface PmTimeReportRow {
  key: string;
  label: string;
  /** The human key of a work item (group by item), else null. */
  itemKey: string | null;
  minutes: number;
  entries: number;
}

export interface PmTimeReport {
  groupBy: ReportGroupBy;
  from: string;
  to: string;
  tz: string;
  projectId: string | null;
  rows: PmTimeReportRow[];
  total: { minutes: number; entries: number };
}

export interface ReportQuery {
  projectId: string | null;
  from: string;
  to: string;
  groupBy: ReportGroupBy;
  tz: string;
}
