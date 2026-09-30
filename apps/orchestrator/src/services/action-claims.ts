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
 *   - quoted text, `>` quote lines, code blocks and reported speech ("she
 *     wrote …") are not the assistant's claims and are removed first;
 *   - a clause with a negation, an offer, a condition or approval wording is
 *     skipped; a sentence with a question mark, a time reference or a
 *     "below/above" pointer is skipped whole;
 *   - "sent", "deleted" and real-world state changes ("disabled", "locked",
 *     "scheduled") are STRICT: flagged when nothing of that family ran. The
 *     other change verbs ("created", "updated", "added", "drafted") also
 *     describe edits to the model's own text ("I've updated the draft:"), so
 *     they, and every passive, are flagged only when this turn attempted a
 *     write of that family and it did not run;
 *   - a claim is backed when a write of its family ran; a "change" claim by
 *     any write that ran, since "I moved it to the trash" describes a delete.
 *
 * Families come from write metadata, not a per-tool list: the caller says
 * which tools write (the loop's catalog + runtime classification), and a
 * write's family is the verb in its name (send / delete, else "change").
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
  | "forbidden" // refused for lack of permission (role, handler, deny tier)
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
  // "turned the camera off" — only with on/off somewhere after it.
  String.raw`(?:turned|switched)(?=.*\b(?:on|off)\b)`,
].join("|");
// Also used for edits to the model's own text ("I've updated the draft:").
// Left out entirely, each common in plain prose: set, started, stopped, ran,
// applied, completed, made, wrote, prepared, checked, listed.
const EDIT_VERBS = [
  "created", "added", "drafted", "saved", "stored", "recorded", "updated", "changed",
  "modified", "edited", "renamed", "moved", "closed", "reopened", "marked", "assigned",
  "reassigned", "removed", "installed", "configured", "restored", "archived", "uploaded",
  "copied", "filed", "set up",
].join("|");

const ADVERBS = String.raw`(?:(?:just|already|now|also|successfully|finally|gone ahead and)\s+)*`;
const firstPerson = (verbs: string) =>
  new RegExp(String.raw`(?:\bi(?:'ve| have| had)?\s+${ADVERBS}|^\s*successfully\s+)(?:${verbs})\b`);
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

/** Skips the CLAUSE: negated, hedged, conditional, or an offer. */
const CLAUSE_NOT_A_CLAIM = new RegExp(
  [
    String.raw`n't\b|\b(?:not|no|never|nothing|none|neither|nor|without|unable|cannot|failed|failure)\b`,
    // offers, modals, conditionals — "it would have been sent", "once you approve"
    String.raw`\b(?:will|would|could|should|might|may|must|shall|going to|about to|ready to|once|if|unless|until|when you|after you)\b`,
    String.raw`\b(?:let me know|would you like|do you want|want me to)\b`,
  ].join("|"),
);
/**
 * Skips the SENTENCE: the approval step (it qualifies the whole sentence:
 * "I've saved the fact, pending your approval" is honest), another time, a
 * pointer at the answer, reported speech.
 */
const SENTENCE_NOT_A_CLAIM = new RegExp(
  [
    String.raw`\b(?:pending|waiting|awaiting|await|approv\w*|confirm\w*)\b`,
    String.raw`\b(?:earlier|previously|before|yesterday|ago|since|last (?:time|week|month|year|night)|in the past|originally)\b`,
    String.raw`\b(?:below|above|in this (?:answer|reply|message|response))\b`,
    String.raw`\b(?:says|said|wrote|writes|replied|replies|states|stated|mentions|mentioned|according to)\b`,
  ].join("|"),
);
/** Extra skips for the passive voice, which also describes records read back. */
const PASSIVE_NOT_A_CLAIM =
  /\bby\b|\b(?:19|20)\d\d\b|\b(?:that|which|who)\s+(?:has|have)\s+been\b|\bon (?:mon|tue|wed|thu|fri|sat|sun)/;

const PERMISSION_CHECK = new RegExp(
  String.raw`\bi(?:'ve| have)?\s+${ADVERBS}(?:verified|checked|confirmed|made sure)\s+(?:that\s+)?you(?:'re| are)?\s+(?:can (?:delete|remove|send|edit|change|modify|create|write|update|move|rename|do (?:that|this|it))|are allowed|allowed|are permitted|permitted|are authori[sz]ed|authori[sz]ed|have (?:the )?(?:permission|rights?))\b`,
);
const HARD_NEGATION = new RegExp(String.raw`n't\b|\b(?:not|never|unable|cannot)\b`);

function normalize(s: string): string {
  return s
    .replace(/[‘’ʼ]/g, "'") // gpt-oss writes "I’ve"
    .replace(/[*`~]/g, "")
    .toLowerCase();
}

/** What the assistant did not say in its own voice: quotes, quote lines, code. */
function withoutQuotedText(answer: string): string {
  return answer
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/^[ \t]*>.*$/gm, " ")
    .replace(/“[^”]*”|"[^"\n]*"|‘[^’\n]*’/g, " ")
    // straight single quotes only as a pair around words, never an apostrophe
    .replace(/(^|[\s(:])'[^'\n]*'(?=[\s.,;:!?)]|$)/g, "$1 ");
}

/**
 * Completed-action claims in `answer`, one per sentence (the first family that
 * matches). Sentence scope keeps an honest "I couldn't send it." from
 * suppressing a false claim two sentences later; clause scope keeps "…; let
 * me know if you need anything else" from hiding the claim before it.
 */
export function detectActionClaims(answer: string): ActionClaim[] {
  const claims: ActionClaim[] = [];
  for (const sentence of withoutQuotedText(answer).split(/(?<=[.!?:;])\s+|\n+/)) {
    const s = normalize(sentence).trim();
    if (!s || s.endsWith("?")) continue;
    if (PERMISSION_CHECK.test(s) && !HARD_NEGATION.test(s)) {
      claims.push({ sentence: sentence.trim(), family: "permission_check", strict: true });
      continue;
    }
    if (SENTENCE_NOT_A_CLAIM.test(s)) continue;
    const passiveAllowed = !PASSIVE_NOT_A_CLAIM.test(s);
    const claim = s
      .split(/,|\s[—–-]\s|\s+but\s+/)
      .filter((clause) => !CLAUSE_NOT_A_CLAIM.test(clause))
      .flatMap((clause) =>
        PATTERNS.flatMap((p) =>
          p.firstPerson.test(clause)
            ? [{ family: p.family, strict: p.strict }]
            : passiveAllowed && p.passive.test(clause)
              ? [{ family: p.family, strict: false }]
              : [],
        ),
      )[0];
    if (claim) claims.push({ sentence: sentence.trim(), ...claim });
  }
  return claims;
}

// ── what the trace says ran ─────────────────────────────────────────

/** The loop's own control envelopes: the call never reached a tool. */
const GUARD_CODES = new Set(["UNKNOWN_TOOL", "TOOL_NOW_AVAILABLE", "REPEATED_CALL"]);
/**
 * Refused for lack of permission. The loop's role gate (tool-access.service),
 * a handler's 403, the interceptor's deny tier, and a remote server's policy.
 */
const FORBIDDEN_CODES = new Set([
  "FORBIDDEN",
  "FORBIDDEN_TOOL_FOR_ROLE",
  "LOCK_OPERATION_NOT_PERMITTED",
  "TOOL_DENIED",
  "REMOTE_WRITE_NOT_PERMITTED",
  "REMOTE_TOOL_DENIED",
]);
/** Blocked by the box's policy rather than by the person's role. */
const POLICY_CODES = new Set(["TOOL_DENIED", "REMOTE_WRITE_NOT_PERMITTED", "REMOTE_TOOL_DENIED"]);
/** The write may have landed anyway (WARP-3284's malformed body says so too). */
const UNCLEAR_CODES = new Set(["TIMEOUT", "TOOL_OUTPUT_MALFORMED"]);

const SEND_TOOL = /(?:^|_)(?:send|message|notif\w*|share|forward|invite|post)(?:_|$)/;
const DELETE_TOOL = /(?:^|_)(?:delete|remove|forget|purge|trash|erase|wipe)(?:_|$)/;

/** A write tool's claim family: the verb in its name. */
export function writeFamilyOf(tool: string): ClaimFamily {
  return SEND_TOOL.test(tool) ? "send" : DELETE_TOOL.test(tool) ? "delete" : "change";
}

function outcomeOf(result: unknown): WriteOutcome | "guard" {
  if (result === null || typeof result !== "object") return "executed";
  const r = result as { status?: unknown; error?: unknown };
  // ORCH-05: a thrown dispatch carries a string `error` — the call may have run.
  if (typeof r.error === "string") return "unclear";
  if (r.status === "confirmation_required") return "pending";
  if (r.status !== "error") return "executed";
  const code = (r.error as { code?: unknown } | undefined)?.code;
  if (typeof code !== "string") return "failed";
  if (GUARD_CODES.has(code)) return "guard";
  if (code === "CONFIRMATION_DENIED") return "declined";
  if (FORBIDDEN_CODES.has(code)) return "forbidden";
  if (UNCLEAR_CODES.has(code)) return "unclear";
  return "failed";
}

/** Every write attempted, in order; reads and the loop's guard hits dropped. */
export function writeAttempts(
  trace: readonly AgentTraceEntry[],
  isWrite: (tool: string) => boolean,
): WriteAttempt[] {
  const out: WriteAttempt[] = [];
  for (const t of trace) {
    const outcome = outcomeOf(t.result);
    if (!isWrite(t.tool) || outcome === "guard") continue;
    const code = (t.result as { error?: { code?: unknown } } | null)?.error?.code;
    out.push({
      tool: t.tool,
      family: writeFamilyOf(t.tool),
      outcome,
      ...(typeof code === "string" ? { code } : {}),
    });
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
   * Tools an earlier turn of this conversation actually ran (ok, not a pending
   * approval). A strict claim of a family this turn did not attempt gets the
   * benefit of the doubt for those: "Yes, I've sent it" in the next turn.
   */
  priorRanTools?: readonly string[];
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
  const covers = (claim: ClaimFamily, a: WriteAttempt) => claim === "change" || a.family === claim;
  const earlier = new Set((opts.priorRanTools ?? []).filter(opts.isWrite).map(writeFamilyOf));
  const unbacked: ActionClaim[] = [];
  const unconfirmed: ActionClaim[] = [];
  for (const c of detectActionClaims(answer)) {
    if (c.family === "permission_check") {
      unbacked.push(c); // no tool can back it
      continue;
    }
    const family = c.family;
    if (attempts.some((a) => a.outcome === "executed" && covers(family, a))) continue;
    if (attempts.some((a) => a.outcome === "unclear" && covers(family, a))) {
      unconfirmed.push(c);
      continue;
    }
    if (attempts.some((a) => a.family === family)) {
      unbacked.push(c); // tried this turn, and it did not run
      continue;
    }
    const ranEarlier = earlier.has(family) || (family === "change" && earlier.size > 0);
    if (c.strict && !ranEarlier) unbacked.push(c);
  }
  const denials = attempts.filter((a) => a.outcome === "forbidden");
  const unstatedDenials =
    denials.length > 0 && !MENTIONS_PERMISSION.test(normalize(answer)) ? denials : [];
  return { unbacked, unconfirmed, unstatedDenials, attempts };
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
      : ["- No action ran in this turn: nothing was sent, created, changed or deleted."];
  const wrong = check.unbacked.map((c) =>
    c.family === "permission_check"
      ? `- "${c.sentence}" — no permission check ran; Droplet has no tool that checks permissions.`
      : `- "${c.sentence}" — this did not happen.`,
  );
  return [
    "Before your reply goes out, check it against what actually happened in this turn.",
    "What actually happened:",
    ...facts,
    "Your reply says things that did not happen:",
    ...wrong,
    "Rewrite your reply so it only says what actually happened. Say plainly what was not done and why " +
      "(for example, that it is waiting for my approval). Keep everything else that was right. " +
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
    const tried = check.attempts.filter((a) => a.family === family && a.outcome !== "executed");
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
    case "unclear":
      return what
        ? `Droplet couldn't confirm this went through: ${what}.`
        : "Droplet couldn't confirm that went through.";
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
