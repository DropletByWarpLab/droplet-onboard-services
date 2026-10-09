/**
 * WARP-3348 — does the final answer claim an action that did not happen?
 *
 * Romain, 2026-09-29: (A) "send a check to validate" — the agent must never
 * tell the person an action happened when it didn't; (B) no permission-check
 * tool, but when a write is refused for lack of permission the person is told.
 *
 * Eval evidence (gpt-oss:20b): adv-011 answered "I've already sent a team chat
 * message to Alice" when nothing was sent (a planted instruction in a tool
 * result); seed-007 said "The task ... has been created" while the create was
 * still waiting for approval; seed-010 said "I've verified that you can
 * delete" with no check (there is no tool that checks permissions).
 *
 * This module is the one source of truth for "what did the answer say
 * happened, and did it". It replaced WARP-2544's advisory detector
 * (tool-use-validation.ts), which logged the same question with its own verb
 * list after the answer had already gone out. The loop
 * (`llm-agent.service.ts`, `settleActionClaims`) owns what happens on a
 * mismatch: one no-tools correction call, then a fixed status line.
 *
 * PRECISION OVER RECALL. A false positive rewrites a correct answer and costs
 * an inference call, so every rule errs toward "not a claim":
 *   - past or perfect tense only, first person ("I've sent", "I deleted") or a
 *     perfect passive ("has been created"); never future, modal or conditional;
 *   - quoted text, `>` quote lines and code blocks are not the assistant's
 *     claims; neither is what follows a third party's reporting verb ("Bob
 *     wrote …", "the ticket says …"), while "you said" / "you mentioned" is
 *     the person, and the claim around it still counts;
 *   - a clause with a negation, an offer or a condition is skipped; a sentence
 *     with a question mark, pending-approval wording ("waiting for your
 *     approval"), a time expression ("earlier", "since March") or a
 *     "below/above" pointer is skipped whole;
 *   - "sent", "deleted" and real-world state changes ("disabled", "locked",
 *     "scheduled", "approved") are STRICT: flagged when nothing of that
 *     family ran. The other change verbs ("created", "updated", "added",
 *     "saved") also describe edits to the model's own text ("I've updated
 *     the draft:"), so they, and every passive, are flagged only when this
 *     turn attempted a write of that family and it did not run;
 *   - every family a sentence claims is checked ("I've emailed Dave and I've
 *     cancelled the meeting" is two claims);
 *   - a sentence that OPENS on a sent message with no subject ("Message sent
 *     to Alice: …", "(Team chat message sent …)") is a strict send claim: it
 *     was the model's commonest false send in the eval (adv-011);
 *   - so is a clause that opens on a send or delete verb with no subject and
 *     an object after it ("(Also notified Alice that ...)", "Sent a message to
 *     Alice ...", "Notified Alice."; adv-011), but not a label ("Deleted files
 *     go to the Trash", "Shared with me:") and not after a "Name:" label
 *     ("- Alice: Posted …");
 *   - a label ("…:") hands a skip to what it introduces: "Bob wrote:" / "The
 *     ticket says:" skips it all (someone else's words); a past time or an
 *     "as / per / according to" frame that HEADS it ("Yesterday:", "As Bob
 *     mentioned:") skips everything but the assistant's own "I've …";
 *     "today", "this week", "below", a count label, or a time inside it
 *     ("…the files you uploaded yesterday:") only switch off the subject-less
 *     checks;
 *   - "I've sent the request / sent it to the approval prompt" and "drafted"
 *     describe the approval step, not the action (eval: adv-004, seed-011,
 *     seed-028, seed-007).
 *
 * Families come from write metadata, not a per-tool list: the caller says
 * which tools write (the loop's catalog + runtime classification), and a
 * write's family is the verb in its name (send / delete, else "change").
 * "Sent" and "deleted" need their own family to have run; a state change a
 * change or a delete ("I've cancelled the meeting" via `delete_event`); an
 * edit claim any write ("I moved it to the trash" describes a delete).
 *
 * KNOWN GAPS, accepted: verb-first CHANGE claims without a subject ("✅
 * Created the task", a bullet "- Updated SUP-42"); a subject-less send after a
 * label that is not a channel ("Done: Sent the invoice"), or under a "today" /
 * "this week" label; a second verb sharing one subject ("I've emailed Dave and
 * cancelled …" checks the first); plain past passives ("was sent"); answers
 * not in English. Known false positive: a generic sentence opening on a bare
 * plural ("Deleted files that are older than 30 days are purged.", "Shared
 * links to external users expire …") has the shape of "Emailed clients that
 * the office is closed." and is flagged the same way.
 */
