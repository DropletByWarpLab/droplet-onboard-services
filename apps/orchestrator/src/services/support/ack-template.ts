/**
 * Service desk email channel (ADR-069 §4, WARP-3529) — the automatic
 * acknowledgement a desk can send when a customer's email opens a ticket.
 *
 * The template is plain text an administrator writes with four variables:
 *
 *     {{requester.firstName}}  {{ticket.key}}  {{ticket.title}}  {{desk.name}}
 *
 * 🔴 It is VALIDATED when it is saved and ESCAPED when it is rendered, because
 * the values are a stranger's words (the title is the subject line they chose,
 * the first name is whatever their mail client calls them) going back out in an
 * email AND onto a ticket's conversation as HTML:
 *   - a name outside the four is refused at save time, by name, so a typo is the
 *     administrator's to fix and not something a customer receives as `{{ticket.kye}}`;
 *   - a placeholder is expanded ONCE — a title that looks like `{{desk.name}}` is
 *     text, not a second template;
 *   - every value loses control and bidi-override characters and is bounded
 *     (a CR/LF in a value is a line break the template did not write);
 *   - the HTML is made from the rendered TEXT with every markup character
 *     escaped, so no value can add a tag.
 */
import { textToHtml } from "./email-text.js";

const DESK_NAME_VARIABLE = `desk.${"name"}` as const;
export const ACK_VARIABLES = ["requester.firstName", "ticket.key", "ticket.title", DESK_NAME_VARIABLE] as const;
export type AckVariable = (typeof ACK_VARIABLES)[number];

/** The same bound the database holds (`PmSupportChannel_template_length`). */
export const ACK_TEMPLATE_MAX = 4000;

export const DEFAULT_ACK_TEMPLATE = [
  "Hi {{requester.firstName}},",
  "",
  "Thanks for getting in touch. We have received your request and logged it as {{ticket.key}}.",
  "",
  "Someone from {{desk.name}} will reply as soon as they can. You can answer this email to add more detail.",
  "",
  "— {{desk.name}}",
].join("\n");

export type AckTemplateProblem =
  | { code: "empty" }
  | { code: "too_long" }
  | { code: "malformed" }
  | { code: "unknown_variable"; name: string };

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** Everything wrong with a template, in the order it is met; `[]` means it can be
 *  saved. */
export function checkAckTemplate(template: string): AckTemplateProblem[] {
  if (template.trim().length === 0) return [{ code: "empty" }];
  if (template.length > ACK_TEMPLATE_MAX) return [{ code: "too_long" }];
  const problems: AckTemplateProblem[] = [];
  const known: readonly string[] = ACK_VARIABLES;
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1]!.trim();
    if (!known.includes(name)) problems.push({ code: "unknown_variable", name });
  }
  // A brace that opens or closes nothing is a template that will send `{{` to a customer.
  if (/\{\{|\}\}/.test(template.replace(PLACEHOLDER, ""))) problems.push({ code: "malformed" });
  return problems;
}

// ── Values ───────────────────────────────────────────────────────────────────

export interface AckValues {
  /** The requester's name as the ticket holds it — a display name, or an address. */
  requesterName: string | null;
  /** The contact's given name when the address book has one. */
  requesterGivenName: string | null;
  ticketKey: string;
  ticketTitle: string;
  deskName: string;
}

/** What the settings preview renders with. */
export const ACK_SAMPLE: AckValues = {
  requesterName: "Alex Morgan",
  requesterGivenName: null,
  ticketKey: "SUP-123",
  ticketTitle: "The printer on the second floor is offline",
  deskName: "Support",
};

/** Control characters, line separators and the bidirectional overrides. */
const UNSAFE = /[\u0000-\u001f\u007f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

function cleanValue(value: string, max: number): string {
  const s = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut) + "…";
}

/** A greeting name: the given name when there is one, else the first word of the
 *  display name — and `there` whenever that would be a guess (an address, an
 *  empty name, or a `Last, First` the order of which cannot be known). */
export function ackFirstName(name: string | null, givenName: string | null): string {
  const given = givenName ? cleanValue(givenName, 60) : "";
  if (given) return given;
  // A display-name header may contain an injected second line. Only the
  // original first line can provide a greeting name.
  const firstLine = name?.split(/[\r\n\u2028\u2029]/, 1)[0];
  const full = firstLine ? cleanValue(firstLine, 200) : "";
  if (!full || full.includes("@") || full.includes(",")) return "there";
  const first = full.split(" ")[0] ?? "";
  return /[\p{L}\p{N}]/u.test(first) ? cleanValue(first, 60) : "there";
}

export interface RenderedAck {
  /** What is emailed. */
  text: string;
  /** What the ticket's conversation shows — the same words, escaped. */
  html: string;
}

export function renderAckTemplate(template: string, v: AckValues): RenderedAck {
  const resolved: Record<AckVariable, string> = {
    "requester.firstName": ackFirstName(v.requesterName, v.requesterGivenName),
    "ticket.key": cleanValue(v.ticketKey, 24),
    "ticket.title": cleanValue(v.ticketTitle, 200),
    [DESK_NAME_VARIABLE]: cleanValue(v.deskName, 100),
  };
  const known: readonly string[] = ACK_VARIABLES;
  // One pass over the TEMPLATE: what a value contains is never looked at again.
  const text = template.replace(PLACEHOLDER, (_whole, inner: string) => {
    const name = inner.trim();
    return known.includes(name) ? resolved[name as AckVariable] : "";
  });
  return { text, html: textToHtml(text) };
}
