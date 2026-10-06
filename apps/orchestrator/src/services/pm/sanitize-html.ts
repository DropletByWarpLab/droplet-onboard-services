import sanitizeHtml from "sanitize-html";
import { PM_MENTION_ATTR, isPmMentionId } from "@droplet/shared-types";

/**
 * Strict allowlist for project-management rich text (work-item descriptions and
 * comments). Stored HTML reaches the dashboard via `dangerouslySetInnerHTML`, so
 * this is the authoritative stored-XSS boundary: every PM write path that
 * persists `description_html` / `comment_html` MUST funnel through
 * {@link sanitizePmHtml} before the value hits the database.
 *
 * The allowlist is intentionally minimal — only basic formatting tags a comment
 * or description legitimately needs. Everything else (script/style/iframe/img,
 * inline event handlers, javascript: URLs) is dropped. The MCP service principal
 * can reach these write paths without a human-role session (see
 * `requireRoleOrMcpService`), so a prompt-injected tool call cannot persist an
 * executable payload.
 *
 * WARP-3519 (WS-2) — the ONE exception to "no spans": an @mention,
 * `<span data-mention-id="<User.id>">@Name</span>`. It is allowed as narrowly as
 * the tool permits: that one attribute, on that one tag, with a value that has
 * the SHAPE of an id. The id is read back out of the stored html to decide who
 * is notified (see {@link extractMentionIds}), so a span that does not meet all
 * three is unwrapped to its text rather than kept half-valid.
 */
const BASE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
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
    "h1",
    "h2",
    "h3",
    // Mentions only — `mentionFilter` below unwraps any span that is not one.
    "span",
  ],
  allowedAttributes: {
    a: ["href"],
    span: [PM_MENTION_ATTR],
  },
  // Only http/https/mailto links survive — drops javascript:, data:, vbscript:.
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  // Drop the *contents* of dangerous tags too, not just the tags themselves, so
  // `<script>alert(1)</script>` leaves no residue.
  nonTextTags: ["script", "style", "textarea", "noscript", "iframe"],
};

/**
 * Keep a `<span>` only as a well-formed mention (and, when the caller named the
 * ids it will accept, only as one of those); every other span is unwrapped to
 * its text with `excludeTag`. Reports each kept id to `onMention`.
 *
 * `excludeTag`, not a `transformTags` rename to a disallowed tag name: that
 * route looks equivalent and is not. sanitize-html keys its rename bookkeeping
 * by nesting depth and never clears it for a tag that was dropped, so a dropped
 * mention followed by a KEPT one at the same depth closes the kept one with the
 * stale name (`<span …>@Cara</x-unwrap>`). Pinned in sanitize-html.test.ts.
 */
function mentionFilter(
  allowed: ReadonlySet<string> | undefined,
  onMention?: (id: string) => void,
): (frame: sanitizeHtml.IFrame) => boolean | "excludeTag" {
  return (frame) => {
    if (frame.tag !== "span") return false;
    const id = frame.attribs[PM_MENTION_ATTR];
    if (!isPmMentionId(id) || (allowed !== undefined && !allowed.has(id))) return "excludeTag";
    onMention?.(id);
    return false;
  };
}

export interface SanitizePmHtmlOptions {
  /**
   * When given, a mention of anyone NOT in this set is unwrapped to its plain
   * `@Name` text — how the comment write path drops a mention of somebody who
   * cannot read the item. Omit it to keep every well-formed mention.
   */
  allowedMentionIds?: ReadonlySet<string>;
}

/**
 * Sanitize project-management rich-text HTML against the strict PM allowlist.
 * Centralised here so all three write sites (addComment, createWorkItem,
 * updateWorkItem) share one boundary and a future tightening only changes one
 * place.
 */
export function sanitizePmHtml(html: string, opts: SanitizePmHtmlOptions = {}): string {
  if (!html) return "";
  return sanitizeHtml(html, {
    ...BASE_OPTIONS,
    exclusiveFilter: mentionFilter(opts.allowedMentionIds),
  });
}

/**
 * The user ids mentioned in `html`, de-duplicated, in the order the spans CLOSE
 * (which is document order for every span a person can produce: mentions do not
 * nest).
 *
 * Read by running the SAME sanitizer over the html and listening to which spans
 * it keeps — not by a regex over the string. A mention is therefore exactly
 * what would survive into storage: a span inside a `<script>`, a span with a
 * hostile id, a span carrying any other attribute set — none of those is ever
 * reported, because none of them is ever kept. Callers pass already-sanitized
 * html (the stored value); running it again is idempotent.
 */
export function extractMentionIds(html: string): string[] {
  if (!html) return [];
  const ids = new Set<string>();
  sanitizeHtml(html, {
    ...BASE_OPTIONS,
    exclusiveFilter: mentionFilter(undefined, (id) => ids.add(id)),
  });
  return [...ids];
}