import type { AgentTraceEntry } from "../types/agent-trace.js";

export type ClaimFamily = "send" | "delete" | "change";

export interface ActionClaim {
  /** The sentence as the model wrote it. Model prose: never log it. */
  sentence: string;
  /** `permission_check` = "I've verified that you can …" (no tool checks that). */
  family: ClaimFamily | "permission_check";
  /** Flagged even when this turn attempted nothing of its family. */
  strict: boolean;
}

export type WriteOutcome =
  | "executed"
  | "pending" // waiting for the person's thumbs-up
  | "declined" // the person said no (a durable run's CONFIRMATION_DENIED)
  | "forbidden" // refused for lack of permission (role, handler, deny tier, remote policy)
  | "failed"
  | "unclear"; // may or may not have run: a timeout, a thrown dispatch

export interface WriteAttempt {
  tool: string;
  family: ClaimFamily;
  outcome: WriteOutcome;
  code?: string;
}

// ── claim detection ─────────────────────────────────────────────────

const SEND_VERBS = "sent|messaged|emailed|texted|forwarded|notified|shared|posted|invited";
const DELETE_VERBS = "deleted|erased|trashed|purged|wiped";
// Real-world state: rarely a turn of phrase, and a false one is a safety issue.
const STATE_VERBS = [
  "scheduled", "rescheduled", "booked", "cancell?ed", "canceled", "blocked", "unblocked",
  "enabled", "disabled", "locked", "unlocked", "restarted", "rebooted", "armed", "disarmed",
  "approved",
  // "turned the camera off" — only with on/off somewhere after it.
  String.raw`(?:turned|switched)(?=.*\b(?:on|off)\b)`,
].join("|");
// Also used for edits to the model's own text ("I've updated the draft:").
// Left out entirely, each common in plain prose: set, started, stopped, ran,
// applied, completed, made, wrote, prepared, checked, listed.
const EDIT_VERBS = [
  "created", "added", "saved", "stored", "recorded", "updated", "changed",
  "modified", "edited", "renamed", "moved", "closed", "reopened", "marked", "assigned",
  "reassigned", "removed", "installed", "configured", "restored", "archived", "uploaded",
  "copied", "filed", "set up",
].join("|");

const ADVERBS = String.raw`(?:(?:just|already|now|also|successfully|finally|gone ahead and)\s+)*`;
const firstPerson = (verbs: string) =>
  new RegExp(String.raw`(?:\bi(?:'ve| have| had)?\s+${ADVERBS}|^\s*(?:and\s+)?successfully\s+)(?:${verbs})\b`);
const perfectPassive = (verbs: string) =>
  new RegExp(String.raw`\b(?:has|have)\s+${ADVERBS}been\s+${ADVERBS}(?:${verbs})\b|\b(?:was|were)\s+successfully\s+(?:${verbs})\b`);

const PATTERNS = (
  [
    ["send", SEND_VERBS, true],
    ["delete", DELETE_VERBS, true],
    ["change", STATE_VERBS, true],
    ["change", EDIT_VERBS, false],
  ] as const
).map(([family, verbs, strict]) => ({
  family,
  strict,
  firstPerson: firstPerson(verbs),
  passive: perfectPassive(verbs),
}));

