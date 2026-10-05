/**
 * Service desk email channel (ADR-069 §4, WARP-3529) — loop protection and
 * threading, as pure rules.
 *
 * Nothing here touches a database: every rule is a function over the facts the
 * email-indexer recorded (`EmailMessage.headers`) and the sender's address. The
 * intake service asks `classifyInbound` whether a message may become part of a
 * ticket, and writes the answer down as an explicit `PmEmailIntakeReason` — it
 * never infers "this was ignored" from a missing ticket.
 *
 * A message is never turned into a ticket when a machine wrote it or when this
 * box did. The rules, in the order the reason is recorded:
 *   1. OWN_ADDRESS        — the sender is a mailbox this box operates;
 *   2. OWN_MESSAGE        — the message is one this desk sent;
 *   3. BOUNCE             — a delivery report, a null `Return-Path`, a
 *                           mailer-daemon / postmaster / bounce sender;
 *   4. AUTO_SUBMITTED     — `Auto-Submitted` was anything but `no` (RFC 3834);
 *   5. AUTO_REPLY_HEADER  — `X-Autoreply` or `X-Autorespond` is present;
 *   6. PRECEDENCE_BULK    — `Precedence: bulk | junk | list | auto_reply`.
 * RATE_LIMITED (more than 20 messages an hour from one sender) needs a count and
 * is decided by the intake service, which has the database.
 */
import { z } from "zod";
import type { $Enums } from "@prisma/client";

// ── What the indexer records ─────────────────────────────────────────────────

/**
 * The shape of `EmailMessage.headers` — the ingest route's zod object AND the
 * check a stored value passes before the desk trusts it.
 *
 * `.strict()`, and every key required: an object with a key missing was not
 * written by an indexer that checked these headers, and must not be mistaken for
 * one that did and found nothing. `null` on a field means the header was absent;
 * `""` means it was there and empty (`Return-Path: <>` is exactly that). The
 * bounds are the Python parser's (`MAX_REFERENCES`, `MAX_MESSAGE_ID_LENGTH`).
 */
export const EMAIL_HEADERS_SCHEMA = z
  .object({
    references: z.array(z.string().min(1).max(998)).max(100),
    autoSubmitted: z.string().max(64).nullable(),
    precedence: z.string().max(64).nullable(),
    xAutoreply: z.string().max(64).nullable(),
    xAutorespond: z.string().max(64).nullable(),
    returnPath: z.string().max(320).nullable(),
    reportType: z.string().max(64).nullable(),
  })
  .strict();
export type EmailHeaders = z.infer<typeof EMAIL_HEADERS_SCHEMA>;

/** A stored `headers` value, or null when there is none or it is not the shape an
 *  indexer writes — read by the desk as "could not be checked". */
export function parseStoredHeaders(value: unknown): EmailHeaders | null {
  const parsed = EMAIL_HEADERS_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── Who is a machine ─────────────────────────────────────────────────────────

const localPart = (address: string): string => {
  const at = address.lastIndexOf("@");
  return (at < 0 ? address : address.slice(0, at)).trim().toLowerCase();
};

/** A delivery-failure sender: the local part IS mailer-daemon, postmaster or
 *  bounce(s) (optionally `+tag` / `.tag`) — `daemon@` and `dana.postmaster@` are
 *  people. */
const BOUNCE_SENDER = /^(?:mailer-daemon|postmaster|bounces?)(?:[+._-].*)?$/;

/** A sender that is a robot by the name it chose: not a failure report, but not
 *  somebody to acknowledge either (the address does not read replies). */
const AUTOMATED_SENDER =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounces?)(?:[+._-].*)?$/;

export function looksAutomatedSender(address: string): boolean {
  return AUTOMATED_SENDER.test(localPart(address));
}

const PRECEDENCE_IGNORED: ReadonlySet<string> = new Set(["bulk", "junk", "list", "auto_reply"]);

export type IgnoreReason = Extract<
  $Enums.PmEmailIntakeReason,
  | "AUTO_SUBMITTED"
  | "PRECEDENCE_BULK"
  | "AUTO_REPLY_HEADER"
  | "BOUNCE"
  | "OWN_ADDRESS"
  | "OWN_MESSAGE"
>;

export type InboundVerdict =
  | { kind: "ignore"; reason: IgnoreReason }
  /** `headersChecked` is false when no headers were recorded: the message may
   *  become a ticket, but nothing automatic is sent in answer to something that
   *  could not be checked. */
  | { kind: "process"; headersChecked: boolean };

export interface InboundFacts {
  fromAddr: string;
  /** Null when none were recorded (an indexer older than WARP-3529). */
  headers: EmailHeaders | null;
  /** Lower-cased addresses of every mailbox this box has bound to a desk. */
  ownAddresses: ReadonlySet<string>;
  /** The message's Message-ID is one the desk generated for an email it sent. */
  isOwnOutbound: boolean;
}

