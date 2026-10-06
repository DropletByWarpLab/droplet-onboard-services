/**
 * WARP-3519 (ADR-069 WS-2) — the vocabulary the PM write boundary and the
 * dashboard share for comment reactions and @mentions.
 *
 * Two layers agree on these values, and a second hand-kept copy on either side
 * is how they drift:
 *
 *  - the orchestrator validates a reaction against {@link PM_REACTION_EMOJI}
 *    before it reaches the database and keeps `data-mention-id` spans through
 *    its HTML sanitizer;
 *  - the dashboard renders the reaction picker from the same list and the
 *    comment editor serialises a mention node to the same attribute.
 */

/**
 * The closed set of reactions a comment accepts, in display order.
 *
 * Spelled with escapes, not literals: the heart is U+2764 U+FE0F and a copy
 * that loses the selector renders identically but is a different string — it
 * would never match a stored row. The test pins the code points.
 */
export const PM_REACTION_EMOJI = [
  "\u{1F44D}", // thumbs up
  "\u{1F44E}", // thumbs down
  "\u{1F604}", // smiling face with open mouth and smiling eyes
  "\u{1F389}", // party popper
  "\u{1F615}", // confused face
  "❤️", // red heart
  "\u{1F680}", // rocket
  "\u{1F440}", // eyes
] as const;

export type PmReactionEmoji = (typeof PM_REACTION_EMOJI)[number];

const VARIATION_SELECTOR = /️/g;

/** emoji-without-selector -> canonical, built once from the list above. */
const CANONICAL_BY_BARE = new Map<string, PmReactionEmoji>(
  PM_REACTION_EMOJI.map((e) => [e.replace(VARIATION_SELECTOR, ""), e] as const),
);

/**
 * The canonical allowlisted emoji for `raw`, or null.
 *
 * Tolerates exactly two differences from the canonical string: surrounding
 * whitespace, and a missing U+FE0F (several keyboards emit the bare heart).
 * Everything else — a skin-tone variant, two emoji glued together, any other
 * emoji, text — is refused: the list is closed, not a family. Never coerces
 * non-strings.
 */
export function normalizePmReactionEmoji(raw: unknown): PmReactionEmoji | null {
  if (typeof raw !== "string") return null;
  const bare = raw.trim().replace(VARIATION_SELECTOR, "");
  if (bare.length === 0) return null;
  return CANONICAL_BY_BARE.get(bare) ?? null;
}

/**
 * The one attribute the PM sanitizer allows on a `<span>`:
 * `<span data-mention-id="<User.id>">@Name</span>`. The editor writes it, the
 * server parses mentions out of the SANITIZED html by it and nothing else —
 * never from a client-supplied list.
 */
export const PM_MENTION_ATTR = "data-mention-id";

/** What a mention id may look like. Deliberately narrower than "any string":
 *  it ends up inside an HTML attribute, and a `User.id` is a uuid. */
const MENTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isPmMentionId(v: unknown): v is string {
  return typeof v === "string" && MENTION_ID.test(v);
}

/**
 * Every `PmActivityVerb`, in schema order.
 *
 * The dashboard's activity timeline builds a sentence for each of these from an
 * exhaustive `Record<PmActivityVerb, …>`, so a verb added to the schema without
 * a sentence is a compile error there — and the orchestrator's schema test
 * asserts this list IS the Prisma enum, so "the timeline renders every verb"
 * cannot rot into "every verb somebody remembered".
 */
export const PM_ACTIVITY_VERBS = [
  "created",
  "updated",
  "state_changed",
  "commented",
  "assigned",
  "unassigned",
  "priority_changed",
  "due_date_changed",
  "start_date_changed",
  "type_changed",
  "estimate_changed",
  "property_changed",
  "title_changed",
  "description_changed",
  "label_added",
  "label_removed",
  "archived",
  "restored",
  "cycle_added",
  "cycle_removed",
  "parent_removed",
  "module_added",
  "module_removed",
  "relation_added",
  "relation_removed",
  "comment_edited",
  "comment_deleted",
  "watcher_added",
  "watcher_removed",
  "mentioned",
  "attachment_added",
  "attachment_removed",
  "external_link_added",
  "time_logged",
  "time_log_updated",
  "time_log_removed",
] as const;

export type PmActivityVerbName = (typeof PM_ACTIVITY_VERBS)[number];

/**
 * The verbs the MERGED timeline leaves out, because the comment entry beside
 * them already says the same thing: `commented` (the comment IS that event —
 * the precedent is tools-core's `mergePmFeed`, which drops it for the same
 * reason) and `mentioned` (the notification-queue entry for one newly mentioned
 * person; the mention chip is in the comment). They stay in the activity table:
 * they are what the notify sweep reads.
 */
export const PM_TIMELINE_MIRRORED_VERBS = [
  "commented",
  "mentioned",
] as const satisfies readonly PmActivityVerbName[];