/** Skips the CLAUSE: negated, hedged, conditional, an offer, or addressed to the person. */
const CLAUSE_NOT_A_CLAIM = new RegExp(
  [
    String.raw`n't\b|\b(?:not|no|never|nothing|none|neither|nor|without|unable|cannot|failed|failure)\b`,
    // offers, modals, conditionals — "it would have been sent", "once you approve"
    String.raw`\b(?:will|would|could|should|might|may|must|shall|going to|about to|ready to|once|if|unless|until|when you|after you)\b`,
    String.raw`\b(?:let me know|would you like|do you want|want me to)\b`,
    // "I've shared the steps with you" is the answer itself, not a send
    String.raw`\bshared\b.*\bwith you\b`,
    // the approval step itself: "I've sent the request to create the task",
    // "I've sent the draft to the confirmation prompt" (eval: adv-004, seed-011, seed-028)
    String.raw`\bsent\b.*\b(?:request|prompt)\b`,
  ].join("|"),
);
/** A truly past time: a label with one introduces a record, never this turn's action. */
const PAST = String.raw`\b(?:earlier|previously|yesterday|ago|last (?:time|week|month|year|night)|in the past|originally)\b`;
/** A past time that HEADS a label ("Yesterday:", "Last week:", "Two days ago:"), not one inside it. */
const PAST_HEAD =
  /^[^a-z]*(?:(?:\w+\s+){0,2}ago|earlier|previously|yesterday|last (?:time|week|month|year|night)|in the past|originally)\b/;
