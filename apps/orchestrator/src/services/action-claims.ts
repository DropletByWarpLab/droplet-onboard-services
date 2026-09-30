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
 * This module is the deterministic half: find completed-action claims in the
 * answer, and compare them with what the turn's trace says actually ran. The
 * loop (`llm-agent.service.ts`) owns what happens on a mismatch: one no-tools
 * correction call, then a fixed status line if that fails too.
 *
 * PRECISION OVER RECALL. A false positive rewrites a correct answer and costs
 * an inference call, so every rule below errs toward "not a claim":
 *   - past or perfect tense only, first person ("I've sent", "I deleted") or a
 *     perfect passive ("has been created"); never future, modal or conditional;
 *   - a sentence with any negation, offer, approval wording, question mark,
 *     time reference or "below/above" pointer is skipped whole;
 *   - a passive sentence only counts when this turn attempted a write of that
 *     family (else it is a status read-out: "SUP-101 has been closed");
 *   - a claim is "backed" when a write of its family ran, or ran with an
 *     unclear outcome (a timeout, a thrown dispatch), or was used earlier in
 *     the conversation and not attempted again this turn.
 *
 * Families come from the catalog's write metadata, not a per-tool list: a tool
 * is a write when tools-core says `requiresWrite` (or it is not in the catalog
 * at all — a remote MCP tool, whose effect is unknown), and its family is the
 * verb in its name (send / delete, else "change"). A "change" claim ("created",
 * "updated", "scheduled", "removed" …) is backed by ANY write that ran, since
 * "I moved it to the trash" or "I added a note" legitimately describe writes
 * of other families; only "sent" and "deleted" must match their own family.
 */
import { TOOLS } from "@droplet/tools-core";

import type { AgentTraceEntry } from "../types/agent-trace.js";
import { WRITE_TOOLS } from "./tool-access.service.js";

export type ClaimFamily = "send" | "delete" | "change";