export function classifyInbound(facts: InboundFacts): InboundVerdict {
  if (facts.ownAddresses.has(facts.fromAddr.trim().toLowerCase())) {
    return { kind: "ignore", reason: "OWN_ADDRESS" };
  }
  if (facts.isOwnOutbound) return { kind: "ignore", reason: "OWN_MESSAGE" };
  if (BOUNCE_SENDER.test(localPart(facts.fromAddr))) return { kind: "ignore", reason: "BOUNCE" };

  const h = facts.headers;
  if (h === null) return { kind: "process", headersChecked: false };

  if (
    h.reportType !== null ||
    h.returnPath === "" ||
    (h.returnPath !== null && BOUNCE_SENDER.test(localPart(h.returnPath)))
  ) {
    return { kind: "ignore", reason: "BOUNCE" };
  }
  if (h.autoSubmitted !== null && h.autoSubmitted !== "no") {
    return { kind: "ignore", reason: "AUTO_SUBMITTED" };
  }
  if (h.xAutoreply !== null || h.xAutorespond !== null) {
    return { kind: "ignore", reason: "AUTO_REPLY_HEADER" };
  }
  if (h.precedence !== null && PRECEDENCE_IGNORED.has(h.precedence)) {
    return { kind: "ignore", reason: "PRECEDENCE_BULK" };
  }
  return { kind: "process", headersChecked: true };
}

// ── Threading ────────────────────────────────────────────────────────────────

const MAX_CANDIDATES = 120;

const stripBrackets = (id: string): string => {
  const t = id.trim();
  return t.startsWith("<") && t.endsWith(">") ? t.slice(1, -1).trim() : t;
};

/**
 * The Message-IDs a reply is matched by, best first: `In-Reply-To` (the message
 * it answers), then `References` from the newest back to the root. Brackets are
 * stripped, blanks and repeats dropped, and a very long chain is cut in the
 * middle — the root is always kept, because it is what the thread is named by.
 */
export function referenceCandidates(
  inReplyTo: string | null | undefined,
  references: readonly string[],
): string[] {
  const ordered = [inReplyTo ?? "", ...[...references].reverse()]
    .map(stripBrackets)
    .filter((id) => id.length > 0);
  const unique = [...new Set(ordered)];
  if (unique.length <= MAX_CANDIDATES) return unique;
  return [...unique.slice(0, MAX_CANDIDATES - 1), unique[unique.length - 1]!];
}

export interface TicketToken {
  identifier: string;
  sequenceId: number;
}

const TOKEN_SOURCE = String.raw`\[([A-Za-z0-9]{1,10})-(\d{1,9})\]`;

/** Every `[KEY-123]` in a subject, in order, the key upper-cased. */
export function ticketTokens(subject: string): TicketToken[] {
  const out: TicketToken[] = [];
  for (const m of subject.matchAll(new RegExp(TOKEN_SOURCE, "g"))) {
    const sequenceId = Number(m[2]);
    if (sequenceId >= 1) out.push({ identifier: m[1]!.toUpperCase(), sequenceId });
  }
  return out;
}

// ── Subjects ─────────────────────────────────────────────────────────────────

const TITLE_MAX = 500;
const NO_SUBJECT = "(no subject)";
/** Reply prefixes of the common mail clients. `Fwd:` is deliberately NOT here: a
 *  forward says something about the request that a title should keep. */
const REPLY_PREFIX = /^\s*(?:re|aw|sv|antw|vs|odp|rv|res)\s*(?:\[\d+\])?\s*:\s*/i;
const LEADING_TOKEN = new RegExp(String.raw`^\s*${TOKEN_SOURCE}\s*`);

/** Never cut between the two halves of a surrogate pair, and count UTF-16 code
 *  units like zod's `max` does. */
function truncateUtf16(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * A mail subject as a ticket title: reply prefixes and any `[KEY-123]` removed,
 * whitespace and control characters (a CR/LF in a subject is a header break in
 * waiting) collapsed to single spaces, at most 500 characters, never empty.
 */
export function cleanTicketSubject(subject: string): string {
  let s = subject.replace(/[\u0000-\u001f\u007f]+/g, " ");
  for (;;) {
    const next = s.replace(REPLY_PREFIX, "").replace(LEADING_TOKEN, "");
    if (next === s) break;
    s = next;
  }
  s = s.replace(new RegExp(TOKEN_SOURCE, "g"), " ").replace(/\s+/g, " ").trim();
  return s.length === 0 ? NO_SUBJECT : truncateUtf16(s, TITLE_MAX);
}

/**
 * The subject of an email the desk sends for a ticket: `[SUP-12] Title`, with
 * `Re: ` in front when it answers a customer's own mail. The token is what
 * matches the customer's next reply when a client drops the threading headers.
 */
export function ticketSubjectFor(key: string, title: string, answersCustomer: boolean): string {
  return `${answersCustomer ? "Re: " : ""}[${key}] ${cleanTicketSubject(title)}`;
}
