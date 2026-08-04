/**
 * WARP-1605 — per-step view of an assistant turn's reasoning trace.
 *
 * `ChatMessage.reasoning` is a single string (one `String?` DB column), but a
 * multi-iteration agent turn produces one thinking block PER iteration. The
 * orchestrator (WARP-1602) keeps those boundaries by flattening the list with
 * a sentinel instead of the plain `\n\n` it uses WITHIN a step — see
 * `apps/orchestrator/src/services/llm-agent.service.ts`'s exported
 * `REASONING_STEP_SEPARATOR` and `AgentResult.reasoningSteps`.
 *
 * The dashboard can't import from the orchestrator package, so the sentinel is
 * mirrored here. It is part of the persisted data shape, NOT a private
 * rendering detail: changing one side without the other silently degrades a
 * multi-step trace back into one undifferentiated blob (which is exactly the
 * pre-WARP-1605 behaviour, so it fails soft — never with a crash).
 *
 * Splitting is deliberately total:
 *   - a trace with no sentinel (every pre-WARP-1602 row, and every
 *     single-iteration turn today) yields exactly ONE step whose text is the
 *     original string byte-for-byte — the render is unchanged for them;
 *   - empty/whitespace fragments are dropped, so a trailing sentinel (a turn
 *     whose last iteration ended on a tool call with no further thinking)
 *     can't produce a blank step block.
 */

/**
 * Boundary between agent steps inside the flattened `reasoning` string.
 * MUST stay byte-identical to the orchestrator's `REASONING_STEP_SEPARATOR`.
 */
export const REASONING_STEP_SEPARATOR = "\n\n--- step ---\n\n";

/** Separator used WITHIN one step (matches the orchestrator's per-step join). */
export const REASONING_PART_SEPARATOR = "\n\n";

/**
 * Recover the per-step list from a flattened trace.
 *
 * Returns `[]` for null/undefined/blank input so callers can branch on
 * `steps.length` alone and never have to null-check the raw column.
 */
export function splitReasoningSteps(trace: string | null | undefined): string[] {
  if (!trace) return [];
  return trace
    .split(REASONING_STEP_SEPARATOR)
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
}

/**
 * Append one live `reasoning_step` SSE payload to a flattened trace.
 *
 * The wire is FINER-grained than the persisted list: one agent iteration can
 * emit several `reasoning_step` events (a provider-native block plus each
 * inline `<reasoning>` segment), and the orchestrator joins those with
 * `\n\n` into a single entry before flattening. `stepOpen` carries that
 * grouping across events — it stays true until a `tool_call` closes the
 * iteration — so the live string ends up byte-identical to the one the
 * server persists, and a reload renders exactly the same blocks.
 */
export function appendReasoningStep(
  trace: string | undefined,
  text: string,
  stepOpen: boolean,
): string {
  if (!trace) return text;
  return stepOpen
    ? `${trace}${REASONING_PART_SEPARATOR}${text}`
    : `${trace}${REASONING_STEP_SEPARATOR}${text}`;
}