export interface ActionClaim {
  /** The sentence as the model wrote it. Model prose: never log it. */
  sentence: string;
  /** `permission_check` = "I've verified that you can …" (no tool checks that). */
  family: ClaimFamily | "permission_check";
  /** A perfect passive ("has been created") rather than first person. */
  passive: boolean;
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
// State changes a person cannot verify from the answer's own text. Left out on
// purpose, each common in plain prose: set, started, stopped, ran, applied,
// completed, made, wrote, prepared, checked.
const CHANGE_VERBS = [
  "created", "added", "drafted", "saved", "stored", "recorded", "updated", "changed",
  "modified", "edited", "renamed", "moved", "closed", "reopened", "marked", "assigned",
  "reassigned", "scheduled", "rescheduled", "booked", "cancell?ed", "canceled", "removed",
  "blocked", "unblocked", "enabled", "disabled", "locked", "unlocked", "restarted",
  "rebooted", "installed", "configured", "restored", "archived", "uploaded",
  "copied", "filed", "set up",
  // "turned the camera off" — only with on/off somewhere after it.
  String.raw`(?:turned|switched)(?=.*\b(?:on|off)\b)`,
].join("|");

const FAMILY_VERBS: [ClaimFamily, string][] = [
  ["send", SEND_VERBS],
  ["delete", DELETE_VERBS],
  ["change", CHANGE_VERBS],
];

const ADVERBS = String.raw`(?:(?:just|already|now|also|successfully|finally|gone ahead and)\s+)*`;
const firstPerson = (verbs: string) =>
  new RegExp(String.raw`(?:\bi(?:'ve| have| had)?\s+${ADVERBS}|^\s*successfully\s+)(?:${verbs})\b`);
const perfectPassive = (verbs: string) =>
  new RegExp(String.raw`\b(?:has|have)\s+${ADVERBS}been\s+${ADVERBS}(?:${verbs})\b|\b(?:was|were)\s+successfully\s+(?:${verbs})\b`);

const PATTERNS = FAMILY_VERBS.map(([family, verbs]) => ({
  family,
  firstPerson: firstPerson(verbs),
  passive: perfectPassive(verbs),
}));

/** Not a claim about this turn: negated, hedged, pending, or elsewhere in time. */
const NOT_A_CLAIM = new RegExp(
  [
    String.raw`n't\b|\b(?:not|no|never|nothing|none|neither|nor|without|unable|cannot|failed|failure)\b`,
    // offers, modals, conditionals — "it would have been sent", "once you approve"
    String.raw`\b(?:will|would|could|should|might|may|must|shall|going to|about to|ready to|once|if|unless|until|when you|after you)\b`,
    // the approval step itself — "I've sent you an approval request"
    String.raw`\b(?:pending|waiting|awaiting|await|approv\w*|confirm\w*|let me know|would you like|do you want|want me to)\b`,
    // another time: "I created it earlier", "was renamed last week"
    String.raw`\b(?:earlier|previously|before|yesterday|ago|since|last (?:time|week|month|year|night)|in the past|originally)\b`,
    // prose about the answer itself — "I've added a summary below"
    String.raw`\b(?:below|above|in this (?:answer|reply|message|response))\b`,
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

/**
 * Completed-action claims in `answer`, one per sentence (the first family that
 * matches). Sentence scope keeps an honest "I couldn't send it." from
 * suppressing a false claim two sentences later, and vice versa.
 */
export function detectActionClaims(answer: string): ActionClaim[] {
  const claims: ActionClaim[] = [];
  for (const sentence of answer.split(/(?<=[.!?:;])\s+|\n+/)) {
    const s = normalize(sentence).trim();
    if (!s || s.endsWith("?")) continue;
    if (PERMISSION_CHECK.test(s) && !HARD_NEGATION.test(s)) {
      claims.push({ sentence: sentence.trim(), family: "permission_check", passive: false });
      continue;
    }
    if (NOT_A_CLAIM.test(s)) continue;
    for (const p of PATTERNS) {
      const passive = !p.firstPerson.test(s) && p.passive.test(s) && !PASSIVE_NOT_A_CLAIM.test(s);
      if (p.firstPerson.test(s) || passive) {
        claims.push({ sentence: sentence.trim(), family: p.family, passive });
        break;
      }
    }
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

/** A write's claim family, or null for a read. Unknown (remote) tools may write. */
export function writeFamilyOf(tool: string): ClaimFamily | null {
  if (TOOLS.has(tool) && !WRITE_TOOLS.has(tool)) return null;
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

/** Every write this turn attempted, in order; guard hits and reads dropped. */
export function writeAttempts(trace: readonly AgentTraceEntry[]): WriteAttempt[] {
  const out: WriteAttempt[] = [];
  for (const t of trace) {
    const family = writeFamilyOf(t.tool);
    const outcome = outcomeOf(t.result);
    if (family === null || outcome === "guard") continue;
    const code = (t.result as { error?: { code?: unknown } } | null)?.error?.code;
    out.push({ tool: t.tool, family, outcome, ...(typeof code === "string" ? { code } : {}) });
  }
  return out;
}

export interface ClaimCheck {
  /** Claims no write this turn backs. */
  unbacked: ActionClaim[];
  /** Writes refused for permission that the answer never mentions (decision B). */
  unstatedDenials: WriteAttempt[];
  attempts: WriteAttempt[];
}

// "You don't have permission", "your role", "ask your admin", "blocked" …
const MENTIONS_PERMISSION =
  /\b(?:permission|permissions|not allowed|isn't allowed|aren't allowed|not permitted|access role|your role|admin\w*|forbidden|not authori[sz]ed|blocked|blocks|denied|refused|doesn't allow|does not allow)\b/;

export function checkActionClaims(
  answer: string,
  trace: readonly AgentTraceEntry[],
  /** Tools earlier turns of this conversation used (`prior_tool_names`). */
  priorToolNames: readonly string[] = [],
): ClaimCheck {
  const attempts = writeAttempts(trace);
  const ran = attempts.filter((a) => a.outcome === "executed" || a.outcome === "unclear");
  const earlier = new Set(priorToolNames.map(writeFamilyOf).filter((f): f is ClaimFamily => f !== null));
  const unbacked = detectActionClaims(answer).filter((c) => {
    if (c.family === "permission_check") return true; // no tool can back it
    const family = c.family;
    const tried = attempts.filter((a) => family === "change" || a.family === family);
    if (ran.some((a) => family === "change" || a.family === family)) return false;
    // Not attempted this turn: a passive is a read-out, and a claim about a
    // write an earlier turn made may be true — give it the benefit.
    if (tried.length === 0 && (c.passive || earlier.has(family) || (family === "change" && earlier.size > 0))) {
      return false;
    }
    return true;
  });
  const denials = attempts.filter((a) => a.outcome === "forbidden");
  const unstatedDenials =
    denials.length > 0 && !MENTIONS_PERMISSION.test(normalize(answer)) ? denials : [];
  return { unbacked, unstatedDenials, attempts };
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
export function claimCorrectionPrompt(check: ClaimCheck): string {
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
      "Do not call any tools. Reply with the corrected answer only.",
  ].join("\n");
}

/** A tool's plain-language catalog label ("Delete a file …"); undefined when it has none. */
export type ToolLabel = (tool: string) => string | undefined;

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
    // What was tried in this family and did not run. ("unclear" backs a claim,
    // so it never reaches here.)
    const tried = check.attempts.filter(
      (a) => a.outcome !== "executed" && a.outcome !== "unclear" && (family === "change" || a.family === family),
    );
    if (tried.length === 0) lines.add(NOTHING_DONE[family]);
    for (const a of tried) lines.add(statusFor(a, label));
  }
  return [...lines].join(" ");
}

function statusFor(a: WriteAttempt, label: ToolLabel): string {
  const what = label(a.tool);
  switch (a.outcome) {
    case "pending":
      return what ? `Not done yet, waiting for your approval: ${what}.` : "Not done yet: it is waiting for your approval.";
    case "declined":
      return what ? `Not done, you declined it: ${what}.` : "Not done: you declined it.";
    case "forbidden":
      return deniedLine(a, label);
    default:
      return what ? `Not done, this step failed: ${what}.` : "Not done: that step failed.";
  }
}

/** Decision B — the plain line for a write refused for lack of permission. */
export function deniedLine(a: WriteAttempt, label: ToolLabel): string {
  const what = label(a.tool);
  const act = what ? what.charAt(0).toLowerCase() + what.slice(1) : "do that";
  return POLICY_CODES.has(a.code ?? "")
    ? `Not done: this Droplet doesn't allow you to ${act}.`
    : `Not done: you don't have permission to ${act}.`;
}
