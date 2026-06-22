// Static config + small pure helpers for the Projects surface.

import type { Priority, StateGroup, PmWorkItem, Person } from "./types";

export interface PriorityMeta {
  label: string;
  color: string; // CSS var
  icon: string; // PmIcon name
  rank: number;
}

export const PRIORITY: Record<Priority, PriorityMeta> = {
  urgent: { label: "Urgent", color: "var(--err)", icon: "alert", rank: 0 },
  high: { label: "High", color: "var(--warn)", icon: "signal", rank: 1 },
  medium: { label: "Medium", color: "var(--accent)", icon: "signal", rank: 2 },
  low: { label: "Low", color: "var(--text-4)", icon: "signal", rank: 3 },
  none: { label: "None", color: "var(--text-4)", icon: "minus", rank: 4 },
};

export const PRIORITY_ORDER: Priority[] = ["urgent", "high", "medium", "low", "none"];

/** Left-edge accent on a card: only urgent/high get a colored rail. */
export function cardAccent(p: Priority): string {
  if (p === "urgent") return "var(--err)";
  if (p === "high") return "var(--warn)";
  return "transparent";
}

/** Sparkline bar colors, ordered to match the group sequence. */
export const GROUP_ORDER: StateGroup[] = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
];
export const GROUP_BAR_COLOR: Record<StateGroup, string> = {
  backlog: "#94a3b8",
  unstarted: "#6366f1",
  started: "#f59e0b",
  completed: "#22c55e",
  cancelled: "#ef4444",
};

// ── People resolution (id → name / initials / avatar tone) ──────────────────

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Stable 1..6 tone from a user id, so avatar colors are consistent. */
export function toneOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 6) + 1;
}

export function makePerson(id: string, displayName?: string): Person {
  const name = displayName && displayName.trim().length > 0 ? displayName : "Unknown";
  return { id, name, initials: initialsOf(name), tone: toneOf(id) };
}

// ── Dates ───────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ISO datetime/date → "Jun 25". Null-safe. */
export function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** ISO → YYYY-MM-DD (for the mono date display in the detail rail). */
export function fmtISODate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

export function isOverdue(item: Pick<PmWorkItem, "dueDate" | "state">): boolean {
  if (!item.dueDate) return false;
  const g = item.state?.group;
  if (g === "completed" || g === "cancelled") return false;
  return new Date(item.dueDate).getTime() < Date.now();
}
