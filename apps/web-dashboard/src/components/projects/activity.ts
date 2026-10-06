// Pure helpers for the work-item Activity section (WARP-3519): the one sentence
// per activity verb, what the inline editor can round-trip, and the small
// reaction / mention-candidate transforms. No React in here.

import {
  PM_MENTION_ATTR,
  PM_REACTION_EMOJI,
  type PmActivityVerbName,
  type PmReactionEmoji,
} from "@droplet/shared-types";
import { PRIORITY, fmtISODate } from "./config";
import type { PmActivity, PmReaction, PmTimelineEntry, PmTimelineRefs } from "./types";

/** Own-property read: a value that came off the wire is never allowed to
 *  resolve to something on Object.prototype ("constructor", "toString"). */
function lookup<T>(map: Record<string, T>, key: string | null | undefined): T | undefined {
  return key != null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

// ── Filter ──────────────────────────────────────────────────────────────────

export type ActivityFilter = "all" | "comments" | "history";

export const ACTIVITY_FILTERS: ReadonlyArray<{ id: ActivityFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "comments", label: "Comments" },
  { id: "history", label: "History" },
];

export function filterTimeline(
  entries: readonly PmTimelineEntry[],
  filter: ActivityFilter,
): PmTimelineEntry[] {
  if (filter === "all") return [...entries];
  const want = filter === "comments" ? "comment" : "activity";
  return entries.filter((e) => e.type === want);
}

export function emptyCopy(filter: ActivityFilter): string {
  return filter === "comments" ? "No comments yet." : "No activity yet.";
}

// ── One sentence per verb ───────────────────────────────────────────────────

export interface ActivityContext {
  /** Display name for a user id; "someone" for a missing one. */
  name: (id: string | null | undefined) => string;
  refs: PmTimelineRefs;
}

type Describe = (activity: PmActivity, ctx: ActivityContext) => string;

/** "Themselves" only when there IS a value and it is the actor — a missing
 *  value and a missing actor (the AI) must not read as the same person. */
const isSelf = (value: string | null, actorId: string | null): boolean =>
  value !== null && value === actorId;

const RELATION_KIND: Record<string, string> = {
  BLOCKS: "blocks",
  RELATES: "relates to",
  DUPLICATES: "duplicates",
};

/** `KIND:<work item id>` → "INBOX-2 (blocks)"; names the OTHER end. */
function relationTail(value: string | null, refs: PmTimelineRefs): string {
  const [kind, ...rest] = (value ?? "").split(":");
  const target = lookup(refs.workItems, rest.join(":"))?.key ?? "another item";
  const label = lookup(RELATION_KIND, kind);
  return label ? `${target} (${label})` : target;
}

/** Exhaustive on purpose: a verb added to the schema without a sentence here is
 *  a compile error, not a raw `snake_case` token in somebody's timeline. */
