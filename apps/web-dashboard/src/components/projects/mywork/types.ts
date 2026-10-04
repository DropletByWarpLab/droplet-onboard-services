// Wire types for GET /api/pm/my-work (WARP-3523). Work items are the board's own
// shape; everything this endpoint adds is below.

import type { PmWorkItem } from "../types";

/** Mentioned and Watching depend on WS-2 (comments, watchers) and are not part of this slice. */
export type PmMyWorkSection = "assigned" | "created" | "overdue" | "due_this_week";

export interface PmMyWorkProject {
  id: string;
  name: string;
  identifier: string;
  icon: string | null;
  color: string | null;
}

export interface PmMyWorkCounts {
  assigned: number;
  created: number;
  overdue: number;
  dueThisWeek: number;
}

export interface PmMyWorkPage {
  section: PmMyWorkSection;
  today: string;
  items: PmWorkItem[];
  /** The projects `items` belong to, in the order their groups appear. */
  projects: PmMyWorkProject[];
  /** Exact size of the requested section — not of this page. */
  total: number;
  counts: PmMyWorkCounts;
  limit: number;
  offset: number;
  /** Offset of the next page, or null at the end. */
  nextOffset: number | null;
}
