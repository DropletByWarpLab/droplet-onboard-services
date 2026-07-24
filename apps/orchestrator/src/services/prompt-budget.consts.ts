/**
 * WARP-1118 (§10) — the single source of truth for the system-prompt
 * char budgets and the context-window reserve.
 *
 * Static per-block char caps are necessary but NOT sufficient to prevent
 * a context-window overflow: chars ≠ tokens, and the serialized `tools[]`
 * schemas / pins / attachments / history live in no block. So these caps
 * are paired with the runtime request-size estimator + degradation trigger
 * (`context-budget.service.ts`), which sizes the WHOLE assembled request.
 *
 * Composition order + degradation rank (§10 budget table):
 *   identity (4000, never dropped)
 *   → persona (1200, dropped 2nd)
 *   → business (1500, dropped 1st — Phase 2)
 *   → tool guidance (never dropped)
 *   → memory facts (2000, trimmed by its own budget, not dropped)
 *   → interview conductor (900, interview sessions only, never dropped there)
 *
 * PRODUCTION WINDOW NOTE: the bundled single-box Ollama runs with
 * `OLLAMA_CONTEXT_LENGTH=16384` (docker-compose.yml, the WARP-854 fix — the
 * owner-role tool schemas alone overflow Ollama's own 4096 default). The
 * orchestrator reads that same value (config.OLLAMA_CONTEXT_LENGTH) and the
 * estimator budgets the request against `window − OUTPUT_RESERVE`. At 16384
 * nothing normally drops — degradation is defense-in-depth.
 */

/** Persona style block ceiling. The composed block is truncated to this in
 *  persona.service.ts (and the customInstructions field carries its own
 *  1200-char DB/zod cap). Dropped 2nd under overflow. */
export const PERSONA_PROMPT_MAX_CHARS = 1200;

/** Role-filtered business-context block ceiling (Phase 2). Declared now so
 *  the worst-case budget invariant is complete from Phase 0. Dropped 1st. */
export const BUSINESS_CONTEXT_MAX_CHARS = 1500;

/** Interview-conductor block ceiling (Phase 3). Interview sessions only;
 *  never dropped there. Declared now for the same reason. */
export const INTERVIEW_PROMPT_MAX_CHARS = 900;

/** 2026-07-23 business-identity rollout — ceiling for the full-set render of
 *  composeToolGuidance (tool-guidance.service.ts). Guidance is folded into
 *  the NEVER-DROPPED identity part of the WARP-1118 estimate, so every char
 *  is permanent context cost on every turn; the composer's own test asserts
 *  the real render stays under this. */
export const TOOL_GUIDANCE_MAX_CHARS = 2200;

/**
 * CI-tested ceiling on the worst-case sum of every FIXED system-prompt
 * block (identity + persona + business + memory facts + interview). Not a
 * runtime gate — the estimator is — but a canary so a future block-copy or
 * budget edit that would blow the sum fails in CI. The nominal worst case
 * is 4000 + 1200 + 1500 + 2000 + 900 = 9600, leaving 400 chars of slack.
 */
export const BASE_PROMPT_MAX_CHARS = 10000;

/**
 * Tokens held back from the configured context window for the model's
 * OUTPUT (§10). The request must fit under `configuredWindow − OUTPUT_RESERVE`.
 * A constant, deliberately not env-configurable.
 */
export const OUTPUT_RESERVE = 1024;

/**
 * Agent-loop iteration guard (2026-07-21 agent-budgets spec §2): minimum
 * estimated-token headroom under `window − OUTPUT_RESERVE` required to start
 * another tool-calling iteration. Below it the loop stops dispatching tools
 * and runs one finalization pass (stop_reason "context_budget") instead of
 * pushing the request into history-trim territory. Sized so one more
 * 8000-char tool result (~2000 tokens at 4 chars/token) can't fit anyway;
 * 1536 keeps usable iterations while never over-filling. Revisit with the
 * spec §6 measurement data.
 */
export const ITERATION_MIN_HEADROOM = 1536;