const SENTENCES: Record<PmActivityVerbName, Describe> = {
  created: () => "created this item",
  // Legacy rows: `updated` + a field name, from before each change had a verb.
  updated: (a) => {
    switch (a.field) {
      case "priority":
        return "changed the priority";
      // ADR-045 §5.3 — re-routing work to another department is a decision
      // about who owns it, and "updated this item" hides exactly that.
      case "department":
        return "changed the department";
      case "startDate":
        return "changed the start date";
      default:
        return "updated this item";
    }
  },
  state_changed: (a, c) => `moved this to ${lookup(c.refs.states, a.newValue) ?? "another state"}`,
  commented: () => "added a comment",
  assigned: (a, c) =>
    isSelf(a.newValue, a.actorId) ? "assigned themselves" : `assigned ${c.name(a.newValue)}`,
  unassigned: (a, c) =>
    isSelf(a.oldValue, a.actorId) ? "unassigned themselves" : `unassigned ${c.name(a.oldValue)}`,
  priority_changed: (a) => {
    const label = lookup(PRIORITY, a.newValue)?.label;
    return label ? `set the priority to ${label}` : "changed the priority";
  },
  due_date_changed: (a) =>
    a.newValue ? `set the due date to ${fmtISODate(a.newValue)}` : "removed the due date",
  title_changed: (a) => (a.newValue ? `renamed this to "${a.newValue}"` : "renamed this item"),
  description_changed: () => "edited the description",
  label_added: (a, c) => `added the label ${lookup(c.refs.labels, a.newValue)?.name ?? "a label"}`,
  label_removed: (a, c) => `removed the label ${lookup(c.refs.labels, a.oldValue)?.name ?? "a label"}`,
  archived: () => "archived this item",
  restored: () => "restored this item",
  cycle_added: () => "added this to a cycle",
  cycle_removed: () => "removed this from a cycle",
  parent_removed: () => "removed this item's parent",
  module_added: () => "added this to a module",
  module_removed: () => "removed this from a module",
  relation_added: (a, c) => `linked this with ${relationTail(a.newValue, c.refs)}`,
  relation_removed: (a, c) => `unlinked this from ${relationTail(a.oldValue, c.refs)}`,
  sla_at_risk: () => "marked the SLA as at risk",
  sla_breached: () => "marked the SLA as breached",
  macro_applied: (a) => a.newValue ? `applied the macro ${a.newValue}` : "applied a macro",
  comment_edited: () => "edited a comment",
  comment_deleted: () => "deleted a comment",
  watcher_added: (a, c) =>
    isSelf(a.newValue, a.actorId) ? "started watching this" : `added ${c.name(a.newValue)} as a watcher`,
  watcher_removed: (a, c) =>
    isSelf(a.oldValue, a.actorId)
      ? "stopped watching this"
      : `removed ${c.name(a.oldValue)} as a watcher`,
  mentioned: (a, c) => `mentioned ${c.name(a.newValue)}`,
  start_date_changed: (a) => a.newValue ? `set the start date to ${fmtISODate(a.newValue)}` : "removed the start date",
  type_changed: (a) => a.newValue ? `changed the type to ${a.newValue}` : "changed the type",
  estimate_changed: (a) => a.newValue ? `set the estimate to ${a.newValue}` : "removed the estimate",
  property_changed: (a) => `changed ${a.field ?? "a custom field"}`,
  attachment_added: (a) => a.newValue ? `added ${a.newValue}` : "added an attachment",
  attachment_removed: (a) => a.oldValue ? `removed ${a.oldValue}` : "removed an attachment",
  external_link_added: (a) => a.newValue ? `linked ${a.newValue}` : "added a development link",
  time_logged: (a) => `logged ${a.newValue ?? "time"} minutes`,
  time_log_updated: (a) =>
    a.oldValue !== null && a.newValue !== null
      ? `changed a worklog from ${a.oldValue} to ${a.newValue} minutes`
      : "updated a worklog",
  time_log_removed: (a) =>
    a.oldValue !== null ? `removed a ${a.oldValue}-minute worklog` : "removed a worklog",
};

/** The sentence that follows the actor's name. An older client talking to a
 *  newer server can be handed a verb it has no sentence for; that reads as
 *  "did something" rather than crashing the whole timeline. */
export function describeActivity(activity: PmActivity, ctx: ActivityContext): string {
  const describe = lookup(SENTENCES as Record<string, Describe>, activity.verb);
  return describe ? describe(activity, ctx) : "did something";
}

// ── What the inline editor can round-trip ───────────────────────────────────

/** Everything the toolbar can author, plus paragraphs/breaks and the mention
 *  span — the dashboard editor's whole vocabulary. */
const EDITOR_TAGS = new Set([
  "p",
  "br",
  "strong",
  "em",
  "ul",
  "ol",
  "li",
  "a",
  "code",
  "pre",
  "blockquote",
  "span",
]);

