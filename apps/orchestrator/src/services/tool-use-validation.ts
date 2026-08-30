/**
 * WARP-2544 — does the answer match what the tools actually did?
 *
 * `llm-agent.service.ts` guards the INPUT side of tool use thoroughly:
 * WARP-1529 denies unauthorised tools before dispatch, WARP-642 catches a
 * hallucinated tool NAME and feeds back the valid list, WARP-1480 logs every
 * `result.isError`, and a circuit breaker stops a model looping on guard hits.
 *
 * Nothing guarded the OUTPUT side. Once the model stopped emitting
 * `tool_calls` and produced terminal content, that text was returned verbatim.
 * `trace` — every `{tool, args, result}` for the turn — was recorded for
 * observability and never once compared against the answer. A grep of that
 * 2725-line file for `verif|ungrounded|fabricat|attest|consisten|groundedness`
 * returned zero hits.
 *
 * That admits two failures:
 *
 *   1. ACTION CLAIMED, NOTHING DISPATCHED. "I've turned the camera off" on a
 *      turn whose trace is empty. Nothing contradicts it.
 *   2. ACTION CLAIMED OVER A FAILED DISPATCH. The tool ran, returned
 *      `status:"error"`, and the model narrated success anyway. WARP-1480
 *      logs the error; the user still reads a success sentence.
 *
 * Both matter more here than on a cloud assistant because these tools are
 * PHYSICAL — cameras, locks, network rules, power. A false "done" about a
 * door or a firewall rule is a safety and trust failure, not a cosmetic one.
 *
 * ============================================================================
 * WHY THIS DETECTS AND REPORTS RATHER THAN SILENTLY RE-PROMPTING
 * ============================================================================
 * The obvious design is "catch the bad answer, re-prompt, return the corrected
 * one". It cannot work on the path that matters, and the reason is structural:
 *
 *   on the STREAMING path the answer has ALREADY been emitted as
 *   `content_delta` frames by the time terminal content exists.
 *
 * The user has read it. There is nothing to retract. A re-prompt would either
 * append a contradicting second answer or require a hold-back buffer that
 * defeats streaming — a much larger change, and one that trades away the
 * latency property this box needs most (see WARP-2543, where the same box was
 * serving at 8 tok/s).
 *
 * So this module is honest about what it can do: it makes the failure VISIBLE
 * and MEASURABLE, on both transports, at zero latency cost. A corrective
 * re-prompt is a follow-up that has to solve the hold-back question first.
 *
 * ============================================================================
 * DETERMINISTIC ON PURPOSE
 * ============================================================================
 * No LLM judge. A judge would run on the same local model this box already
 * struggles to serve, add an inference round-trip to every turn, and — being
 * the same model that just fabricated the claim — is poorly placed to catch it.
 * This is string and trace work: microseconds, no network, no tokens.
 *
 * ============================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * ============================================================================
 * It does not match a specific claim to a specific tool. "I turned off the
 * camera" is not checked against `camera_set_state` in particular. Verb->tool
 * affinity tables are exactly where a deterministic checker turns brittle:
 * every new tool needs a row, a missing row reads as a fabrication, and the
 * false positives train people to ignore the signal. The question answered
 * here is the coarse one that is nearly always the real failure:
 *
 *   the model claims it DID something — did ANY tool actually succeed?
 *
 * That catches both shipped failure modes and cannot be wrong about a turn
 * where real work happened.
 */

import type { AgentTraceEntry } from "./llm-agent.service.js";

/** How a single dispatch turned out, from its wire payload. */
export type ToolOutcome = "success" | "error" | "pending";

export type ToolUseStatus =
  /** No completion claim, or the claim is backed by a successful dispatch. */
  | "ok"
  /** A completion claim on a turn that dispatched NOTHING. */
  | "unsupported"
  /** A completion claim where every dispatch failed. */
  | "contradicted";