/** "I've …" / "I have …": the assistant's own present perfect, which even a reported or past label cannot date. */
const PRESENT_PERFECT = /\bi(?:'ve| have)\s/;
/**
 * Skips the SENTENCE: pending approval (it qualifies the whole sentence: "I've
 * saved the fact, pending your approval" is honest), a time expression, a
 * pointer at the answer itself.
 */
const SENTENCE_NOT_A_CLAIM = new RegExp(
  [
    String.raw`\b(?:pending|awaiting|waiting (?:for|on)|(?:needs?|requires?) (?:your )?(?:approval|confirmation|sign-off|thumbs-up)|approval (?:request|prompt)|(?:for|until|after) your (?:approval|confirmation)|please (?:approve|confirm))\b`,
    PAST,
    String.raw`\b(?:since|before) (?:then|today|yesterday|last|this|the (?:start|beginning|end)|\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|(?:mon|tues|wednes|thurs|fri|satur|sun)day)`,
    String.raw`\b(?:below|above|in this (?:answer|reply|message|response))\b`,
  ].join("|"),
);
/**
 * A third party's reporting verb: what follows it is reported, not claimed.
 * "You said / you mentioned" is the person talking to us, so it does not cut.
 */
const REPORTED = /(?<!\byou\s)\b(?:says|said|wrote|writes|replied|replies|states|stated|mentions|mentioned|reads|according to)\b/;
/** Extra skips for the passive voice, which also describes records read back. */
const PASSIVE_NOT_A_CLAIM =
  /\bby\b|\b(?:19|20)\d\d\b|\b(?:that|which|who)\s+(?:has|have)\s+been\b|\bon (?:mon|tue|wed|thu|fri|sat|sun)/;
/**
 * A sentence that opens on a sent message with no subject: "Message sent to
 * Alice: …", "(Team chat message sent to Alice …)", "Email sent." Not a record
 * read back ("Last email sent to Bob …", "messages sent this week"), not "The
 * message sent to Alice says …" (a record), not "has been sent" (the passive).
 */
const ELLIPTICAL_SEND =
  /^[\s(\[\u2022\u2705-]*(?:team chat\s+|chat\s+)?(?:message|email|e-mail|text|reminder|invite|invitation|notification)s?\s+(?:successfully\s+)?sent\b/;
// A record read back: a "latest / last / previous" opener ("Latest activity —
// deleted …") or a count label ("Messages sent to Alice this month: 3",
// "Emails sent to clients today: 14"). A time anywhere else is not one:
// "Email sent to Bob today." and "… that payroll is late this month" are claims.
const OLDER = /^[^a-z]*(?:the\s+)?(?:last|latest|most recent|previous)\b|\b(?:today|this\s+(?:week|month|year))\s*:(?:\s*\d[\d,]*)?\s*$/;
/** "Today" / "this week" in a label: what it introduces may be a record. */
const NOW_TIME = /\b(?:today|this\s+(?:week|month|year))\b/;
/**
 * A clause that opens on a send or delete verb with no subject: "(Also
 * notified Alice that ...)", "Sent a message to Alice ...", "- Deleted 3
 * files". It is a claim only with an OBJECT (or a NAME) after the verb;
 * without one the participle is a label or an adjective: "Deleted files go to
 * the Trash", "Shared with me:", "Sent messages are kept …", "Forwarded from
 * Dave:". "Sent items" / "Sent mail" are mailbox folders.
 */
const VERB_FIRST = new RegExp(
  String.raw`^[\s(\[•✅-]*${ADVERBS}(?:(${SEND_VERBS})|(${DELETE_VERBS}))\s+(?!items\b|mail\b)`,
);
/**
 * An article, pronoun or number; a word (not a preposition, so not a label
 * like "Shared with the Finance team:") then that/about/saying/to or an
 * article; a path, or a file name with an extension (not ".tmp", not "v1.2").
 */
const OBJECT = new RegExp(
  String.raw`^(?:(?:a|an|the|this|these|it|them|all|your|\d+)\b` +
    String.raw`|(?!(?:to|with|from|in|on|by|for|at|of|via)\b)\S+\s+(?:that|about|saying|to|a|an|the)\b` +
    String.raw`|\S*\/\w|[^\s./]+\.[a-z][a-z0-9]{0,4}(?=\.?(?:\s|$)|[,;:!?)]))`,
);
/** A capitalized name, or two joined by "and", that ends the clause ("Notified Alice.", "Notified Alice and Bob."). Cased text. */
const NAME = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:\s+and\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)?(?=\s*[.;!)])/;
/**
 * An inline label a subject-less verb may follow: a channel ("(Team chat: Sent
 * …"). After any other label the label is the subject ("- Alice: Posted the
 * release notes.").
 */
const CHANNEL_LABEL =
  /^[\s(\[\u2022\u2705-]*(?:team chat|chat|email|e-mail|text|message|reminder|invite|invitation|notification)s?:$/;

const PERMISSION_CHECK = new RegExp(
  String.raw`\bi(?:'ve| have)?\s+${ADVERBS}(?:verified|checked|confirmed|made sure)\s+(?:that\s+)?you(?:'re| are)?\s+(?:can (?:delete|remove|send|edit|change|modify|create|write|update|move|rename|do (?:that|this|it))|are allowed|allowed|are permitted|permitted|are authori[sz]ed|authori[sz]ed|have (?:the )?(?:permission|rights?))\b`,
);
const HARD_NEGATION = new RegExp(String.raw`n't\b|\b(?:not|never|unable|cannot)\b`);

function normalize(s: string): string {
  return unmark(s).toLowerCase();
}
/** Curly apostrophes made straight, markdown emphasis dropped; case kept. */
function unmark(s: string): string {
  return s
    .replace(/[‘’ʼ]/g, "'") // gpt-oss writes "I’ve"
    .replace(/[*`~]/g, "");
}

/** What the assistant did not say in its own voice: quotes, quote lines, code. */
function withoutQuotedText(answer: string): string {
  return answer
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/^[ \t]*>.*$/gm, " ")
    .replace(/“[^”\n]*”|"[^"\n]*"|‘[^’\n]*’/g, " ")
    // straight single quotes only as a pair around words, never an apostrophe
    .replace(/(^|[\s(:])'[^'\n]*'(?=[\s.,;:!?)]|$)/g, "$1 ");
}

/**
 * What a label ("…:") hands to what it introduces, weakest first: "soft" turns
 * off the subject-less checks; "full" also skips everything but the
 * assistant's own "I've …"; "quote" skips it all, because after "Bob wrote:" /
 * "The ticket says:" the words are someone else's, quoted or not.
 */
type Carry = "" | "soft" | "full" | "quote";
const CARRY_ORDER: Carry[] = ["", "soft", "full", "quote"];
/** "As Bob mentioned:", "According to the ticket:": the assistant keeps speaking in its own voice. */
const ATTRIBUTION = /^[^a-z]*(?:as|per|like|according to)\b/;
function carryOf(label: string): Carry {
  if (headedReport(label)) return ATTRIBUTION.test(label) ? "full" : "quote";
  if (PAST_HEAD.test(label)) return "full";
  return SENTENCE_NOT_A_CLAIM.test(label) || REPORTED.test(label) || OLDER.test(label) || NOW_TIME.test(label)
    ? "soft"
    : "";
}
/** "Bob wrote:", "As Bob mentioned:", "According to the ticket:"; not "…the files you mentioned:". */
function headedReport(label: string): boolean {
  const m = REPORTED.exec(label);
  if (!m) return false;
  const before = label.slice(0, m.index).split(/\s+/).filter(Boolean);
  return before.length <= 3 && !before.some((w) => /^(?:you|that|which|who|i|we)$/.test(w));
}
const strongest = (a: Carry, b: Carry): Carry => (CARRY_ORDER.indexOf(a) >= CARRY_ORDER.indexOf(b) ? a : b);
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s/;

/**
 * Completed-action claims in `answer`: one per distinct family (and
 * strictness) per sentence. Sentence scope keeps an honest "I couldn't send
 * it." from suppressing a false claim two sentences later; clause scope keeps
 * "…, let me know if you need anything else" from hiding the claim before it.
 */
export function detectActionClaims(answer: string): ActionClaim[] {
  const claims: ActionClaim[] = [];
  // A label ("…:") hands its carry (carryOf) to what it introduces: inline,
  // the next fragment; at the end of a line, the next line, or every line of
  // the bullet list that starts there. On the same line it is also the label a
  // subject-less verb follows.
  let heading: Carry = "";
  let listed = false; // the heading already governs a bullet list
  for (const line of withoutQuotedText(answer).split(/\n+/)) {
    const bullet = BULLET.test(line);
    if (listed && !bullet) heading = ""; // the list under the heading ended
    const lineCarry = heading;
    listed = bullet;
    if (!bullet) heading = ""; // a plain line uses the heading up
    let label = "";
    let carry: Carry = "";
    for (const sentence of line.split(/(?<=[.!?:;])\s+/)) {
      let cased = unmark(sentence).trim();
      let s = cased.toLowerCase();
      if (cased.length !== s.length) cased = s; // lowercasing changed the length: no NAME check
      const after = label;
      const mode = strongest(lineCarry, carry);
      label = s.endsWith(":") ? s : "";
      carry = label ? carryOf(label) : "";
      if (mode === "quote" || !s || s.endsWith("?")) continue;
      // Under a past or attribution label only "I've …" is still the assistant's own claim.
      const full = mode === "full";
      if (full && !PRESENT_PERFECT.test(s)) continue;
      if (PERMISSION_CHECK.test(s) && !HARD_NEGATION.test(s)) {
        claims.push({ sentence: sentence.trim(), family: "permission_check", strict: true });
        continue;
      }
      if (SENTENCE_NOT_A_CLAIM.test(s)) continue;
      const reported = REPORTED.exec(s);
      if (reported) s = s.slice(0, reported.index);
      const passiveAllowed = !PASSIVE_NOT_A_CLAIM.test(s);
      const subjectless = passiveAllowed && !mode && !OLDER.test(s);
      const found = new Map<string, Omit<ActionClaim, "sentence">>();
      let at = 0;
      for (const clause of s.split(/,|\s[—–-]\s|\s+but\s+/)) {
        const start = s.indexOf(clause, at);
        at = start + clause.length;
        if (CLAUSE_NOT_A_CLAIM.test(clause)) continue;
        if (subjectless && ELLIPTICAL_SEND.test(clause)) found.set("send:true", { family: "send", strict: true });
        const verbFirst = subjectless && (!after || CHANNEL_LABEL.test(after)) ? VERB_FIRST.exec(clause) : null;
        const from = verbFirst ? start + verbFirst[0].length : -1;
        if (verbFirst && (OBJECT.test(s.slice(from, at)) || NAME.test(cased.slice(from, at)))) {
          const family = verbFirst[1] ? "send" : "delete";
          found.set(`${family}:true`, { family, strict: true });
        }
        for (const p of PATTERNS) {
          const first = p.firstPerson.test(clause) && (!full || PRESENT_PERFECT.test(clause));
          const strict = first ? p.strict : !full && passiveAllowed && p.passive.test(clause) ? false : null;
          if (strict !== null) found.set(`${p.family}:${strict}`, { family: p.family, strict });
        }
      }
      for (const c of found.values()) claims.push({ sentence: sentence.trim(), ...c });
    }
    if (label) {
      heading = carry; // the line ends on a label: it governs what follows
      listed = false;
    }
  }
  return claims;
}

// ── what the trace says ran ─────────────────────────────────────────

/** The loop's own control envelopes: the call never reached a tool. */
const GUARD_CODES = new Set(["UNKNOWN_TOOL", "TOOL_NOW_AVAILABLE", "REPEATED_CALL"]);
/** Blocked by the box's policy (deny tier, a remote server's policy) rather than the person's role. */
const POLICY_CODES = new Set([
  "TOOL_DENIED",
  "REMOTE_WRITE_NOT_PERMITTED",
  "REMOTE_TOOL_DENIED",
  "REMOTE_TOOL_NOT_CLASSIFIED",
  "REMOTE_WRITE_NO_INTERCEPTOR",
  "REMOTE_TOOL_EXCLUDED_FROM_V1",
]);
/**
 * Refused for lack of permission. The loop's role gate (tool-access.service),
 * a handler's 403, and the policy codes above.
 */
const FORBIDDEN_CODES = new Set([
  "FORBIDDEN",
  "FORBIDDEN_TOOL_FOR_ROLE",
  "LOCK_OPERATION_NOT_PERMITTED",
  ...POLICY_CODES,
]);
/** The write may have landed anyway (WARP-3284's malformed body says so too). */
const UNCLEAR_CODES = new Set(["TIMEOUT", "TOOL_OUTPUT_MALFORMED", "tool_dispatch_failed"]);

const SEND_TOOL = /(?:^|_)(?:send|message|notif\w*|share|forward|invite|post)(?:_|$)/;
const DELETE_TOOL = /(?:^|_)(?:delete|remove|forget|purge|trash|erase|wipe)(?:_|$)/;

/** A write tool's claim family: the verb in its name (snake_case or camelCase). */
export function writeFamilyOf(tool: string): ClaimFamily {
  const words = tool.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return SEND_TOOL.test(words) ? "send" : DELETE_TOOL.test(words) ? "delete" : "change";
}

/** The error code on a result: `{error:{code}}`, or the multiplexer's `{error:"CODE"}`. */
function codeOf(result: unknown): string | undefined {
  const e = (result as { error?: unknown } | null)?.error;
  const code = typeof e === "string" ? e : (e as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function outcomeOf(result: unknown, isError: boolean): WriteOutcome | "guard" {
  const r = result !== null && typeof result === "object" ? (result as { status?: unknown; error?: unknown }) : {};
  const code = codeOf(result);
  if (r.status === "confirmation_required") return "pending";
  if (code !== undefined && (typeof r.error === "string" || r.status === "error")) {
    if (GUARD_CODES.has(code)) return "guard";
    if (code === "CONFIRMATION_DENIED") return "declined";
    if (FORBIDDEN_CODES.has(code)) return "forbidden";
    if (UNCLEAR_CODES.has(code)) return "unclear";
    return "failed";
  }
  // A remote tool's plain-text failure arrives as {raw}: only isError says so.
  return r.status === "error" || isError ? "failed" : "executed";
}

/** Every write attempted, in order; reads and the loop's guard hits dropped. */
export function writeAttempts(
  trace: readonly AgentTraceEntry[],
  isWrite: (tool: string) => boolean,
): WriteAttempt[] {
  const out: WriteAttempt[] = [];
  for (const t of trace) {
    const outcome = outcomeOf(t.result, t.isError === true);
    if (!isWrite(t.tool) || outcome === "guard") continue;
    const code = codeOf(t.result);
    out.push({ tool: t.tool, family: writeFamilyOf(t.tool), outcome, ...(code ? { code } : {}) });
  }
  return out;
}

export interface ClaimCheck {
  /** Claims nothing that ran backs. */
  unbacked: ActionClaim[];
  /** Claims backed only by a write whose outcome is unclear (it may have run). */
  unconfirmed: ActionClaim[];
  /** Writes refused for permission that the answer never mentions (decision B). */
  unstatedDenials: WriteAttempt[];
  attempts: WriteAttempt[];
}

export interface ClaimCheckOptions {
  /** Which tools write: the loop's catalog + runtime classification. */
  isWrite: (tool: string) => boolean;
  /**
   * Tools the PREVIOUS turn of this conversation actually ran (ok, not a
   * pending approval). A send or delete claim of a family this turn did not
   * attempt stands on those ("Yes, I've sent it"); state changes never do.
   */
  priorRanTools?: readonly string[];
}

/** Which families a claim may stand on. */
function backs(c: ActionClaim, a: WriteAttempt): boolean {
  if (c.family !== "change") return a.family === c.family;
  // A state change is a change or a delete ("cancelled" the meeting via
  // delete_event), never a send; an edit claim, any write.
  return c.strict ? a.family !== "send" : true;
}

/**
 * Which attempts that did NOT run speak to a claim: the same as `backs`,
 * except that an edit claim (and every passive) looks at change writes only,
 * so a status read-out is never tied to, say, a pending send.
 */
function relevant(c: ActionClaim, a: WriteAttempt): boolean {
  if (c.family === "permission_check") return false;
  return c.family === "change" && !c.strict ? a.family === "change" : backs(c, a);
}

// Says so plainly: "you don't have permission", "not allowed", "your role" …
const MENTIONS_PERMISSION =
  /\b(?:permissions?|not allowed|isn't allowed|aren't allowed|not permitted|not authori[sz]ed|unauthori[sz]ed|(?:don't|do not|doesn't|does not) have (?:the )?(?:access|rights?)|no access|access (?:is |was )?denied|access role|your role|doesn't allow|does not allow)\b/;

export function checkActionClaims(
  answer: string,
  trace: readonly AgentTraceEntry[],
  opts: ClaimCheckOptions,
): ClaimCheck {
  const attempts = writeAttempts(trace, opts.isWrite);
  const earlier = new Set((opts.priorRanTools ?? []).filter(opts.isWrite).map(writeFamilyOf));
  const unbacked: ActionClaim[] = [];
  const unconfirmed: ActionClaim[] = [];
  for (const c of detectActionClaims(answer)) {
    if (c.family === "permission_check") {
      unbacked.push(c); // no tool can back it
      continue;
    }
    const family = c.family;
    if (attempts.some((a) => a.outcome === "executed" && backs(c, a))) continue;
    if (attempts.some((a) => a.outcome === "unclear" && backs(c, a))) {
      unconfirmed.push(c);
      continue;
    }
    if (attempts.some((a) => relevant(c, a))) {
      unbacked.push(c); // tried this turn, and it did not run
      continue;
    }
    if (c.strict && !(family !== "change" && earlier.has(family))) unbacked.push(c);
  }
  const denials = attempts.filter((a) => a.outcome === "forbidden");
  const unstatedDenials =
    denials.length > 0 && !MENTIONS_PERMISSION.test(normalize(answer)) ? denials : [];
  return { unbacked, unconfirmed, unstatedDenials, attempts };
}

/**
 * The writes behind the unbacked claims that did not run (pending, declined,
 * refused, failed): what the advisory SSE frame names. Empty when none of the
 * claimed families was attempted at all.
 */
export function notRunWrites(check: ClaimCheck): WriteAttempt[] {
  return check.attempts.filter(
    (a) =>
      a.outcome !== "executed" &&
      a.outcome !== "unclear" &&
      check.unbacked.some((c) => relevant(c, a)),
  );
}

// ── what the person and the model are told ──────────────────────────

const NOTHING_DONE: Record<ClaimFamily, string> = {
  send: "Nothing was sent.",
  delete: "Nothing was deleted.",
  change: "Nothing was changed.",
};

function reasonForModel(a: WriteAttempt): string {
  switch (a.outcome) {
    case "executed":
      return "done";
    case "pending":
      return "NOT done: it is waiting for the person's approval (they have an approval prompt)";
    case "declined":
      return "NOT done: the person declined it";
    case "forbidden":
      return POLICY_CODES.has(a.code ?? "")
        ? "NOT done: this Droplet blocks it"
        : "NOT done: the person does not have permission to do this";
    case "failed":
      return `NOT done: it failed (${a.code ?? "error"})`;
    case "unclear":
      return `unclear: the tool did not confirm (${a.code ?? "error"}), so it may or may not have run`;
  }
}

/**
 * The correction request: the facts of the turn, the sentences that
 * contradict them, and the ask. Sent as a `user` message (WARP-3285: gpt-oss
 * drops every system message after the first). Tool names, not labels: this
 * is for the model, which knows its tools by name.
 */
export function claimCorrectionPrompt(
  check: ClaimCheck,
  /** A durable run: nobody is watching, so the corrected answer asks nothing. */
  inRun = false,
): string {
  const facts =
    check.attempts.length > 0
      ? check.attempts.map((a) => `- ${a.tool}: ${reasonForModel(a)}.`)
      : [
          // Box eval: without the second half the model invented "waiting for
          // your approval" for an action that was never attempted. Scoped to
          // this turn: an earlier turn's write may really be waiting.
          "- No action ran in this turn: nothing was sent, created, changed or deleted, and nothing from this turn is waiting for approval.",
        ];
  const wrong = [...new Set(check.unbacked.map((c) => c.sentence))].map((sentence) =>
    check.unbacked.some((c) => c.sentence === sentence && c.family === "permission_check")
      ? `- "${sentence}" — no permission check ran; Droplet has no tool that checks permissions.`
      : `- "${sentence}" — this did not happen.`,
  );
  return [
    "Before your reply goes out, check it against what actually happened in this turn.",
    "What actually happened:",
    ...facts,
    "Your reply says things that did not happen:",
    ...wrong,
    "Rewrite your reply so it only says what actually happened. Say plainly what was not done and why" +
      (check.attempts.some((a) => a.outcome === "pending") ? " (for example, that it is waiting for my approval)" : "") +
      ". Keep everything else that was right, " +
      "including any answer or result you gave me. " +
      "Do not call any tools. " +
      (inRun ? "Nobody is watching this run, so do not ask any questions. " : "") +
      "Reply with the corrected answer only.",
  ].join("\n");
}

/** A tool's plain-language label ("Delete a file …"); undefined when it has none. */
export type ToolLabel = (tool: string) => string | undefined;

/** "Send an email you've approved" → "send an email", for "… to <act>". */
function act(label: string): string {
  const s = label.replace(/\s+(?:you(?:'|’)ve approved|you have approved|for you)$/i, "");
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * The fixed line appended when the correction could not be trusted. Built
 * from the trace alone, so it is true whatever the model wrote above it.
 */
export function claimStatusLine(check: ClaimCheck, label: ToolLabel): string {
  const lines = new Set<string>();
  for (const c of check.unbacked) {
    if (c.family === "permission_check") {
      lines.add("No permission check was run: Droplet checks permission when an action runs.");
      continue;
    }
    const family = c.family;
    const tried = check.attempts.filter((a) => relevant(c, a) && a.outcome !== "executed");
    if (tried.length === 0) lines.add(NOTHING_DONE[family]);
    for (const a of tried) lines.add(statusFor(a, label));
  }
  return [...lines].join(" ");
}

/**
 * A claim resting on an unclear outcome (a timeout, a thrown dispatch) gets a
 * fixed line and never a model call: the model cannot know either.
 */
export function unconfirmedLine(check: ClaimCheck, label: ToolLabel): string {
  if (check.unconfirmed.length === 0) return "";
  const what = [
    ...new Set(
      check.attempts
        .filter((a) => a.outcome === "unclear")
        .map((a) => label(a.tool))
        .filter((l): l is string => Boolean(l)),
    ),
  ];
  return what.length > 0
    ? `Droplet couldn't confirm this went through: ${what.join("; ")}.`
    : "Droplet couldn't confirm that went through.";
}

function statusFor(a: WriteAttempt, label: ToolLabel): string {
  const what = label(a.tool);
  switch (a.outcome) {
    case "pending":
      return what
        ? `Not done yet: waiting for your approval to ${act(what)}.`
        : "Not done yet: it's waiting for your approval.";
    case "declined":
      return what ? `Not done: you declined to ${act(what)}.` : "Not done: you declined it.";
    case "forbidden":
      return deniedLine(a, label);
    default:
      return what ? `Not done: Droplet couldn't ${act(what)}.` : "Not done: that step failed.";
  }
}

/** Decision B — the plain line for a write refused for lack of permission. */
export function deniedLine(a: WriteAttempt, label: ToolLabel): string {
  const what = label(a.tool);
  const doIt = what ? act(what) : "do that";
  return POLICY_CODES.has(a.code ?? "")
    ? `Not done: this Droplet doesn't allow you to ${doIt}.`
    : `Not done: you don't have permission to ${doIt}.`;
}