/** True when the editor can load `html` and write it back without losing
 *  anything. The server's allowlist is wider than the editor's (headings, for
 *  one, can arrive from the mobile API or an MCP tool), and Edit on such a
 *  comment would silently flatten them — so it is not offered. */
export function isPlainEditable(html: string): boolean {
  if (typeof DOMParser === "undefined") return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  // From the document root, not <body>: a leading <script>/<style> is parsed
  // into <head>.
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (tag === "html" || tag === "head" || tag === "body") continue;
    if (!EDITOR_TAGS.has(tag)) return false;
    if (tag === "span" && !el.hasAttribute(PM_MENTION_ATTR)) return false;
  }
  return true;
}

// ── Reactions ───────────────────────────────────────────────────────────────

const [UP, DOWN, SMILE, PARTY, CONFUSED, HEART, ROCKET, EYES] = PM_REACTION_EMOJI;
/** Accessible names for the picker buttons — exhaustive over the allowlist. */
const REACTION_NAMES: Record<PmReactionEmoji, string> = {
  [UP]: "thumbs up",
  [DOWN]: "thumbs down",
  [SMILE]: "smile",
  [PARTY]: "party",
  [CONFUSED]: "confused",
  [HEART]: "heart",
  [ROCKET]: "rocket",
  [EYES]: "eyes",
};

export function reactionName(emoji: string): string {
  return lookup(REACTION_NAMES, emoji) ?? emoji;
}

/** Tooltip for a reaction chip: up to five names, then "and N more". */
export function reactionTitle(names: readonly string[]): string {
  const shown = names.slice(0, 5).join(", ");
  const more = names.length - 5;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

function emojiRank(emoji: string): number {
  const i = (PM_REACTION_EMOJI as readonly string[]).indexOf(emoji);
  return i < 0 ? PM_REACTION_EMOJI.length : i;
}

/** The viewer's reaction toggle, applied locally ahead of the server so the
 *  chip flips on click. Pure; keeps the server's allowlist order. */
export function applyReaction(
  reactions: readonly PmReaction[],
  emoji: string,
  userId: string,
  on: boolean,
): PmReaction[] {
  const existing = reactions.find((r) => r.emoji === emoji);
  if (!existing) {
    if (!on) return [...reactions];
    const added: PmReaction = { emoji, count: 1, userIds: [userId] };
    const at = reactions.findIndex((r) => emojiRank(r.emoji) > emojiRank(emoji));
    return at < 0 ? [...reactions, added] : [...reactions.slice(0, at), added, ...reactions.slice(at)];
  }
  if (existing.userIds.includes(userId) === on) return [...reactions];
  const count = existing.count + (on ? 1 : -1);
  if (count <= 0) return reactions.filter((r) => r !== existing);
  const userIds = on ? [...existing.userIds, userId] : existing.userIds.filter((u) => u !== userId);
  return reactions.map((r) => (r === existing ? { ...existing, count, userIds } : r));
}

// ── Mentions ────────────────────────────────────────────────────────────────

/** Structurally the editor's `MentionCandidate`. */
export interface MentionCandidateLike {
  id: string;
  name: string;
}

/** Who the @-picker offers: `{ id: local User.id, name }` for every directory
 *  user that has a local row (PM ids are the local User.id, never the Nextcloud
 *  username). `undefined` — not `[]` — when the directory could not be read, so
 *  the editor can say "People aren't available right now." instead of "No
 *  people match.". */
export function mentionCandidatesFrom(
  users: ReadonlyArray<{ userId?: string | null; displayName: string }> | undefined,
): MentionCandidateLike[] | undefined {
  if (!users) return undefined;
  return users.flatMap((u) => (u.userId ? [{ id: u.userId, name: u.displayName }] : []));
}

// ── Time ────────────────────────────────────────────────────────────────────

/** The tooltip behind a relative time — "Jun 22, 2026, 9:16 PM" in the viewer's locale. */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