export interface ToolUseVerdict {
  status: ToolUseStatus;
  /**
   * The claim excerpts that triggered a non-ok verdict, capped at 160 chars.
   *
   * ⚠ NOT LOG-SAFE. An earlier comment here claimed these were "safe to log
   * (it is not corpus content)" and nothing established that: a claim is a raw
   * slice of the model's answer, which is generated over whatever the user
   * asked and whatever the tools returned — file contents, message bodies,
   * device and person names. They belong on the SSE frame, which goes to the
   * client already entitled to the answer. They must not reach the process log
   * (bare pino to stdout, no redact paths, collected into the diagnostics
   * bundle). `describeToolUseVerdict` emits `claimCount` for that reason.
   */
  claims: string[];
  /** Dispatch tallies, so a log line explains itself without the trace. */
  counts: { total: number; success: number; error: number; pending: number };
  /** Tool names dispatched this turn, for the log line. */
  tools: string[];
}

/**
 * Classify one trace entry's `result`.
 *
 * mcp-server does not serialize the ToolResult envelope (WARP-1604): a
 * success is the handler payload UNWRAPPED at the root, while a failure is
 * `{status, error}` at the root. So `status` is the only discriminant, and its
 * ABSENCE means success — a payload like `{path: "..."}` has no status field.
 *
 * `confirmation_required` is its own thing. The loop deliberately surfaces it
 * as `ok:true` so the dashboard renders an approval chip rather than a red
 * failure, and a turn awaiting approval is legitimately "not done yet" — not
 * a fabrication. Treated as `pending`, and a turn containing one is not
 * flagged at all (see `validateAnswerAgainstTrace`).
 */
export function classifyToolOutcome(result: unknown): ToolOutcome {
  if (result === null || typeof result !== "object") return "success";
  const status = (result as { status?: unknown }).status;
  if (status === "error") return "error";
  if (status === "confirmation_required") return "pending";
  return "success";
}

/**
 * Error codes the agent loop pushes into `trace` for calls that NEVER REACHED
 * a tool. They are shaped `{status:"error", …}` exactly like a real failure, so
 * counting them as dispatches is wrong twice over:
 *
 *   - a turn whose only entries are guard hits reports "EVERY dispatch failed"
 *     (contradicted) when in truth NOTHING was dispatched (unsupported) —
 *     collapsing the two categories this module says need different fixes;
 *   - the WARP-642 self-heal pushes TOOL_NOW_AVAILABLE and asks the model to
 *     retry, so a model that then gives up and answers gets reported as
 *     contradicting a failed dispatch that never happened.
 *
 * These are the loop's own control messages, not tool results.
 */
const NON_DISPATCH_ERROR_CODES = new Set([
  "TOOL_NOW_AVAILABLE", // WARP-642 §3 self-heal — "call it again"
  "UNKNOWN_TOOL",       // WARP-642 hallucinated-name guard
  "REPEATED_CALL",      // loop repetition breaker
  "FORBIDDEN_TOOL",     // WARP-1529 RBAC denial
]);

/** True when this trace entry is a loop guard rather than a real dispatch. */
export function isRealDispatch(entry: { result: unknown }): boolean {
  const r = entry.result;
  if (r === null || typeof r !== "object") return true;
  const err = (r as { error?: { code?: unknown } }).error;
  const code = err && typeof err === "object" ? err.code : undefined;
  return typeof code !== "string" || !NON_DISPATCH_ERROR_CODES.has(code);
}

/**
 * First-person COMPLETED-action claims.
 *
 * Tuned to be conservative. A false positive fires on a turn that did nothing
 * wrong, and a warning people learn to ignore is worse than no warning — so
 * where this is uncertain it stays silent.
 *
 * Requires all three of:
 *   - first person ("I", "I've", "I have", or a bare "Done")
 *   - COMPLETED aspect (past tense / present perfect), never future or
 *     conditional. "I'll turn it off" and "I can turn it off" are offers, not
 *     claims, and must never fire.
 *   - an action verb, not a speech verb. "I explained", "I think", "I would
 *     suggest" are not claims about the world.
 */
