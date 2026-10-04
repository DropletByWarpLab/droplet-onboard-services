// Wire types for GET /api/pm/projects/:id/timeline (WARP-3523). Items are the
// board's own work-item shape; everything this endpoint adds is below. Dates it
// adds itself (`from`, `to`, `targetDate`) are always `YYYY-MM-DD`.

import type { PmWorkItem } from "../types";

export interface PmTimelineRelation {
  id: string;
  kind: "BLOCKS";
  /** `fromId` blocks `toId`. */
  fromId: string;
  toId: string;
}

export type PmModuleStatus = "backlog" | "planned" | "in_progress" | "paused" | "completed" | "cancelled";

export interface PmTimelineMilestone {
  id: string;
  name: string;
  status: PmModuleStatus;
  targetDate: string;
}

export interface PmTimeline {
  from: string;
  to: string;
  items: PmWorkItem[];
  relations: PmTimelineRelation[];
  milestones: PmTimelineMilestone[];
  /** Live items with no date at all: not drawable, but not silently hidden. */
  unscheduledCount: number;
  /** A server cap was hit: what is drawn is a prefix of the truth. */
  truncated: boolean;
}
