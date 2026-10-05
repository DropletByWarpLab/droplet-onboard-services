// Static copy + small pure helpers for the Support (service desk) surface.
// Copy follows docs/projects-surface-design-brief.md §6: sentence case, no
// exclamation marks, plain words (a "ticket", a "customer" — never a
// "requester" or a "work item"), never blame the user.

import { escapeHtml } from "@/lib/escape-html";
import type { PmState } from "@/components/projects/types";
import type {
  DeskState,
  SlaStatus,
  SupportQueue,
  TicketChannel,
  TicketPriority,
} from "./types";
import { SUPPORT_QUEUES } from "./types";

export const QUEUE_LABELS: Record<SupportQueue, string> = {
  unassigned: "Unassigned",
  mine: "Mine",
  open: "Open",
  pending: "Pending",
  solved_recent: "Solved recently",
  all: "All tickets",
};

/** What each queue says when it is empty. The heading is the fact; the body is
 *  the next step. `all` is the one that teaches the model to a new box. */
export const EMPTY_COPY: Record<SupportQueue, { heading: string; body: string }> = {
  all: { heading: "No tickets yet.", body: "Customers email you; tickets appear here." },
  open: { heading: "Nothing open.", body: "New requests land here." },
  unassigned: { heading: "Everything has an owner.", body: "Tickets nobody has picked up appear here." },
  mine: { heading: "Nothing is assigned to you.", body: "Tickets you take on appear here." },
  pending: { heading: "Nothing is waiting.", body: "Tickets waiting on a customer or someone else appear here." },
  solved_recent: { heading: "Nothing solved this week.", body: "Tickets you solve appear here for a week." },
};

export const CHANNEL_LABELS: Record<TicketChannel, string> = {
  EMAIL: "Email",
  INTERNAL: "Added by the team",
  WEB_FORM: "Web form",
  CHAT: "Assistant",
  API: "API",
  PHONE: "Phone call",
};

export const SLA_LABELS: Record<Exclude<SlaStatus, "NONE">, { label: string; tone: "ok" | "warn" | "err" | "muted" }> = {
  ON_TRACK: { label: "On track", tone: "ok" },
  MET: { label: "Met", tone: "ok" },
  AT_RISK: { label: "At risk", tone: "warn" },
  BREACHED: { label: "Breached", tone: "err" },
  PAUSED: { label: "Paused", tone: "muted" },
};

export const PRIORITY_CHOICES: Array<{ value: TicketPriority; label: string }> = [
  { value: "none", label: "No priority" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

export const isSupportQueue = (v: string | null | undefined): v is SupportQueue =>
  !!v && (SUPPORT_QUEUES as readonly string[]).includes(v);

/** A desk status as the projects `StatePill` wants it. A desk state carries the
 *  same fields a project state does (name, group, colour) plus an SLA clock the
 *  pill does not use. */
export function toPmState(state: DeskState, projectId = ""): PmState {
  return {
    id: state.id,
    projectId,
    name: state.name,
    group: state.group,
    color: state.color,
    sortOrder: state.sortOrder,
    isDefault: state.isDefault,
  };
}

/** "now", "5m", "2h", "3d", "Sep 12" — the list's last-update column. The full
 *  time is the caller's `title`. Future stamps (a clock skew) read as "now". */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const secs = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Plain multi-line text -> the paragraphs the server's sanitiser allows. Blank
 *  lines split paragraphs, single newlines become <br>, and every character the
 *  parser would treat as markup is escaped first. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .filter((p) => p.trim().length > 0)
    .map((p) => `<p>${escapeHtml(p.trim()).split("\n").join("<br>")}</p>`)
    .join("");
}

/** Whether a desk has a channel that actually delivers replies. Always false
 *  until the email channel lands; the composer's copy reads off it. */
export const hasDeliveryChannel = (channels: ReadonlyArray<{ enabled: boolean }>): boolean =>
  channels.some((c) => c.enabled);