// 🔴 STATE-CHANGING VERBS ONLY. An earlier revision also listed retrieval
// verbs — checked, searched, found, retrieved, fetched, looked, scanned,
// queried, read, pulled, listed — and that made the guard fire on ordinary
// conversation. Running the shipped regexes over plain answers flagged all of:
//
//     "I've listed the main options below."
//     "I read your question as asking about the porch camera."
//     "I looked at it from a couple of angles."
//
// Those are the model writing English, not claiming a dispatch. And the
// exemption meant to protect them does not exist in practice: the comment at
// the call site asserted that a conversational turn runs with
// `tool_choice:"none"`, but the dashboard never sends `tool_choice` at all —
// it defaults to `"auto"` (llm-agent.service.ts), so tools ARE advertised on
// every chat turn. `"none"` is produced only by voice-io's greeting path and
// email-analysis. So on the surface that matters, every turn was claim-checked
// and ordinary sentences tripped it.
//
// Narrowing to state changes is the principled fix rather than a patch,
// because it matches why this guard exists at all: these tools are PHYSICAL.
// A false "I turned the camera off" or "I disabled that firewall rule" is a
// safety and trust failure. A false "I looked at your files" is a turn of
// phrase. Retrieval claims are also the ones a reader can verify for
// themselves from the answer's own content, which action claims are not.
//
// Precision over recall, deliberately: a warning that fires on healthy turns
// gets muted, and a muted guard protects nothing.
const ACTION_VERBS = [
  // physical / device state
  "turned", "switched", "enabled", "disabled", "activated", "deactivated",
  "started", "stopped", "restarted", "rebooted", "paused", "resumed",
  "locked", "unlocked", "armed", "disarmed",
  // persistent mutations
  "created", "deleted", "removed", "renamed", "installed", "uninstalled",
  "configured", "applied", "scheduled", "cancelled", "canceled",
  "sent", "connected", "disconnected", "reset",
  // Kept despite the narrowing: these read as mutations far more often than as
  // turns of phrase ("I updated the schedule" / "I saved the file"), and both
  // name changes a user cannot verify from the answer's own text. `added`,
  // `changed`, `moved`, `set` and `wrote` were NOT kept — each is common in
  // ordinary prose ("I've added a note below", "I set that aside") where the
  // guard would fire on a healthy turn.
  "updated", "saved",
].join("|");

/**
 * Negations and non-commitments that must SUPPRESS a match.
 *
 * Without this, "I haven't turned anything off" and "I was unable to disable
 * it" both read as completion claims — and those sentences are the model
 * behaving CORRECTLY about a failure, which would make the guard fire hardest
 * exactly when the model is being honest.
 */
const NEGATION =
  new RegExp(
    [
      // auxiliary negation
      String.raw`\b(?:haven'?t|hasn'?t|hadn'?t|didn'?t|don'?t|doesn'?t|won'?t|can'?t|cannot|couldn'?t|wasn'?t|weren'?t|isn'?t|aren'?t)\b`,
      String.raw`\b(?:unable|failed to|not able|was not|were not|not been|no longer|never|without)\b`,
      // SUBJECT negation — "Nothing was changed", "None of the rules were removed".
      // Found by this module's own test: the honest sentence
      //   "I couldn't turn off the camera. Nothing was changed."
      // split into two, and while the first was correctly suppressed, the
      // second matched the passive pattern on "was changed" and flagged the
      // turn. That is the worst possible false positive — the guard firing
      // hardest precisely when the model is reporting a failure truthfully.
      String.raw`\b(?:nothing|none|neither|no changes?|no action|nothing else)\b`,
      String.raw`\bunchanged\b`,
      // offers, questions, instructions to the user — not claims about the world
      String.raw`\b(?:would need|will need|need to|you can|you could|you should|if you|shall i|should i|do you want|would you like|let me know)\b`,
    ].join("|"),
    "i",
  );

const CLAIM_PATTERNS: RegExp[] = [
  // "I've turned off …", "I have disabled …", "I turned off …"
  new RegExp(String.raw`\bI(?:'ve| have)?\s+(?:just\s+|already\s+|now\s+)?(?:${ACTION_VERBS})\b`, "i"),
  // "Done — the camera is off." Requires an OBJECT after the word: a bare
  // "Done" / "Done." asserts nothing checkable, and matching it produced a
  // WARN on nine existing fixtures that use `content: "done"` as filler. A
  // guard that fires on every run of the agent suite is one people mute.
  /^\s*done\b[\s,:;—–-]+\S/i,
  // "The camera has been turned off", "… was disabled"
  new RegExp(String.raw`\b(?:has|have|had)\s+been\s+(?:${ACTION_VERBS})\b`, "i"),
  new RegExp(String.raw`\b(?:was|were)\s+(?:successfully\s+)?(?:${ACTION_VERBS})\b`, "i"),
  // "Successfully disabled …"
  new RegExp(String.raw`\bsuccessfully\s+(?:${ACTION_VERBS})\b`, "i"),
];

