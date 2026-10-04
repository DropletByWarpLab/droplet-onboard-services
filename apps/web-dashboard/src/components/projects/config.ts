// Static config + small pure helpers for the Projects surface.

import type { Priority, StateGroup, PmWorkItem, Person } from "./types";
import { dateOnly, formatDayMonth, isBeforeToday } from "./date-only";

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

export function makePerson(id: string, displayName?: string, avatarUrl?: string | null): Person {
  const name = displayName && displayName.trim().length > 0 ? displayName : "Unknown";
  return { id, name, initials: initialsOf(name), tone: toneOf(id), ...(avatarUrl ? { avatarUrl } : {}) };
}

// ── Dates ───────────────────────────────────────────────────────────────────
// WARP-3372 — a due / start date is a calendar date; every read of one goes
// through ./date-only, which never builds a `Date` from it. These three keep
// their names so the cards, list rows and detail rail did not change shape.

/** `2026-06-25` → "Jun 25". Null-safe. */
export function fmtDate(value: string | null | undefined): string | null {
  return formatDayMonth(value);
}

/** `2026-06-25` → "2026-06-25" (the mono date in the detail rail), "—" when unset. */
export function fmtISODate(value: string | null | undefined): string {
  return dateOnly(value) ?? "—";
}

/** Open and due before the VIEWER's today (their local calendar day). */
export function isOverdue(item: Pick<PmWorkItem, "dueDate" | "state">, now: Date = new Date()): boolean {
  if (!item.dueDate) return false;
  const g = item.state?.group;
  if (g === "completed" || g === "cancelled") return false;
  return isBeforeToday(item.dueDate, now);
}
