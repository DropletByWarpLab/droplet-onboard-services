// Pure rules for the rich-text editor: who a mention list offers, which links it
// accepts, what "empty" means. No React and no DOM, so each rule is unit-tested
// on its own (helpers.test.ts).

import { isNodeEmpty, type Editor } from "@tiptap/core";

/** A person the mention picker can offer. `id` is the local `User.id` the PM
 *  API keys people by; `name` is what the chip shows. */
export interface MentionCandidate {
  id: string;
  name: string;
}

export const MAX_MENTION_ROWS = 8;

const COMBINING_MARKS = /[\u0300-\u036f]/g;
/** Case- and accent-insensitive: "zoe" finds "Zoë". */
const fold = (text: string): string => text.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();

/**
 * The people to list for `query`: names that START with it first, then names
 * that merely contain it, each group in the caller's order, at most
 * {@link MAX_MENTION_ROWS}. An empty query lists the first people as given.
 */
export function matchMentionCandidates(candidates: readonly MentionCandidate[], query: string): MentionCandidate[] {
  const needle = fold(query.trim());
  const leading: MentionCandidate[] = [];
  const inside: MentionCandidate[] = [];
  for (const candidate of candidates) {
    const name = fold(candidate.name);
    if (name.startsWith(needle)) leading.push(candidate);
    else if (name.includes(needle)) inside.push(candidate);
  }
  return leading.concat(inside).slice(0, MAX_MENTION_ROWS);
}

const ALLOWED_SCHEMES = new Set(["http", "https", "mailto"]);
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
/** Characters a browser skips while it reads a URL scheme, so `java\tscript:`
 *  is still `javascript:` to it and must be to us. */
const IGNORED_IN_SCHEME = /[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u180e\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]/g;

/**
 * False only when `url` names a scheme other than http, https or mailto. A
 * value with no scheme passes: that is what lets a typed `example.com` or
 * `ana@example.com` autolink (Tiptap stores the https:// / mailto: form).
 */
export function hasAllowedLinkScheme(url: string | null | undefined): boolean {
  const scheme = SCHEME.exec((url ?? "").replace(IGNORED_IN_SCHEME, ""));
  return scheme === null || ALLOWED_SCHEMES.has(scheme[1].toLowerCase());
}

const LINK_INPUT = /^(?:https?:\/\/|mailto:)\S+$/i;

/** What the Link row accepts: an explicit http, https or mailto address, with
 *  something after the scheme. Returns the trimmed address, or null. */
export function parseLinkInput(raw: string): string | null {
  const href = raw.trim();
  return LINK_INPUT.test(href) ? href : null;
}

/** True when `editor` holds nothing a person could read: no text beyond
 *  whitespace and line breaks. A mention is content. This is the server's rule
 *  for `empty_comment`, so "Send" is never enabled for a comment it will refuse. */
export function isEditorEmpty(editor: Editor): boolean {
  return isNodeEmpty(editor.state.doc, { ignoreWhitespace: true });
}

/** The same rule for html that has no editor behind it yet. */
export function isBlankHtml(html: string | undefined): boolean {
  return (html ?? "")
    .replace(/<[^>]*(?:>|$)/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .trim() === "";
}
