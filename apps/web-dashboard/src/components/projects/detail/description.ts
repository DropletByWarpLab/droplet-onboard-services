// WARP-3520 -- the plain multi-line description editor and the HTML it stores.
//
// The drawer edits a description as plain text and stores sanitized paragraphs
// (the same shape the New item modal writes). A shared rich-text editor lands
// with comments later; until then this is the whole round trip, and the one
// thing it must not do is silently destroy formatting somebody else wrote — so
// `descriptionIsPlain` lets the editor say so before it does.

import { escapeHtml } from "@/lib/escape-html";

/** Text -> stored HTML. Blank lines separate paragraphs, single newlines become
 *  `<br>`. Null for an empty description (the API clears it on null). */
export function textToDescriptionHtml(text: string): string | null {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (t === "") return null;
  return t
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Stored HTML -> the text the editor starts from. Paragraphs and `<br>` keep
 *  their line structure; list items become "- "; every other tag is dropped. */
export function descriptionToText(html: string | null): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(li|ul|ol|h[1-6]|blockquote|pre)>\s*/gi, "\n")
    // Drop incomplete trailing tags too. Entity decoding happens afterwards:
    // literal angle brackets in user text remain plain editor text and are
    // escaped again by textToDescriptionHtml before any HTML is stored.
    .replace(/<[^>]*(?:>|$)/g, "")
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when the HTML uses nothing the plain editor cannot reproduce (`<p>`,
 *  `<br>` and text). Anything else would be flattened by a save. */
export function descriptionIsPlain(html: string | null): boolean {
  if (!html) return true;
  return !/<(?!\/?(p|br)\b)[a-z]/i.test(html);
}
