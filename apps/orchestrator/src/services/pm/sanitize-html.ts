import sanitizeHtml from "sanitize-html";

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
 */
const PM_HTML_OPTIONS: sanitizeHtml.IOptions = {
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
  ],
  allowedAttributes: {
    a: ["href"],
  },
  // Only http/https/mailto links survive — drops javascript:, data:, vbscript:.
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  // Drop the *contents* of dangerous tags too, not just the tags themselves, so
  // `<script>alert(1)</script>` leaves no residue.
  nonTextTags: ["script", "style", "textarea", "noscript", "iframe"],
};

/**
 * Sanitize project-management rich-text HTML against the strict PM allowlist.
 * Centralised here so all three write sites (addComment, createWorkItem,
 * updateWorkItem) share one boundary and a future tightening only changes one
 * place.
 */
export function sanitizePmHtml(html: string): string {
  if (!html) return "";
  return sanitizeHtml(html, PM_HTML_OPTIONS);
}