/**
 * Split into sentences and test each one, rather than testing the whole answer.
 *
 * Sentence scope is what makes the negation guard work. Across a whole answer,
 * "I couldn't reach the camera. I've left it as it was." contains both a
 * negation and a claim; whole-text matching would let the negation anywhere in
 * the paragraph suppress a real fabrication three sentences later, or (with
 * the test inverted) let a claim anywhere override an honest failure report.
 * Per sentence, each stands or falls on its own.
 */
export function detectCompletionClaims(text: string): string[] {
  if (!text) return [];
  const sentences = text
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const hits: string[] = [];
  for (const sentence of sentences) {
    if (NEGATION.test(sentence)) continue;
    if (CLAIM_PATTERNS.some((re) => re.test(sentence))) {
      // Cap the excerpt: these go into logs and an SSE frame.
      hits.push(sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence);
    }
  }
  return hits;
}

export interface ValidateInput {
  /** The sanitized, user-visible answer (post `sanitizeFinalContent`). */
  answer: string;
  /** Every dispatch this turn, in order. */
  trace: AgentTraceEntry[];
  /**
   * Whether this turn advertised any tools at all. A conversational turn runs
   * with `tool_choice:"none"` and zero tools; the model has no way to act and
   * "I've checked" in a greeting is chat, not a fabricated dispatch. Checking
   * those would fire constantly on turns that are working as designed.
   */
  toolsAdvertised: boolean;
}

export function validateAnswerAgainstTrace(input: ValidateInput): ToolUseVerdict {
  const { answer, trace, toolsAdvertised } = input;

  // Guard entries are not dispatches — see NON_DISPATCH_ERROR_CODES.
  const dispatched = trace.filter(isRealDispatch);
  const outcomes = dispatched.map((t) => classifyToolOutcome(t.result));
  const counts = {
    total: dispatched.length,
    success: outcomes.filter((o) => o === "success").length,
    error: outcomes.filter((o) => o === "error").length,
    pending: outcomes.filter((o) => o === "pending").length,
  };
  const tools = [...new Set(dispatched.map((t) => t.tool))];
  const ok = (): ToolUseVerdict => ({ status: "ok", claims: [], counts, tools });

  // A turn that could not act cannot have fabricated a dispatch.
  if (!toolsAdvertised) return ok();

  // Awaiting approval is a legitimate "not done yet" that the loop already
  // surfaces as an approval chip. Do not second-guess it.
  if (counts.pending > 0) return ok();

  // Something really succeeded — the coarse question is answered. We do not
  // try to prove the claim matches THAT tool; see the header note on why
  // verb->tool tables are a false-positive machine.
  if (counts.success > 0) return ok();

  const claims = detectCompletionClaims(answer);
  if (claims.length === 0) return ok();

  // A completion claim with no successful dispatch behind it.
  return {
    status: counts.total === 0 ? "unsupported" : "contradicted",
    claims,
    counts,
    tools,
  };
}

/** One-line, log-safe summary. Claim excerpts are the model's own words. */
export function describeToolUseVerdict(v: ToolUseVerdict): string {
  const what =
    v.status === "unsupported"
      ? "answer claims a completed action but NO tool was dispatched"
      : "answer claims a completed action but EVERY dispatch failed";
  // 🔴 SHAPE, NOT TEXT. `claims` are verbatim excerpts of the model's answer,
  // which is generated over whatever the user asked about and whatever the
  // tools returned — file contents, message bodies, camera/device names. The
  // process log is plain pino to stdout with no redact paths and is collected
  // into the diagnostics bundle, so putting answer prose there ships user
  // content off the box. An operator triaging "the model is fabricating
  // completions" needs the COUNT and the tools, not the sentences; the
  // sentences are already on the SSE stream for the client that is entitled to
  // them. Same posture as the confirmation-summary redaction.
  return (
    `${what} — tools=[${v.tools.join(",")}] ` +
    `dispatches=${v.counts.total} ok=${v.counts.success} err=${v.counts.error} ` +
    `pending=${v.counts.pending} claimCount=${v.claims.length}`
  );
}
