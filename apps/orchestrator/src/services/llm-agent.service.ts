/**
 * LLM agent loop — live, MCP-backed.
 *
 * Drives a ReAct-style loop:
 *   user → ai-gateway w/ tools[] → tool_calls? → MCP tools/call → loop
 *
 * The advertised `tools[]` is built once per process from the MCP server's
 * `tools/list` (cached inside `McpClientService`). The ai-gateway is a
 * pure model proxy here — it must NOT execute tools (the orchestrator owns
 * dispatch). Tool results land back in the conversation as role="tool"
 * messages keyed by `tool_call_id`.
 *
 * Emits structured SSE events (spec §8.2) to a caller-supplied `onEvent`
 * so `/api/llm/chat` can stream tool-call chips and content deltas to
 * the dashboard. Non-streaming callers receive the same `AgentResult`
 * shape this file exposed before the rewire (assistant message + trace),
 * so legacy consumers don't break.
 *
 * Iteration cap: config.agentMaxIter (env AGENT_MAX_ITER_DEFAULT / CAP,
 * ships 10 / 10 — config.ts, raised from 5 by the 2026-07-21 tuning sweep)
 * — a confused or prompt-injected model can't burn unbounded tokens.
 *
 * WARP-1602 — channel discipline. The model's ANALYSIS (chain-of-thought)
 * must never reach the user or `ChatMessage.content`: per OpenAI's harmony
 * spec analysis text "has not been trained to the same safety standards"
 * and must not be shown. On a multi-iteration turn the intermediate
 * iterations are, by construction, analysis — so their `content` is
 * quarantined into the reasoning stream (`reasoning_step` +
 * `message.reasoning`), and only the TERMINAL iteration's content is ever
 * emitted as `content_delta` or persisted as the answer. Both transports
 * (blocking `chat()` and streaming `chatStream()`) now agree on this.
 */

import type { PrivateEnhancement } from "@droplet/tools-core";

import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import type {
  McpCallContext,
  McpClientService,
  ToolCallResult as McpToolCallResult,
} from "./mcp-client.service.js";
import {
  parseToolResultPayload,
  toolResultPayloadValue,
  type ToolResultPayload,
} from "./tool-result-payload.js";
import {
  describeToolError,
  newAgentTurnId,
} from "./tool-error-diagnostics.js";
import { EXCLUDED_FROM_CHAT_TOOLS } from "./chat-tool-scope.js";
import {
  toolAllowedInScope,
  toolDispatchDenial,
  type ToolAccessScope,
} from "./tool-access.service.js";
import {
  selectAdvertisedTools,
  domainOfTool,
  toolNamesForDomain,
} from "./tool-selection.service.js";
import {
  ITERATION_MIN_HEADROOM,
  OUTPUT_RESERVE,
} from "./prompt-budget.consts.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  estimateTokensFromChars,
} from "./context-budget.service.js";
import type { ChatMessage, ChatResponse, ChatStreamChunk, ToolCall } from "../types/index.js";
import type { SSEEvent } from "../types/sse-events.js";
import type { QueryClass } from "../types/query-enhancement.js";

const logger = createLogger("llm-agent");

/**
 * WARP-437 — pluggable enhancement deps. The agent loop calls these to
 * classify + pre-compute the HyDE / multi-query vectors BEFORE dispatching
 * `search_content`. All four are required when `AgentDeps.enhancement` is
 * present; pass `undefined` for `AgentDeps.enhancement` to disable
 * adaptive routing entirely (back-compat default).
 */
export interface EnhancementDeps {
  classify(query: string): Promise<{ cls: QueryClass; confidence: number }>;
  hyde(query: string): Promise<string>;
  multiQuery(query: string, n: number): Promise<string[]>;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * WARP-473 — fire-and-forget file-citation enqueue. The agent loop
 * calls `enqueue` after every tool dispatch whose parsed result
 * references one or more file paths. The implementation MUST NOT
 * await; the loop never blocks on citation persistence.
 *
 * Pass `undefined` for `AgentDeps.citation` to disable (back-compat
 * default — existing tests pass nothing and observe no behavior
 * change).
 */
export interface CitationDeps {
  /**
   * Record citations for `filePaths` against the given chat context.
   * Implementation runs the actual insert via `setImmediate` so a
   * slow DB doesn't propagate into the agent loop's latency.
   */
  enqueue(
    filePaths: string[],
    context: { userId: string; threadId: string; messageId: string },
  ): void;
}

export interface AgentDeps {
  mcp: McpClientService;
  aiGateway: {
    chat: (
      req: {
        model: string;
        messages: ChatMessage[];
        stream?: boolean;
        temperature?: number;
        max_tokens?: number;
        // WARP-1442 — gpt-oss reasoning-effort, forwarded verbatim to the
        // gateway (which only applies it for the gpt-oss family). Unset →
        // omitted, so the outbound request is byte-for-byte unchanged.
        reasoning_effort?: "low" | "medium" | "high";
        tools?: {
          type: "function";
          function: { name: string; description: string; parameters: Record<string, unknown> };
        }[];
        tool_choice?: "auto" | "none";
      },
      // WARP-329 — client-disconnect AbortSignal. The agent loop passes
      // `req.signal` so an in-flight inference fetch is cancelled when the
      // client goes away mid-turn.
      signal?: AbortSignal,
    ) => Promise<{ ok: boolean; status?: number; json: () => Promise<ChatResponse> }>;
    /**
     * WARP-1442 — optional SERVER-SIDE token streaming. When present AND the
     * caller supplied `onEvent` (i.e. `/api/llm/chat` with `stream=true`), the
     * agent loop consumes this token stream instead of the blocking `chat()`
     * and emits `content_delta` events INCREMENTALLY as the model generates,
     * rather than one delta after the full decode. The yielded chunks are the
     * ai-gateway's OpenAI-compat SSE (`ChatStreamChunk`), the SAME request body
     * `chat()` takes (with `stream:true`). Absent → the loop uses `chat()`
     * byte-for-byte, so every existing (blocking) caller is unchanged. A THROW
     * from this stream (transport error) is caught and the loop falls back to
     * `chat()` — streaming is additive, never a new failure mode.
     */
    chatStream?: (
      req: {
        model: string;
        messages: ChatMessage[];
        temperature?: number;
        max_tokens?: number;
        reasoning_effort?: "low" | "medium" | "high";
        tools?: {
          type: "function";
          function: { name: string; description: string; parameters: Record<string, unknown> };
        }[];
        tool_choice?: "auto" | "none";
      },
      signal?: AbortSignal,
    ) => AsyncIterable<ChatStreamChunk>;
  };
  /**
   * WARP-437 — when present, the agent loop classifies every
   * `search_content` query and pre-computes HyDE + multi-query embeddings
   * based on the resulting class preset. When absent (the default), the
   * loop dispatches `search_content` unchanged — no enhancement,
   * byte-for-byte the pre-WARP-437 behaviour. Enhancement failures NEVER
   * propagate; the loop falls through to the baseline tool call.
   */
  enhancement?: EnhancementDeps;
  /**
   * WARP-473 — file-citation enqueue. When present, the agent loop
   * extracts file paths from every parsed tool result and hands them
   * off to `citation.enqueue` fire-and-forget. When absent, no
   * citations are recorded — same byte-for-byte behavior as before.
   */
  citation?: CitationDeps;
  onEvent?: (e: SSEEvent) => void;
}

export interface AdaptivePreset {
  enhance?: { hyde?: boolean; multiQuery?: boolean; n?: number };
  searchOverrides?: {
    minSimilarity?: number;
    perArmK?: number;
    rerankCandidates?: number;
  };
  filenameContains?: string;
}

/**
 * Token-shape heuristic for the `navigational` class. We're not trying to
 * find every conceivable filename — only the obvious "open camera-1
 * settings" / "show me invoice-2024.pdf" cases. Prefer tokens that have
 * filename-y shape (a digit or a `-`/`_`/`.`) so "open" / "show" /
 * "settings" don't beat "camera-1" to first match. Downstream
 * `metadataFilter` applies the chosen token as a soft `ILIKE %x%` and
 * the lexical arm still runs unfiltered, so misclassification can't
 * tank recall.
 */
function extractFilenameToken(query: string): string | undefined {
  const tokens = query.match(/\b[a-zA-Z0-9][a-zA-Z0-9_\-.]{2,}\b/g);
  if (!tokens || tokens.length === 0) return undefined;
  const filenameShaped = tokens.find((t) => /[0-9\-_.]/.test(t));
  return (filenameShaped ?? tokens[0])?.toLowerCase();
}

/**
 * WARP-437 — map a classified query class to an adaptive search preset.
 *
 *   - factual:        narrow + deep rerank (rerankCandidates=100).
 *   - analytical:     fan out via multi-query (n=3), moderate rerank.
 *   - conversational: be permissive (low minSimilarity, larger per-arm K)
 *                     since conversational queries rarely lexical-overlap
 *                     with their target chunk.
 *   - navigational:   apply a soft filename filter when the query carries
 *                     a filename-shaped token; otherwise no overrides.
 *   - unknown:        no overrides (baseline).
 */
export function presetForClass(cls: QueryClass, query?: string): AdaptivePreset {
  switch (cls) {
    case "factual":
      return { searchOverrides: { rerankCandidates: 100 } };
    case "analytical":
      return {
        enhance: { multiQuery: true, n: 3 },
        searchOverrides: { rerankCandidates: 80 },
      };
    case "conversational":
      return { searchOverrides: { minSimilarity: 0.5, perArmK: 50 } };
    case "navigational": {
      const token = query ? extractFilenameToken(query) : undefined;
      return token ? { filenameContains: token } : {};
    }
    case "unknown":
    default:
      return {};
  }
}

export interface AgentRequest {
  model: string;
  messages: ChatMessage[];
  max_iter?: number;
  temperature?: number;
  /**
   * WARP-849 — per-iteration completion budget, forwarded verbatim to
   * the ai-gateway (OpenAI-compat `max_tokens`, which the local
   * provider passes straight to Ollama's /v1/chat/completions). The
   * /api/llm/chat zod schema always accepted this field but the loop
   * never forwarded it, so caller budgets were silently dropped.
   * Reasoning models (gpt-oss) spend completion tokens on the
   * reasoning channel BEFORE any user-visible content, so callers that
   * need a guaranteed visible answer (the setup wizard's sample probe)
   * must size this for reasoning + answer. Unset → no cap sent; the
   * provider default applies (pre-WARP-849 behavior).
   */
  max_tokens?: number;
  /**
   * WARP-1442 — gpt-oss reasoning-effort, forwarded verbatim to the
   * ai-gateway chat call (like `max_tokens`). The route resolves the
   * effective value — applying the `_service:voice` principal's server-side
   * "low" default — before handing it here; the loop only forwards it. Unset
   * → nothing is sent and the outbound request is byte-for-byte unchanged, so
   * the dashboard / every non-voice caller is unaffected.
   */
  reasoning_effort?: "low" | "medium" | "high";
  /** If set, restrict the registry to this subset of tool names. */
  allowed_tools?: string[];
  /**
   * Per-turn override for the model's tool advertisement.
   * - `"auto"` (default when unset) lets the model choose whether to call a tool.
   * - `"none"` sends ZERO tools to the model so it can't speculatively
   *   dispatch one. voice-io's intent gate
   *   (`services/voice-io/voice/pipeline.py::classify_tool_choice`) sets
   *   this for greetings, time-of-day, and who-are-you utterances that
   *   the system prompt already answers.
   */
  tool_choice?: "auto" | "none";
  /**
   * Per-call session context passed verbatim to every `mcp.callTool`
   * invocation in this loop. Today the only field is `ncToken` so file
   * tools can authenticate to Nextcloud as the dashboard user. The
   * MCP `_meta` channel carries it to the stdio child; stdio is
   * in-process trusted, so it's safe to plumb session tokens this way.
   */
  toolCallContext?: McpCallContext;
  /**
   * WARP-458 — emit `{type:"reasoning_step", text}` blocks on the wire
   * before the assistant's text. When `false` (or unset and the route
   * defaults to false), the agent loop still PARSES and writes the
   * concatenated trace to `result.message.reasoning` so the route layer
   * can persist it to `ChatMessage.reasoning` — only the SSE emission
   * is suppressed. When `true`, reasoning_step events are pushed before
   * the matching content_delta. See spec §AC4.
   */
  captureReasoning?: boolean;
  /**
   * WARP-473 — chat context the agent loop uses when handing file
   * paths off to `deps.citation.enqueue`. Required when
   * `deps.citation` is present (otherwise the citations have no
   * threadId/messageId to attach to). Omitted by callers that don't
   * persist chat messages (e.g. one-shot scripted invocations) —
   * those callers also leave `deps.citation` unset.
   */
  citationContext?: { userId: string; threadId: string; messageId: string };
  /**
   * WARP-329 — client-disconnect cancellation. When the dashboard closes
   * the SSE stream mid-turn, the route aborts an `AbortController` tied to
   * `req.on("close")` and passes its signal here. The loop forwards it to
   * the ai-gateway fetch (cancelling in-flight inference) and checks
   * `signal.aborted` between iterations and before each tool dispatch, so
   * a disconnect stops both further inference and any further (possibly
   * write) tool calls instead of running the turn to completion in the
   * background.
   */
  signal?: AbortSignal;
  /**
   * Spec §2 — effective model context window in tokens
   * (config.OLLAMA_CONTEXT_LENGTH in production; the route passes it
   * explicitly). Drives the per-iteration token guard. Unset →
   * DEFAULT_CONTEXT_WINDOW (conservative fallback for direct callers).
   */
  context_window?: number;
  /**
   * Spec §3 — relevance-based tool selection. "domains" narrows the
   * advertised tools per-turn (core set + rule-matched + conversation-
   * continuity domains); a filtered-but-allowed call self-heals via the
   * WARP-642 guard. Unset/"off" → full-pool advertisement, byte-for-byte
   * today's behavior. Only ever SUBSETS the pool this loop already resolved
   * (allowed_tools / chat scope) — RBAC is decided before this field.
   */
  tool_selection_mode?: "off" | "domains";
  /**
   * WARP-1921 — tool names already used EARLIER in this conversation, read
   * server-side from the persisted trace by the route.
   *
   * The §3 continuity rule ("domains of tools already called stay
   * advertised") originally read `tool_calls` off replayed assistant
   * messages, but `chatRequestSchema` never declared that field, so zod
   * stripped it and continuity only ever worked within a single turn's
   * iterations. That gap is why the spec's §6 outcome held
   * `TOOL_SELECTION_MODE` at "off".
   *
   * Unioned with the within-turn names below, so a follow-up like "rename it
   * to Side Gate" — which matches no domain keyword — still sees the camera
   * tools the previous turn used, instead of burning a self-heal iteration.
   *
   * Advisory only: it can never widen reach, because selection is applied to
   * `filtered` (already RBAC- and scope-narrowed) and only ever subsets it.
   */
  prior_tool_names?: string[];
  /**
   * WARP-1529 / ADR-032 §3 (RBAC v2 T5) — the caller's resolved per-role tool
   * reach. Applied TWICE, on purpose:
   *
   *   - to the advertised pool below (the model is never shown a tool the
   *     role lost), and
   *   - as a fail-closed re-check immediately before every `mcp.callTool`,
   *     so a stale client tool shelf or a replayed tool_call can't invoke a
   *     dropped tool even if it somehow reached the pool.
   *
   * Unset / null → no narrowing: the §3 owner bypass, service principals,
   * and every person with no AccessRole (today's whole world). Direct
   * service callers (email-analysis) also pass nothing and are unaffected.
   */
  toolAccessScope?: ToolAccessScope | null;
}

export interface AgentTraceEntry {
  tool_call_id: string;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

/**
 * WARP-1479 — why a terminal turn produced no visible answer.
 *
 * Present ONLY when the turn ended with empty visible content. The blank
 * itself is surfaced to the customer by the route's empty-completion
 * rewrite; this attributes it to a LAYER so the fix work is aimed at
 * evidence: the model returned nothing, it spent the turn in the reasoning
 * channel, or our own `sanitizeFinalContent` demoted what it did return.
 *
 * Counts and labels only — the raw completion can quote corpus text, so
 * `rawExcerpt` is opt-in behind `AGENT_BLANK_TURN_DEBUG`.
 */
export interface BlankAnswerDiagnostics {
  /** Raw `message.content` length before reasoning extraction. */
  rawContentChars: number;
  /** After `<reasoning>` segments are split out. */
  cleanedChars: number;
  /** After `sanitizeFinalContent` — always 0 (that's what makes it blank). */
  visibleChars: number;
  /** Provider-native reasoning channel (`reasoning_content`) length. */
  providerReasoningChars: number;
  /** Parsed `<reasoning>…</reasoning>` step count. */
  parsedReasoningSteps: number;
  /** Tool dispatches in this turn's trace — a blank AFTER real tool work is
   *  the WARP-1479 shape; a blank with zero tools is the WARP-854 shape. */
  toolCalls: number;
  cause:
    /** No content and no reasoning channel — the model emitted nothing. */
    | "model_returned_nothing"
    /** Content empty but the reasoning channel ran — thought, never answered. */
    | "reasoning_only"
    /** Content was bare tool-args JSON; the sanitizer demoted it (WARP-1331). */
    | "sanitizer_demoted_json"
    /** Content was citation tokens / whitespace only; the strip pass emptied it. */
    | "sanitizer_stripped_all";
  /** Bounded (500-char) raw excerpt. Opt-in: AGENT_BLANK_TURN_DEBUG=1. */
  rawExcerpt?: string;
  /**
   * The provider's own verdict for the BLANK iteration (blocking transport
   * only — the streaming transport doesn't surface these). `finishReason`
   * "length" or `promptTokens` near the configured window is the mid-turn
   * context-overflow signature (WARP-854's mechanism recurring later in the
   * turn); `promptTokens` well under the window exonerates the window.
   */
  finishReason?: string | null;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * WARP-1602 — the inverse of {@link BlankAnswerDiagnostics}: why a turn's
 * visible answer looks like it still carries chain-of-thought.
 *
 * WARP-1479 attributes a turn that said NOTHING. This attributes a turn that
 * said TOO MUCH — the answer opens with analysis prose ("We need to answer…",
 * "The user is asking…") or carries the run-on join that per-iteration
 * analysis fragments produce when they are concatenated ("…list files.Let's
 * read csv."). Present ONLY when at least one marker fires, so a healthy turn
 * stays silent in the logs exactly like a healthy blank-turn check does.
 *
 * Labels + counts only; `rawExcerpt` is opt-in behind AGENT_BLANK_TURN_DEBUG
 * for the same reason (the answer can quote the customer's own documents).
 */
export interface PollutedAnswerDiagnostics {
  /** Which heuristics fired, in declaration order. Never empty. */
  markers: string[];
  /** Length of the sanitized answer the customer would see. */
  visibleChars: number;
  /** Intermediate steps whose content this turn held back as reasoning. */
  quarantinedSteps: number;
  /** Total chars of intermediate content routed to `reasoning` this turn. */
  quarantinedChars: number;
  /** Which transport produced the terminal turn. */
  transport: "streaming" | "blocking";
  /** Tool dispatches in this turn's trace. */
  toolCalls: number;
  /** Bounded (500-char) excerpt of the answer. Opt-in: AGENT_BLANK_TURN_DEBUG=1. */
  rawExcerpt?: string;
}

export interface AgentResult {
  message: ChatMessage;
  trace: AgentTraceEntry[];
  iterations: number;
  stop_reason:
    | "model_done"
    | "iteration_limit"
    | "error"
    | "context_budget"
    | "repetition";
  error?: string;
  /** WARP-1479 — set only when the terminal turn produced no visible answer. */
  blankDiagnostics?: BlankAnswerDiagnostics;
  /**
   * WARP-1602 — set only when the visible answer trips an analysis-leak
   * heuristic. The customer-facing behaviour is unchanged; this is the
   * operator/eval attribution channel.
   */
  pollutedDiagnostics?: PollutedAnswerDiagnostics;
  /**
   * WARP-1602 — the turn's reasoning trace with its PER-STEP boundaries
   * intact, in arrival order: one entry per agent iteration that produced
   * any thinking (intermediate tool-call steps first, the terminal answer
   * step last). `message.reasoning` is the same list flattened with
   * {@link REASONING_STEP_SEPARATOR} for the `ChatMessage.reasoning` column;
   * in-process consumers should prefer this array over re-splitting the
   * string. Absent when the turn produced no reasoning at all.
   */
  reasoningSteps?: string[];
}

/**
 * WARP-1602 — boundary between agent STEPS inside the flattened
 * `ChatMessage.reasoning` string.
 *
 * `ChatMessage.reasoning` is a single `String?` column, so a multi-step trace
 * has to be flattened to persist. Flattening with the plain `\n\n` that
 * `parseReasoningTrace` uses WITHIN one step would erase the step boundary,
 * and a renderer could never put it back. This sentinel keeps it: split on it
 * to recover the per-step list (WARP-1605 renders these as separate blocks).
 * Chosen to be human-readable when a raw trace is displayed today and
 * effectively impossible for a model to emit verbatim on its own line.
 */
export const REASONING_STEP_SEPARATOR = "\n\n--- step ---\n\n";

/**
 * WARP-458 — parsed reasoning trace for a single assistant turn.
 *
 * `reasoningSteps[]` is in arrival order, ready to pump through
 * `{type:"reasoning_step", text}` events. `cleanedContent` is the
 * user-visible text with all `<reasoning>…</reasoning>` segments
 * stripped. `fullReasoning` is the concatenated trace for
 * `ChatMessage.reasoning` persistence — null when no reasoning was
 * detected so the DB column stays NULL for the overwhelming majority
 * of pre-WARP-458 historical-shape turns.
 */
export interface ParsedReasoningTrace {
  reasoningSteps: string[];
  cleanedContent: string;
  fullReasoning: string | null;
}

/**
 * WARP-458 — extract reasoning trace + clean user-visible content from
 * a single assistant turn's raw output.
 *
 * Handles three input shapes:
 *   1. Inline `<reasoning>…</reasoning>` segments interleaved with the
 *      content (qwen3 / deepseek-r1 family). Multiple sibling segments
 *      become multiple steps, in the order they appear.
 *   2. A provider-native reasoning string (OpenAI o-series via LiteLLM,
 *      Anthropic extended-thinking when exposed). Passed via
 *      `providerReasoning` and treated as a single step that lands
 *      BEFORE any inline-derived steps.
 *   3. The defensive case: an opening `<reasoning>` tag with no close
 *      (truncated stream, mid-stream abort) — the remainder is treated
 *      as one step rather than leaked into the user-visible content.
 *
 * The regex uses a non-greedy match with the `s` flag so a single
 * `<reasoning>` segment can span newlines; the no-close fallback
 * handles the truncation case. Whitespace-only segments are dropped so
 * `<reasoning>   </reasoning>` doesn't produce an empty step block.
 */
export function parseReasoningTrace(args: {
  content: string | null;
  providerReasoning?: string | null;
}): ParsedReasoningTrace {
  const steps: string[] = [];

  // Provider-native reasoning (when present) is the FIRST step. Cloud
  // providers that surface a separate reasoning field do so for the
  // whole turn, not interleaved with the visible content, so it makes
  // sense to render that summary before any inline-derived chunks.
  if (args.providerReasoning) {
    const trimmed = args.providerReasoning.trim();
    if (trimmed.length > 0) steps.push(trimmed);
  }

  let working = args.content ?? "";

  // Walk inline `<reasoning>…</reasoning>` segments in document order.
  // `closedSegment` captures both the segment text and its placement so
  // we can rebuild the cleaned content by splicing the matches out.
  const closedSegment = /<reasoning>([\s\S]*?)<\/reasoning>/g;
  let match: RegExpExecArray | null;
  const cleanedParts: string[] = [];
  let cursor = 0;
  while ((match = closedSegment.exec(working)) !== null) {
    // Whatever sits before this `<reasoning>` opening is user-visible
    // content — append it to the cleaned output.
    cleanedParts.push(working.slice(cursor, match.index));
    const trimmed = match[1].trim();
    if (trimmed.length > 0) steps.push(trimmed);
    cursor = match.index + match[0].length;
  }
  // Trailing remainder after the last closed segment (if any).
  cleanedParts.push(working.slice(cursor));
  working = cleanedParts.join("");

  // Defensive: an opening `<reasoning>` with no close. Treat the rest
  // of the string as a single step and clean it from the visible
  // output. This is the truncated-stream case.
  const openIdx = working.indexOf("<reasoning>");
  if (openIdx !== -1) {
    const tail = working.slice(openIdx + "<reasoning>".length).trim();
    if (tail.length > 0) steps.push(tail);
    working = working.slice(0, openIdx);
  }

  // Collapse the leftover whitespace that the splice opens up — the
  // model often emits ` <reasoning>…</reasoning> ` with a leading and
  // trailing space we don't want doubled in the cleaned output. Tidy
  // horizontal runs and excess blank lines separately so paragraph
  // breaks (`\n\n`) survive — the parser runs unconditionally on every
  // chunk per AC4, so a blanket `\s+ → " "` would silently flatten
  // every paragraph in every reply (WARP-458 R2 regression).
  const cleanedContent = working
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const fullReasoning = steps.length > 0 ? steps.join("\n\n") : null;
  return { reasoningSteps: steps, cleanedContent, fullReasoning };
}

// ── WARP-1442 — SERVER-SIDE token streaming ─────────────────────────────────
//
// The agent loop can obtain a turn two ways:
//   1. blocking `aiGateway.chat()` — one JSON body, one content_delta emitted
//      after the full decode (the historical path; unchanged);
//   2. streaming `aiGateway.chatStream()` — an OpenAI-compat token stream from
//      which we emit content_delta INCREMENTALLY as the model generates.
//
// The streaming consumer synthesises the SAME `asst` ChatMessage the blocking
// path produces (content + tool_calls + reasoning_content), so the rest of the
// loop — tool dispatch, the hallucinated-tool guard, the terminal finalize —
// runs UNCHANGED. The only difference is that content_delta + reasoning_step
// were already emitted during the stream, so the terminal block skips
// re-emitting them (guarded by `streamedTurn`).

/**
 * WARP-1602 (review B1/B2) — what a torn-down turn salvaged before it died.
 *
 * Both teardown paths (client abort, mid-stream transport death) leave
 * `consumeChatStream` by THROWING, which used to skip `settle()` entirely and
 * drop the emitter's buffer on the floor. On a DEFERRED turn that buffer is the
 * only copy of the answer — nothing was streamed — so the user lost 100% of a
 * partial answer that survived before deferral existed. Every throw now settles
 * first and carries the verdict here.
 */
interface StreamTeardownPartial {
  /** The buffer `settle()` handed back — this turn's raw content so far. */
  raw: string;
  /**
   * True when `settle()` RELEASED that buffer to the wire as answer text (so
   * `content_delta` events for it have already been emitted and the route's
   * accumulator has it). False on a tool-call turn, where the buffer is
   * quarantined analysis and must never surface as the answer.
   */
  released: boolean;
  /**
   * WARP-1602 (review) — the EXACT concatenation of the `content_delta` events
   * `settle()` emitted, straight off the emitter's own accumulator.
   *
   * `raw` is NOT a substitute. On a teardown the stream did not finish, so the
   * emitter releases only the stable prefix and holds the volatile tail back;
   * re-deriving the answer from `raw` here would put a longer string in
   * `message.content` than the wire ever carried and break the WARP-1442 sum
   * invariant. Taking the accumulator makes the two agree by construction
   * rather than by two parses that have to be kept in step.
   *
   * Empty when nothing was released (`released: false`, or a bare-JSON buffer
   * that WARP-854 holds back whole).
   */
  releasedContent: string;
}

/** Thrown by the stream consumer when the client disconnected mid-generation. */
class AgentStreamAborted extends Error {
  constructor(readonly partial: StreamTeardownPartial) {
    super("client_aborted");
    this.name = "AgentStreamAborted";
  }
}

/**
 * Thrown when the token stream errors AFTER content/reasoning was already
 * emitted. We must NOT fall back to the blocking path in that case — replaying
 * would double-emit the answer and corrupt the persisted content. This surfaces
 * as an honest error turn instead (the same outcome the blocking path would
 * reach if its connection died mid-answer).
 */
class AgentStreamPartialError extends Error {
  constructor(
    readonly cause: unknown,
    readonly partial: StreamTeardownPartial,
  ) {
    super("stream_interrupted");
    this.name = "AgentStreamPartialError";
  }
}

/** The partial an outside-the-consumer abort (no buffer at all) reports. */
const NO_PARTIAL: StreamTeardownPartial = {
  raw: "",
  released: false,
  releasedContent: "",
};

/**
 * WARP-1660 — the salvaged partial off EITHER teardown carrier.
 *
 * `consumeChatStream` picks the carrier from the signal it sees at the instant
 * it fails; `runAgent` picks the terminal from the signal it sees one async
 * hop later. Those two reads can disagree: a disconnect landing inside that
 * window sends an `AgentStreamPartialError` down the abort branch. Both types
 * carry `.partial` for exactly the same reason, so which one arrives must not
 * decide whether the answer survives — reading it off only `AgentStreamAborted`
 * replaced a recovered answer with `NO_PARTIAL`, i.e. the blank row this whole
 * salvage path exists to prevent.
 *
 * An EMPTY partial needs no special case: `teardownResult` already renders
 * `{ released: true, releasedContent: "" }` as `content: ""` — the same
 * outcome as `NO_PARTIAL`.
 */
function teardownPartialOf(err: unknown): StreamTeardownPartial {
  return err instanceof AgentStreamAborted ||
    err instanceof AgentStreamPartialError
    ? err.partial
    : NO_PARTIAL;
}

/** Name-based abort check (mirrors routes/llm.ts — robust to error re-wrapping). */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "AgentStreamAborted")
  );
}

/**
 * WARP-1442 — longest k in [1, marker.length) such that `s` ends with the
 * first k chars of `marker`. Used to hold back a trailing PARTIAL control
 * marker (e.g. a `<reasoning>` opening tag split across chunks) until the rest
 * of it arrives, so we never leak a half-tag as content.
 */
function trailingPrefixLen(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let k = max; k >= 1; k--) {
    if (s.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

/**
 * WARP-1442 — the largest PREFIX of the raw streamed content that is SAFE to
 * finalize NOW: appending more tokens can't retroactively change it. We hold
 * back the volatile tail so the incremental deltas we emit always sum EXACTLY
 * to the blocking path's single answer.
 *
 * Returns `null` when the WHOLE buffer must be held: a completion that starts
 * as a bare JSON object/array is failed tool routing that `sanitizeFinalContent`
 * demotes to "" (WARP-854) — we can't know whether it parses until it's whole,
 * so we never stream a JSON blob we might have to retract.
 */
function stableStreamedContent(raw: string): string | null {
  if (/^\s*[[{]/.test(raw)) return null;
  let s = raw;
  // Hold back from an UNCLOSED inline `<reasoning>` segment (qwen3/deepseek):
  // parseReasoningTrace only strips CLOSED segments deterministically, and the
  // reasoning text must never leak into user-visible content (WARP-495).
  const openTag = "<reasoning>";
  const lastOpen = s.lastIndexOf(openTag);
  if (lastOpen !== -1 && s.indexOf("</reasoning>", lastOpen) === -1) {
    s = s.slice(0, lastOpen);
  }
  // Hold back a trailing PARTIAL `<reasoning>` opening tag (e.g. "…<reas").
  const partial = trailingPrefixLen(s, openTag);
  if (partial) s = s.slice(0, s.length - partial);
  // Hold back an unclosed harmony citation token `【…` until its `】` arrives
  // (gpt-oss leaks `【3†source=…】` — WARP-1331 strips the complete token).
  const lastTok = s.lastIndexOf("【");
  if (lastTok !== -1 && s.indexOf("】", lastTok) === -1) s = s.slice(0, lastTok);
  return s;
}

/**
 * WARP-1442 — turns a growing raw-content buffer into INCREMENTAL, sanitized
 * `content_delta` events plus `reasoning_step` events for any CLOSED inline
 * `<reasoning>` segments (in document order, before the content that follows
 * them). By construction the concatenation of every emitted content_delta is
 * byte-identical to the blocking path's single delta:
 *   `sanitizeFinalContent(parseReasoningTrace(raw).cleanedContent)`.
 *
 * WARP-1602 — `deferred` mode holds EVERYTHING back until the turn's stop
 * reason is known. A turn that advertised tools may still resolve to
 * `tool_calls`, and on such a turn the streamed `delta.content` is the model's
 * analysis, not its answer (the live gpt-oss shape on the .87 box). Since a
 * turn is only known non-tool at its terminal chunk, the only way to never put
 * analysis on the wire is to decide at that point — which is what `settle()`
 * does: release for a terminal turn, quarantine for a tool-call one.
 */
class StreamingContentEmitter {
  private raw = "";
  private emittedContent = "";
  private emittedSteps = 0;

  constructor(
    private readonly emit: (e: SSEEvent) => void,
    private readonly captureReasoning: boolean,
    /**
     * WARP-1602 — when true nothing goes on the wire during the stream; the
     * turn's shape decides at `settle()`. Set by the caller for iterations
     * that advertised tools (i.e. could end in `tool_calls`); a zero-tool
     * iteration cannot, so it streams progressively as before.
     */
    private deferred = false,
  ) {}

  push(fragment: string): void {
    this.raw += fragment;
    if (!this.deferred) this.flush(false);
  }

  /**
   * Decide the turn, hand back the raw buffer, and say whether the content
   * reached the wire.
   *
   *   - tool-call turn that was DEFERRED → quarantine: nothing was emitted and
   *     nothing more will be. The loop reclassifies the buffer as this step's
   *     reasoning.
   *   - anything else → release: either this content IS the answer (terminal
   *     turn), or the turn was never deferred and its content already went out
   *     progressively — flushing the final remainder keeps the emitted deltas
   *     summing to the whole buffer, which is the WARP-1442 invariant.
   *
   * `streamComplete` says whether the token stream actually REACHED its end.
   * It is what `flush`'s `final` means, and the two are not interchangeable:
   * `final: true` asserts "the whole buffer is stable because no more tokens
   * are coming". A teardown is precisely the case where that is false — more
   * tokens were coming, the connection just died first — so a torn-down turn
   * must release only `stableStreamedContent`'s prefix. Passing `true` here
   * unconditionally (as this did) put half-finished tokens on the wire and in
   * the DB: a partial `<reasoning>` open tag, or an unterminated harmony
   * citation like `【3†source=inv`, which WARP-1331 cannot strip because it
   * only matches the COMPLETE token.
   */
  settle(
    isToolCallTurn: boolean,
    streamComplete: boolean,
  ): { raw: string; contentReleased: boolean; releasedContent: string } {
    if (isToolCallTurn && this.deferred) {
      return { raw: this.raw, contentReleased: false, releasedContent: "" };
    }
    this.deferred = false;
    this.flush(streamComplete);
    // The accumulator IS the sum of the content_delta events emitted for this
    // turn, so handing it back keeps `message.content` byte-identical to the
    // wire without a second parse that could drift from `flush`'s.
    return {
      raw: this.raw,
      contentReleased: true,
      releasedContent: this.emittedContent,
    };
  }

  private flush(final: boolean): void {
    const view = final ? this.raw : stableStreamedContent(this.raw);
    if (view === null) return; // bare-JSON answer held until finish (WARP-854)
    const parsed = parseReasoningTrace({ content: view });
    // Emit newly-CLOSED inline reasoning segments before their content.
    if (this.captureReasoning) {
      for (let i = this.emittedSteps; i < parsed.reasoningSteps.length; i++) {
        this.emit({ type: "reasoning_step", text: parsed.reasoningSteps[i]! });
      }
    }
    this.emittedSteps = parsed.reasoningSteps.length;
    const visible = sanitizeFinalContent(parsed.cleanedContent);
    // The safe view is always a prefix-extension of what we've emitted; guard
    // anyway so an unexpected non-monotonic step can never corrupt the answer.
    if (
      visible.length > this.emittedContent.length &&
      visible.startsWith(this.emittedContent)
    ) {
      const delta = visible.slice(this.emittedContent.length);
      this.emittedContent = visible;
      this.emit({ type: "content_delta", text: delta });
    }
  }
}

/** Accumulate a streamed tool-call fragment into the by-index register. */
function accumulateToolCall(
  byIndex: Map<number, { id: string; name: string; args: string }>,
  order: number[],
  frag: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  },
): void {
  const idx = typeof frag.index === "number" ? frag.index : 0;
  let acc = byIndex.get(idx);
  if (!acc) {
    acc = { id: "", name: "", args: "" };
    byIndex.set(idx, acc);
    order.push(idx);
  }
  // The `id` + function `name` arrive on the FIRST fragment for an index; the
  // `arguments` arrive as partial JSON strings across subsequent fragments.
  if (frag.id) acc.id = frag.id;
  if (frag.function?.name) acc.name = frag.function.name;
  if (typeof frag.function?.arguments === "string") {
    acc.args += frag.function.arguments;
  }
}

/**
 * WARP-1442 — drain one turn's token stream, emitting content_delta +
 * reasoning_step incrementally, and return the synthesised assistant message
 * (identical in shape to `chat()`'s `choice.message`) for the rest of the loop.
 *
 * - `delta.content` → accumulate + emit content_delta incrementally, UNLESS
 *   `deferContent` (WARP-1602): a turn that advertised tools may resolve to
 *   `tool_calls`, and then its content is analysis, not an answer — so it is
 *   held until the turn's shape is known and quarantined if tool calls landed.
 * - the provider reasoning channel (`reasoning` | `reasoning_content` |
 *   `thinking` — see `providerReasoningOf`) → accumulate; emit as ONE
 *   `reasoning_step` BEFORE the first content_delta (WARP-458 ordering), and
 *   ONLY on a terminal (non-tool-call) turn — a tool-call turn's reasoning is
 *   emitted by the LOOP instead (one site for both transports, WARP-1602).
 * - `delta.tool_calls` → accumulate fragments BY INDEX into valid calls; never
 *   emitted as content.
 * - client disconnect (WARP-329) → break, which tears the upstream Ollama
 *   stream down (the `for await` calls `.return()`), then throw so the loop
 *   returns the aborted terminal.
 */
/**
 * The provider-native reasoning text on one stream delta, whatever the
 * provider calls it.
 *
 * WARP-1613. Three spellings are in play and we only read one of them:
 * - `reasoning` — **Ollama's OpenAI-compat layer** (`ollama/openai/openai.go`
 *   declares `Reasoning string \`json:"reasoning,omitempty"\`` on the delta
 *   message and fills it from `r.Message.Thinking`). This is the one we were
 *   missing, and it is the one gpt-oss uses on our shipped transport.
 * - `reasoning_content` — LiteLLM / OpenAI o-series / Anthropic extended
 *   thinking; the only name previously read (WARP-458).
 * - `thinking` — Ollama's NATIVE `/api/chat` shape. Not on our transport
 *   today; tolerated so switching later needs no change here.
 *
 * Returns "" when none is present, so callers can treat it as falsy.
 *
 * SCOPED TO THE STREAMING DELTA ON PURPOSE. The blocking path takes the
 * provider's message verbatim (`asst = choice.message`), and on `ChatMessage`
 * the name `reasoning` is already OURS — the parsed trace the route persists —
 * while `reasoning_content` is the provider's. If Ollama also sets `reasoning`
 * on a non-streaming message, those two meanings collide on one field, and
 * whether that is harmless (provider text lands in the field we persist
 * anyway) or a double-count depends on Ollama's actual blocking shape, which
 * is not established here. Streaming is the shipped dashboard path (WARP-1442)
 * and the only one with a live reproduction, so the fix stops there. Resolving
 * the blocking path needs a capture from a real box.
 */
export function providerReasoningOf(delta: {
  reasoning?: string | null;
  reasoning_content?: string | null;
  thinking?: string | null;
}): string {
  // FIRST-WINS, not concatenate (review). These three names are three SPELLINGS
  // OF ONE CHANNEL, never three channels — no provider emits two of them with
  // different content for the same delta. So if two are ever present they carry
  // the same text, and concatenating yields it twice ("XX") on the wire and in
  // the persisted trace. First-wins degrades to a duplicate being ignored,
  // which is the safe direction: at worst we drop a copy of what we already
  // have, where concatenating corrupts a trace the user reads.
  //
  // Unreachable on our transport today — ollama 0.30.8's `openai/openai.go`
  // declares only `Reasoning`, and a live probe of all four turn shapes saw
  // `reasoning_content` zero times — but the ordering is deliberate anyway:
  // `reasoning` (what Ollama actually sends) is checked before the LiteLLM
  // spelling, so the shipped path never depends on the tie-break.
  for (const v of [delta.reasoning, delta.reasoning_content, delta.thinking]) {
    if (typeof v === "string" && v) return v;
  }
  return "";
}

async function consumeChatStream(
  stream: AsyncIterable<ChatStreamChunk>,
  opts: {
    emit: (e: SSEEvent) => void;
    captureReasoning: boolean;
    signal?: AbortSignal;
    /**
     * WARP-1602 — hold content back until the turn's stop reason is known.
     * True for iterations that advertised tools.
     */
    deferContent?: boolean;
  },
): Promise<{ asst: ChatMessage; wireEmitted: boolean; contentReleased: boolean }> {
  const { emit, captureReasoning, signal } = opts;
  // Track whether we've put ANYTHING on the wire this turn. If the stream errors
  // AFTER we've emitted, the loop must NOT fall back to blocking chat() (that
  // would replay + double-emit the answer) — we surface an error turn instead.
  let emittedAny = false;
  const trackedEmit = (e: SSEEvent) => {
    if (e.type === "content_delta" || e.type === "reasoning_step") {
      emittedAny = true;
    }
    emit(e);
  };
  const content = new StreamingContentEmitter(
    trackedEmit,
    captureReasoning,
    opts.deferContent ?? false,
  );
  let reasoningBuf = "";
  let channelReasoningEmitted = false;
  let sawContent = false;
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  const toolOrder: number[] = [];

  const flushChannelReasoning = () => {
    if (channelReasoningEmitted) return;
    channelReasoningEmitted = true;
    if (captureReasoning) {
      const step = reasoningBuf.trim();
      if (step) trackedEmit({ type: "reasoning_step", text: step });
    }
  };

  /**
   * WARP-1602 (review B1/B2) — settle the emitter on a TEARDOWN path.
   *
   * A turn only leaves the normal exit through `settle()`, which is what
   * releases a deferred buffer. Both throw paths used to bypass it, so on a
   * deferred turn the whole partial answer was discarded: pressing Stop 400
   * tokens into an answer left a blank screen and an empty DB row, and a
   * mid-stream transport death did the same. Settling here restores the
   * pre-deferral outcome — the partial reaches the wire (and therefore the
   * route's `liveAssistantContent` accumulator, which is what the error-turn
   * persistence path reads) and is handed to the caller.
   *
   * The tool-call verdict is taken from the fragments that DID arrive, so the
   * WARP-1602 guarantee still holds where we have evidence to apply it: if
   * tool-call fragments landed, this turn's content is analysis and `settle`
   * quarantines it exactly as a completed tool-call turn would. Only with zero
   * tool-call fragments is the buffer released as answer text.
   */
  const settleTeardown = (): StreamTeardownPartial => {
    // `streamComplete: false` — this is a teardown by definition, so only the
    // stable prefix may be released (see `settle`).
    const { raw, contentReleased, releasedContent } = content.settle(
      toolOrder.length > 0,
      false,
    );
    return { raw, released: contentReleased, releasedContent };
  };

  try {
    for await (const chunk of stream) {
      // WARP-329 — a mid-stream disconnect stops draining; breaking the
      // for-await calls the iterator's `.return()`, tearing down the Ollama
      // stream.
      if (signal?.aborted) break;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      // WARP-1613 — read every spelling the provider fleet uses. Ollama's
      // OpenAI-compat layer emits `reasoning`; LiteLLM/cloud emit
      // `reasoning_content`; native `/api/chat` emits `thinking`. Only the
      // middle one was read, so gpt-oss's analysis channel arrived under a
      // name nothing looked at. At most one is populated per delta in
      // practice; concatenating in a fixed order is well-defined even if a
      // provider ever sends two.
      const deltaReasoning = providerReasoningOf(delta);
      if (deltaReasoning) {
        reasoningBuf += deltaReasoning;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          accumulateToolCall(toolCalls, toolOrder, tc);
        }
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        // gpt-oss streams the reasoning channel fully before content — flush it
        // as a step so reasoning_step precedes content_delta (WARP-458 order).
        if (!sawContent) {
          flushChannelReasoning();
          sawContent = true;
        }
        content.push(delta.content);
      }
    }
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) {
      throw new AgentStreamAborted(settleTeardown());
    }
    // Nothing emitted yet → let the loop fall back to blocking chat(). Already
    // emitted → a fallback would double the answer, so make it an error turn.
    //
    // NOTE (review B2): `emittedAny` is deliberately left as-is, including the
    // channel-reasoning flush. Relaxing it so a deferred turn could still fall
    // back would buy a re-inferred full answer on a transport that just died,
    // at the cost of re-emitting a reasoning_step the client already has — and
    // it is mutually exclusive with salvaging the buffer, which is
    // deterministic, free, and also fixes the abort path above (which never
    // consults `emittedAny` at all). We salvage.
    if (emittedAny) throw new AgentStreamPartialError(err, settleTeardown());
    throw err;
  }

  if (signal?.aborted) throw new AgentStreamAborted(settleTeardown());

  // Flush the channel reasoning for a terminal turn (content, empty, or
  // reasoning-only) BEFORE releasing the content, so reasoning_step still
  // precedes content_delta (WARP-458 order) on a deferred turn too.
  //
  // WARP-1602 — a tool-call turn deliberately emits nothing here. Its
  // reasoning (channel text AND the quarantined content) is emitted by
  // `runAgent`, which is the ONE site that handles intermediate steps for
  // both the streaming and the blocking transport.
  const isToolCallTurn = toolOrder.length > 0;
  if (!isToolCallTurn) flushChannelReasoning();

  // Terminal turn → the buffer is the answer, release it. DEFERRED tool-call
  // turn → the buffer is analysis, quarantine it (WARP-1602). A tool-call turn
  // that was NOT deferred already streamed its content, so it still flushes:
  // withholding only the volatile tail would leave the wire short of the
  // buffer, and the WARP-1442 sum invariant is what catches that.
  // `streamComplete: true` — the for-await drained to its end, so the whole
  // buffer is stable and `flush` may release it entire.
  const { raw: rawContent, contentReleased } = content.settle(
    isToolCallTurn,
    true,
  );

  const asst: ChatMessage = { role: "assistant", content: rawContent };
  if (toolOrder.length > 0) {
    asst.tool_calls = toolOrder.map((idx) => {
      const tc = toolCalls.get(idx)!;
      return {
        id: tc.id || `call_${idx}`,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.args },
      };
    });
  }
  // Surface the raw reasoning channel so the terminal finalize can fold it into
  // `message.reasoning` exactly as the blocking path does (parseReasoningTrace's
  // `providerReasoning`).
  if (reasoningBuf.trim()) asst.reasoning_content = reasoningBuf;
  // WARP-1602 — two flags the loop needs to avoid saying anything twice:
  // `wireEmitted` (this turn already put content/reasoning on the wire, so the
  // intermediate-step emission must not repeat it) and `contentReleased` (the
  // content reached the wire as the ANSWER, so the terminal finalize must not
  // re-emit it).
  return { asst, wireEmitted: emittedAny, contentReleased };
}

export async function runAgent(deps: AgentDeps, req: AgentRequest): Promise<AgentResult> {
  // Spec §1 — both enforcement points (this clamp + the /api/llm/chat zod
  // bound) read config.agentMaxIter, so they cannot drift.
  const maxIter = Math.max(
    1,
    Math.min(
      req.max_iter ?? config.agentMaxIter.defaultIter,
      config.agentMaxIter.capIter,
    ),
  );
  const trace: AgentTraceEntry[] = [];
  // WARP-1480 — turn-scoped correlation id for `agent_tool_error`. `thread_id`
  // cannot serve: it needs conversationId + assistantMessageId + citationUserId
  // to ALL be truthy (routes/llm.ts), so an ephemeral or service-token turn has
  // none and its failures would be unjoinable.
  const turnId = newAgentTurnId();
  // Copy so we don't mutate the caller's array.
  const messages: ChatMessage[] = [...req.messages];
  const emit = deps.onEvent ?? (() => {});

  // Tools come from the MCP server (cached). Translate the MCP tool
  // descriptors into OpenAI-style function specs the ai-gateway forwards
  // to the model.
  //
  // tool_choice="none" suppresses tools entirely: send an empty array so
  // a misbehaving model can't decode a tool_call from a phantom function
  // (some llama-family fine-tunes emit `{"name": "get_time"}` as content
  // even when told not to call tools). Defense in depth — the ai-gateway
  // also receives tool_choice="none", but advertising zero tools makes
  // it impossible by construction.
  const toolChoice: "auto" | "none" = req.tool_choice ?? "auto";
  const allTools = toolChoice === "none" ? [] : await deps.mcp.listTools();
  // Distinguish `undefined` (no restriction → the default chat scope) from
  // an explicit empty array (caller asked for ZERO tools). Truthiness on
  // `.length` would conflate the two and silently advertise the default
  // scope for an intentional `allowed_tools: []`.
  //
  // WARP-1424: with no explicit `allowed_tools`, chat advertises the
  // registry minus the specialist/admin exclusion set — the full ~127-tool
  // registry no longer fits the shipping 16K window (see chat-tool-scope.ts
  // and the WARP-1118 canary). External MCP clients are unaffected; an
  // explicit `allowed_tools` still selects freely from the full registry.
  //
  // WARP-1529 (RBAC v2 T5): the §3 tool-domain axis narrows BOTH branches —
  // an explicit `allowed_tools` is client-supplied and a role holder's shelf
  // can be stale, so it is a request, never a grant. `undefined` scope (the
  // owner bypass / service principals / everyone with no AccessRole) leaves
  // the pool byte-for-byte as it was.
  const scoped = req.toolAccessScope;
  const inScope = (name: string): boolean =>
    !scoped || toolAllowedInScope(name, scoped);
  const filtered = (
    req.allowed_tools
      ? allTools.filter((t) => req.allowed_tools!.includes(t.name))
      : allTools.filter((t) => !EXCLUDED_FROM_CHAT_TOOLS.has(t.name))
  ).filter((t) => inScope(t.name));
  const toSpec = (t: (typeof filtered)[number]) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  });
  // Spec §3 — per-turn relevance selection. `filtered` (the effective pool
  // after RBAC/chat-scope) stays the ceiling: the self-heal branch below may
  // re-admit pool tools that selection dropped, but NOTHING outside it.
  const fullPoolNames = new Set(filtered.map((t) => t.name));
  let activeTools = filtered;
  if (req.tool_selection_mode === "domains" && toolChoice !== "none") {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    // WARP-1921 — continuity spans BOTH sources, and needs both:
    //   • `prior_tool_names` — earlier TURNS, read from the persisted trace
    //     by the route. `req.messages` cannot supply these: chatRequestSchema
    //     declares no `tool_calls` field, so zod strips it from every
    //     replayed assistant message.
    //   • `req.messages` — earlier ITERATIONS of THIS turn, where the loop
    //     pushes the model's raw message object with tool_calls intact. Still
    //     required: those calls are not persisted until the turn finalizes.
    const conversationToolNames = [
      ...(req.prior_tool_names ?? []),
      ...req.messages.flatMap((m) =>
        m.role === "assistant" && m.tool_calls
          ? m.tool_calls.map((tc) => tc.function.name)
          : [],
      ),
    ];
    // `content` is an array (multimodal — e.g. an image attachment) on some
    // user turns; rule matching only understands plain text, so those turns
    // yield "" here and fall back to core-only advertisement. That's an
    // accepted gap, not a silent failure: the WARP-642 self-heal branch
    // below re-admits any real tool the model still names, at the cost of
    // one lost iteration.
    const sel = selectAdvertisedTools({
      mode: "domains",
      userMessage:
        typeof lastUser?.content === "string" ? lastUser.content : "",
      pool: filtered.map((t) => t.name),
      conversationToolNames,
    });
    const selected = new Set(sel.advertised);
    activeTools = filtered.filter((t) => selected.has(t.name));
  }
  let tools = activeTools.map(toSpec);
  // WARP-642 — the exact set of tool names the model was advertised this
  // turn. Used to catch hallucinated tool names (e.g. gpt-oss:20b inventing
  // `knowledge_base_search` instead of the real `search_content`) BEFORE we
  // dispatch them to the MCP child. The MCP server already rejects unknown
  // names with `{"error":"Unknown tool: X"}`, but that envelope never tells
  // the model which names ARE valid, so it tends to guess a second wrong
  // name rather than self-correct (the knowledge-retrieval failure mode in
  // WARP-642). We intercept here and feed back an error that LISTS the
  // available tools so the model can recover within the same loop, on the
  // remaining iterations, without a round-trip to the MCP child.
  let advertisedNames = new Set(tools.map((t) => t.function.name));
  let availableToolList = tools.map((t) => t.function.name).join(", ");

  // Spec §2/§4 — when set, the NEXT model call is a finalization pass: zero
  // tools, tool_choice "none", plus a one-time system nudge. A flag rather
  // than a break because the user still deserves an answer synthesized from
  // the gathered results, which needs one more inference call.
  const contextWindow = req.context_window ?? DEFAULT_CONTEXT_WINDOW;
  let finalizeReason: "context_budget" | "repetition" | null = null;
  // WARP-1479 — the provider's verdict for the most recent BLOCKING
  // response, folded into the blank-answer diagnostics when the terminal
  // turn produces no visible output. Set fresh on every blocking response
  // so a blank terminal can never inherit an earlier iteration's numbers.
  let lastFinishReason: string | null | undefined;
  let lastUsage:
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined;

  // Spec §4 repetition early-stop. Key = tool name + DEEP-canonicalized args:
  // object keys sorted recursively so {a:1,b:2} and {b:2,a:1} collide as
  // intended, while nested payload differences (which a flat replacer
  // array would erase) keep genuinely different calls distinct.
  const executedCallCounts = new Map<string, number>();
  const canonicalJson = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(v) ?? "null";
  };
  // A pathologically nested / cyclic model-supplied `args` object can
  // RangeError inside `canonicalJson`'s recursion — that must not kill the
  // whole turn. Fall back to a per-call unique key (never collides, so the
  // call is treated as never-before-seen rather than falsely deduped).
  const canonicalCallKey = (
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ): string => {
    try {
      return `${name}:${canonicalJson(args)}`;
    } catch {
      return `${name}:__uncanonicalizable__:${callId}`;
    }
  };

  // WARP-642 review (FINDING 1) — `advertisedNames` never changes between
  // iterations, so a model that keeps naming an unknown tool every turn
  // (ignoring the UNKNOWN_TOOL recovery message) would otherwise run the
  // loop all the way to maxIter and return a blank reply with
  // stop_reason "iteration_limit" — the dashboard shows an empty message
  // with no explanation. We count iterations that ONLY hit the guard
  // (dispatched zero real tools) and break early once the model has
  // ignored the recovery path MAX_CONSECUTIVE_GUARD_HITS times in a row,
  // surfacing a real error instead.
  const MAX_CONSECUTIVE_GUARD_HITS = 3;
  let consecutiveGuardHits = 0;
  let lastBadToolName = "";
  // WARP-1529 — the breaker now has two feeders (a hallucinated name and a
  // §3-refused one). Carry WHY so the terminal error names the real problem;
  // an operator reading "unknown tool" for a tool that exists and is simply
  // not granted would chase the wrong bug.
  let lastBadToolReason: "unknown tool" | "forbidden tool" = "unknown tool";

  // WARP-329 — the result returned when the client disconnects mid-turn.
  // We don't emit a `done` event (the SSE consumer is gone) and the route
  // labels the persisted row "aborted" via its own `clientAborted` flag.
  //
  // WARP-1602 (review B1) — a torn-down STREAMED turn hands over whatever the
  // emitter salvaged, so the answer the user was already reading survives the
  // Stop button instead of being replaced by a blank row. `partial` is absent
  // for the two aborts that happen OUTSIDE the stream consumer (between
  // iterations, before a tool dispatch), where no buffer exists.
  const abortedResult = (
    iterations: number,
    partial: StreamTeardownPartial = NO_PARTIAL,
  ): AgentResult => teardownResult("client_aborted", iterations, partial);

  // WARP-1442 — SERVER-SIDE token streaming is used when the caller streams
  // (`onEvent` present, i.e. /api/llm/chat stream=true) AND a streaming
  // transport is injected. It emits content_delta INCREMENTALLY as the model
  // generates. Absent onEvent or chatStream → the blocking path below runs
  // byte-for-byte, so every non-streaming caller is unchanged.
  const useStream = Boolean(deps.onEvent && deps.aiGateway.chatStream);

  // WARP-1602 — the turn's reasoning trace, ONE entry per iteration that
  // produced any thinking, in arrival order. Intermediate (tool-call)
  // iterations used to be discarded entirely: their `reasoning_content` was
  // dropped and their `content` either leaked to the client (streaming) or was
  // swallowed into the transcript (blocking), which is why `reasoning` came
  // back NULL on every multi-iteration turn. This closes the WARP-495 part 2
  // deferral that WARP-1442's streaming was supposed to trigger.
  const reasoningSteps: string[] = [];
  // Chars of intermediate CONTENT (not channel reasoning) rerouted into the
  // trace — the polluted-turn diagnostics report it so an eval run can tell a
  // turn that quarantined analysis from one that never produced any.
  let quarantinedChars = 0;

  /**
   * WARP-1602 (review B1/B2) — the terminal for a turn that was torn down
   * (client abort, mid-stream transport death) rather than finished.
   *
   * Before this, both teardowns returned `content: ""` and dropped
   * `reasoningSteps`, so a Stop press or a dropped connection erased 100% of
   * the work — on a DEFERRED turn that included the entire partial answer,
   * which had never reached the wire and existed only in the emitter's buffer.
   *
   * What survives:
   *   - `partial.released` → the buffer was answer text and `settle()` has
   *     already emitted it as `content_delta`; it becomes `message.content`.
   *   - `!partial.released` with a non-empty buffer → this was a tool-call turn
   *     and the buffer is quarantined analysis, so it joins the reasoning trace
   *     instead. It must NEVER become `content` (that is the WARP-1602 bug).
   *   - `reasoningSteps` from earlier iterations, which `iteration_limit`
   *     already kept and only these two paths discarded.
   *
   * Declared after `reasoningSteps` so it closes over the live array; the
   * arrow bodies only run from inside the loop below.
   */
  const teardownResult = (
    error: "client_aborted" | "stream_interrupted",
    iterations: number,
    partial: StreamTeardownPartial,
  ): AgentResult => {
    // The reasoning trace is derived from the WHOLE buffer: closed
    // `<reasoning>` segments are deterministic, and the trace never goes on the
    // wire as answer text, so there is no volatile tail to hold back.
    const parsed = parseReasoningTrace({ content: partial.raw || null });
    const thisStep = [...parsed.reasoningSteps];
    if (!partial.released) {
      // Tool-call turn: the buffer is analysis. It joins the trace and must
      // never become `content` — that IS the WARP-1602 bug.
      const quarantined = sanitizeFinalContent(parsed.cleanedContent);
      if (quarantined) {
        thisStep.push(quarantined);
        quarantinedChars += quarantined.length;
      }
    }
    const steps = [...reasoningSteps];
    if (thisStep.length > 0) steps.push(thisStep.join("\n\n"));
    const reasoning =
      steps.length > 0 ? steps.join(REASONING_STEP_SEPARATOR) : null;
    return {
      message: {
        role: "assistant",
        // Exactly what went on the wire — NOT a re-parse of `raw`, which on a
        // teardown is longer than the released prefix (see `releasedContent`).
        content: partial.released ? partial.releasedContent : "",
        ...(reasoning != null ? { reasoning } : {}),
      },
      trace,
      iterations,
      stop_reason: "error",
      error,
      ...(steps.length > 0 ? { reasoningSteps: steps } : {}),
    };
  };

  for (let iter = 0; iter < maxIter; iter++) {
    // WARP-329 — bail before issuing another inference call if the client
    // already disconnected (e.g. during the previous iteration's tool work).
    if (req.signal?.aborted) return abortedResult(iter);

    // Spec §2 — token-aware iteration guard. chars/4 rounded up, matching
    // context-budget.service.ts; JSON.stringify over-counts (keys, escapes,
    // and any inlined image payloads), which only makes the guard fire
    // EARLIER than the true fill — conservative by construction.
    //
    // Estimates `JSON.stringify(messages).length` ONLY — the serialized tool
    // schemas are deliberately EXCLUDED. The route-side WARP-1118 estimator
    // (context-budget.service.ts, invoked from routes/llm.ts before this loop
    // ever starts) already budgets the FULL initial request — system blocks +
    // tool schemas + history — against the same window; this in-loop guard's
    // job is only to bound mid-turn TRANSCRIPT growth (tool results, nudges)
    // on top of that already-budgeted starting point. Measured reality: the
    // shipping 70-tool chat scope serializes to ~12k tokens of schemas alone,
    // so folding that back into THIS guard's threshold would leave next to no
    // transcript headroom at the 16k default window and cap every tool turn
    // at one iteration — the exact regression this comment exists to prevent
    // a future edit from reintroducing.
    if (
      iter > 0 &&
      finalizeReason === null &&
      toolChoice !== "none" &&
      estimateTokensFromChars(JSON.stringify(messages).length) >
        contextWindow - OUTPUT_RESERVE - ITERATION_MIN_HEADROOM
    ) {
      finalizeReason = "context_budget";
    }
    if (finalizeReason !== null) {
      messages.push({
        role: "system",
        content:
          finalizeReason === "repetition"
            ? "You are repeating tool calls — answer the user now from the information already gathered. Do not call any more tools."
            : "Context budget reached — answer the user now from the information already gathered. Do not call any more tools.",
      });
    }
    const iterTools = finalizeReason !== null ? [] : tools;
    const iterToolChoice: "auto" | "none" =
      finalizeReason !== null ? "none" : toolChoice;

    // The outbound request shared by both transports. `stream` is set per
    // path; every other field (incl. WARP-849 max_tokens + WARP-1442a
    // reasoning_effort) is identical, so a streamed turn issues byte-for-byte
    // the same request as a blocking one.
    const chatReq = {
      model: req.model,
      messages,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      reasoning_effort: req.reasoning_effort,
      tools: iterTools,
      tool_choice: iterToolChoice,
    };

    let asst: ChatMessage | null = null;
    // Streamed turns already emitted content_delta + reasoning_step during the
    // stream; the terminal finalize below must NOT re-emit them.
    let streamedTurn = false;
    // WARP-1602 — did the stream consumer already put text on the wire this
    // iteration? Only then must the intermediate-reasoning emission below hold
    // back, to avoid saying the same thing twice.
    let streamWireEmitted = false;
    // WARP-1602 — did the stream consumer already emit this turn's content AS
    // THE ANSWER? Gates the terminal `content_delta` below. Distinct from
    // `streamedTurn`: the finalize pass strips a rogue `tool_calls` AFTER the
    // consumer settled, so "streamed" and "content already on the wire as the
    // answer" are not the same question.
    let streamContentReleased = false;
    if (useStream) {
      try {
        const streamed = await consumeChatStream(
          // WARP-329 — the signal is threaded into the streaming read so a
          // client disconnect tears down the Ollama stream mid-generation.
          deps.aiGateway.chatStream!(chatReq, req.signal),
          {
            emit,
            captureReasoning: req.captureReasoning ?? false,
            signal: req.signal,
            // WARP-1602 — this iteration advertised tools, so it may still
            // resolve to `tool_calls`; hold its content until we know. An
            // iteration with ZERO tools (the finalize pass, tool_choice
            // "none", or a caller with an empty pool) cannot, so it keeps
            // streaming token-by-token exactly as WARP-1442 shipped it.
            deferContent: iterTools.length > 0,
          },
        );
        asst = streamed.asst;
        streamedTurn = true;
        streamWireEmitted = streamed.wireEmitted;
        streamContentReleased = streamed.contentReleased;
      } catch (err) {
        if (req.signal?.aborted || isAbortError(err)) {
          // WARP-1602 (review B1) — carry whatever the emitter salvaged. On a
          // DEFERRED turn this is the ONLY copy of the partial answer: nothing
          // reached the wire during the stream, so without it a Stop press
          // blanked the screen and persisted an empty row.
          //
          // WARP-1660 — off EITHER carrier: `req.signal` can flip after the
          // consumer already classified the failure as a transport death, so
          // an `AgentStreamPartialError` reaches this branch with a perfectly
          // good partial in it.
          return abortedResult(iter, teardownPartialOf(err));
        }
        if (err instanceof AgentStreamPartialError) {
          // The stream died AFTER partial content was emitted — falling back to
          // blocking would double the answer. Surface an honest error turn (the
          // same outcome a blocking connection death would reach) — but WITH
          // the partial answer, not blank (review B2).
          const error = "stream_interrupted";
          emit({ type: "done", iterations: iter, stop_reason: "error", error });
          return teardownResult(error, iter, err.partial);
        }
        // Stream failed BEFORE emitting anything (e.g. gateway non-200 at open)
        // — fall back to the blocking path so the turn still completes.
        // Streaming is additive, never a new failure mode.
        // eslint-disable-next-line no-console
        console.warn(
          "[agent] streaming chat failed, falling back to blocking:",
          err,
        );
      }
    }

    if (asst === null) {
      const gw = await deps.aiGateway.chat(
        { ...chatReq, stream: false },
        // WARP-329 — cancel the in-flight inference fetch on disconnect.
        req.signal,
      );
      if (!gw.ok) {
        const error = `ai-gateway ${gw.status ?? "error"}`;
        emit({ type: "done", iterations: iter, stop_reason: "error", error });
        return {
          message: { role: "assistant", content: "" },
          trace,
          iterations: iter,
          stop_reason: "error",
          error,
        };
      }
      const data = await gw.json();
      const choice = data.choices?.[0];
      lastFinishReason = choice?.finish_reason;
      lastUsage = data.usage;
      if (!choice) {
        emit({ type: "done", iterations: iter, stop_reason: "error", error: "no choice in response" });
        return {
          message: { role: "assistant", content: "" },
          trace,
          iterations: iter,
          stop_reason: "error",
          error: "no choice in response",
        };
      }
      asst = choice.message;
    }

    // Spec §2 — the finalize pass advertised zero tools; a model that still
    // emits tool_calls gets no second chance. Strip them so this turn takes
    // the terminal path (empty content lands in WARP-854's FAILED-turn path).
    if (finalizeReason !== null && asst.tool_calls?.length) {
      delete asst.tool_calls;
    }

    // Happy path: model produced a final answer with no more tool calls.
    if (!asst.tool_calls?.length) {
      // WARP-458 — extract `<reasoning>…</reasoning>` segments + the
      // provider-native reasoning field (if any). The captureReasoning
      // flag gates EMISSION on the wire; PARSING + the
      // `result.message.reasoning` write happen regardless so the
      // route layer can always persist to `ChatMessage.reasoning`
      // (lazy-load on demand without re-running inference).
      const reasoning = parseReasoningTrace({
        // Assistant responses are always plain text; guard the union anyway.
        content: typeof asst.content === "string" ? asst.content : null,
        providerReasoning: asst.reasoning_content ?? null,
      });
      // WARP-1442 — a streamed turn already emitted reasoning_step +
      // content_delta INCREMENTALLY during the stream; only the blocking path
      // emits them here at decode time. The parse + sanitize below still run
      // for BOTH paths so `message.content` / `message.reasoning` persist
      // identically (the streamed content_delta events sum to `visible`).
      if (req.captureReasoning && !streamedTurn) {
        // Spec §AC3: reasoning_step blocks land BEFORE the content_delta.
        for (const step of reasoning.reasoningSteps) {
          emit({ type: "reasoning_step", text: step });
        }
      }
      // WARP-1331 — finalisation guard: strip citation cruft; demote a
      // bare tool-args JSON "answer" to empty. Empty completions get NO
      // content_delta — WARP-854's error path (done error frame / FAILED
      // turn) is the owner of that case.
      const visible = sanitizeFinalContent(reasoning.cleanedContent);
      // WARP-1479 — a blank answer is a failed turn (the route rewrites it as
      // one); attribute WHY here, while the raw completion is still in hand.
      const blankDiagnostics = visible
        ? undefined
        : describeBlankAnswer({
            rawContent: typeof asst.content === "string" ? asst.content : null,
            cleanedContent: reasoning.cleanedContent,
            providerReasoning: asst.reasoning_content ?? null,
            parsedReasoningSteps: reasoning.reasoningSteps.length,
            toolCalls: trace.length,
            finishReason: lastFinishReason,
            usage: lastUsage,
          });
      // WARP-1602 — the inverse guard to WARP-1479's. A turn that answers
      // WITH its chain-of-thought must be attributable in eval runs instead of
      // scoring as healthy just because the bubble wasn't empty.
      const pollutedDiagnostics = describePollutedAnswer({
        visible,
        quarantinedSteps: reasoningSteps.length,
        quarantinedChars,
        transport: streamedTurn ? "streaming" : "blocking",
        toolCalls: trace.length,
      });
      // WARP-1602 — `streamContentReleased`, not `streamedTurn`: a streamed
      // turn whose content was QUARANTINED never reached the wire, so the
      // answer would silently vanish if the flag were merely "was streamed".
      if (visible && !(streamedTurn && streamContentReleased)) {
        emit({ type: "content_delta", text: visible });
      }
      emit({
        type: "done",
        iterations: iter + 1,
        stop_reason: finalizeReason ?? "model_done",
      });
      // Surface cleaned content + concatenated reasoning on the
      // returned ChatMessage so the route layer can persist.
      //
      // WARP-495: this is the canonical reasoning surface. `reasoning` (above)
      // is our parsed, structured trace; strip the raw provider passthrough
      // `reasoning_content` out of `...asst` so the same reasoning isn't exposed
      // twice on `result.message` — a public /api/llm/chat wart that confuses
      // downstream consumers.
      //
      // WARP-1602 (closes the WARP-495 part 2 deferral): the trace is no longer
      // this terminal turn ALONE. Every intermediate step's thinking was
      // captured on its way past, so `reasoning` now carries the whole turn —
      // steps in order, separated by REASONING_STEP_SEPARATOR so a renderer can
      // put the boundaries back (`reasoningSteps` carries the same list
      // unflattened for in-process consumers).
      const { reasoning_content: _reasoningContent, ...asstClean } = asst;
      const allReasoningSteps =
        reasoning.fullReasoning != null
          ? [...reasoningSteps, reasoning.fullReasoning]
          : reasoningSteps;
      const fullReasoning =
        allReasoningSteps.length > 0
          ? allReasoningSteps.join(REASONING_STEP_SEPARATOR)
          : null;
      const finalMessage: ChatMessage = {
        ...asstClean,
        content: visible,
        ...(fullReasoning != null ? { reasoning: fullReasoning } : {}),
      };
      return {
        message: finalMessage,
        trace,
        iterations: iter + 1,
        stop_reason: finalizeReason ?? "model_done",
        ...(allReasoningSteps.length > 0
          ? { reasoningSteps: allReasoningSteps }
          : {}),
        ...(blankDiagnostics ? { blankDiagnostics } : {}),
        ...(pollutedDiagnostics ? { pollutedDiagnostics } : {}),
      };
    }

    // WARP-1602 — this iteration resolved to tool_calls, so whatever it wrote
    // is thinking, not an answer: harmony analysis ("We need to answer…"), or
    // at best a commentary preamble. Both are reclassified into the reasoning
    // stream here — the ONE site that handles intermediate steps for both
    // transports (the stream consumer deliberately emitted nothing).
    //
    // Per the harmony spec analysis "has not been trained to the same safety
    // standards" and must never be shown as the answer; commentary preambles
    // ARE showable, but Ollama's OpenAI-compat stream collapses both into
    // `delta.content` with no channel marker, so — indistinguishable — they
    // are treated as reasoning, which is the safe classification.
    const stepTrace = parseReasoningTrace({
      content: typeof asst.content === "string" ? asst.content : null,
      providerReasoning: asst.reasoning_content ?? null,
    });
    const stepParts = [...stepTrace.reasoningSteps];
    // Reuse the answer sanitizer so bare tool-args JSON and citation cruft
    // don't land in the trace either — the same classifier, same verdict.
    const stepContent = sanitizeFinalContent(stepTrace.cleanedContent);
    if (stepContent) {
      stepParts.push(stepContent);
      quarantinedChars += stepContent.length;
    }
    if (stepParts.length > 0) {
      reasoningSteps.push(stepParts.join("\n\n"));
      // Wire emission stays gated on captureReasoning exactly like the
      // terminal turn's; `streamWireEmitted` suppresses a double-say on the
      // (zero-tools-advertised) turn where the emitter already streamed.
      if (req.captureReasoning && !streamWireEmitted) {
        for (const step of stepParts) {
          emit({ type: "reasoning_step", text: step });
        }
      }
    }

    // Otherwise: append the assistant's tool-call-issuing message
    // (required by the OpenAI protocol so role="tool" messages have a
    // parent), then dispatch every requested tool and feed results back.
    //
    // The raw `asst` (analysis included) stays in `messages`: harmony keeps
    // the chain-of-thought between tool calls WITHIN a turn, and the protocol
    // needs this message as the parent of the role="tool" replies. It is
    // dropped from the next turn because only `message.content` (terminal
    // only) is ever persisted as history.
    messages.push(asst);
    // Per-iteration tallies feeding the FINDING 1 circuit breaker: how many
    // calls this turn only hit the guard vs. actually dispatched a real tool.
    let iterGuardHits = 0;
    let iterRealDispatches = 0;
    for (const call of asst.tool_calls) {
      // WARP-329 — stop before dispatching any further tool once the client
      // has disconnected, so a mid-turn abort can't fire a (possibly write)
      // tool call against a caller who is already gone.
      if (req.signal?.aborted) return abortedResult(iter + 1);
      const args = safeParseArgs(call);

      // WARP-1529 (RBAC v2 T5) — enforcement point 2 of 2, and the one that
      // is actually a security boundary. Runs BEFORE the hallucinated-tool
      // guard so the refusal is decided on authorization, not on whether the
      // pool computation happened to advertise the tool: a stale client
      // shelf, a replayed tool_call, or any future caller that forgets to
      // narrow `allowed_tools` all stop here without reaching the MCP child.
      // Unregistered names deliberately fall THROUGH to the WARP-642 guard,
      // which answers them with the valid-tool list so the model can
      // self-correct.
      const denial = toolDispatchDenial(call.function.name, args, scoped);
      if (denial) {
        // No sanitising pass here (unlike FINDING 3 below): a denial only
        // fires for a name that IS in the tools-core catalog, so the string
        // reflected back to the model is one of the registry's own fixed
        // names, never model-authored text.
        lastBadToolName = call.function.name;
        lastBadToolReason = "forbidden tool";
        const denialError = { status: "error" as const, error: denial };
        trace.push({
          tool_call_id: call.id,
          tool: call.function.name,
          args,
          result: denialError,
        });
        emit({ type: "tool_result", id: call.id, ok: false, data: denialError });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(denialError).slice(0, 8000),
        });
        // Counted as a guard hit: a model that keeps re-issuing a refused
        // tool must still trip the FINDING 1 circuit breaker rather than
        // burning every iteration on the same denial.
        iterGuardHits++;
        continue;
      }

      // WARP-642 — hallucinated-tool guard. If the model named a tool that
      // was NOT advertised this turn, don't round-trip it to the MCP child
      // (which would answer with a bare "Unknown tool: X" that gives the
      // model no recovery signal). Instead, feed back an error that lists
      // the valid tool names so the model can re-issue the correct call on
      // a later iteration. This is what lets a model that guessed
      // `knowledge_base_search` self-correct to `search_content` instead of
      // wandering to a second unrelated tool. `tool_choice="none"` already
      // sends zero tools, so this branch never fires on greeting-style
      // turns (the model is given nothing to mis-name).
      if (!advertisedNames.has(call.function.name)) {
        if (fullPoolNames.has(call.function.name)) {
          // Spec §3 self-heal — a REAL pool tool that selection filtered
          // out. Expand its whole domain for the remaining iterations and
          // tell the model to retry: one lost iteration, not a failed turn.
          // Deliberately NOT counted as a guard hit (the model named a real
          // tool) and not a real dispatch either.
          const domain = domainOfTool(call.function.name);
          const domainNames = new Set(
            domain ? toolNamesForDomain(domain) : [call.function.name],
          );
          const keep = new Set([
            ...advertisedNames,
            call.function.name,
            ...domainNames,
          ]);
          tools = filtered.filter((t) => keep.has(t.name)).map(toSpec);
          advertisedNames = new Set(tools.map((t) => t.function.name));
          availableToolList = tools.map((t) => t.function.name).join(", ");
          const heal = {
            status: "error" as const,
            error: {
              code: "TOOL_NOW_AVAILABLE",
              message:
                `The tool '${call.function.name}' is now available. ` +
                `Call it again with the same arguments.`,
            },
          };
          trace.push({
            tool_call_id: call.id,
            tool: call.function.name,
            args,
            result: heal,
          });
          emit({ type: "tool_result", id: call.id, ok: false, data: heal });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(heal).slice(0, 8000),
          });
          continue;
        }
        // FINDING 3 (security) — `call.function.name` is model-controlled
        // (steerable via prompt injection) and a degenerate huge name could
        // bloat history. Sanitize before reflecting it into the
        // role="tool" reply, which the model reads next turn as trusted
        // tool output. The raw name stays in the operator-facing SSE
        // emit / trace below (not model-facing).
        const safeName = call.function.name.slice(0, 64).replace(/[^\w:.\-]/g, "_");
        lastBadToolName = safeName;
        lastBadToolReason = "unknown tool";
        const guardError = {
          status: "error" as const,
          error: {
            code: "UNKNOWN_TOOL",
            message:
              `Unknown tool: '${safeName}'. ` +
              (availableToolList
                ? `Call one of the available tools instead: ${availableToolList}.`
                : "No tools are available for this request."),
          },
        };
        const guardText = JSON.stringify(guardError);
        trace.push({
          tool_call_id: call.id,
          tool: call.function.name,
          args,
          result: guardError,
        });
        emit({
          type: "tool_result",
          id: call.id,
          ok: false,
          data: guardError,
        });
        // Feed the same envelope back to the model as the tool's reply so
        // the next iteration sees the valid-tool list and can self-correct.
        // Bound it with the same 8000-char cap as real tool results (below)
        // so a large advertised-tool list can't inflate next-turn context.
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: guardText.slice(0, 8000),
        });
        iterGuardHits++;
        continue;
      }

      // Spec §4 — occurrence 1 dispatches; 2 nudges; 3 finalizes. A nudged
      // call is neither a guard hit nor a real dispatch, so the WARP-642
      // circuit breaker is unaffected.
      const callKey = canonicalCallKey(call.function.name, args, call.id);
      const priorCalls = executedCallCounts.get(callKey) ?? 0;
      executedCallCounts.set(callKey, priorCalls + 1);
      if (priorCalls >= 1) {
        const nudge = {
          status: "error" as const,
          error: {
            code: "REPEATED_CALL",
            message:
              `You already called '${call.function.name}' with these exact ` +
              `arguments; its result is in the conversation above. Use that ` +
              `result or answer the user — do not repeat the call.`,
          },
        };
        trace.push({
          tool_call_id: call.id,
          tool: call.function.name,
          args,
          result: nudge,
        });
        emit({ type: "tool_result", id: call.id, ok: false, data: nudge });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(nudge).slice(0, 8000),
        });
        if (priorCalls >= 2) {
          finalizeReason = finalizeReason ?? "repetition";
        }
        continue;
      }

      // FINDING 2 — emit the tool_call chip only AFTER the guard passes, so
      // guard-rejected (never-dispatched) calls don't render a misleading
      // chip on the dashboard. Guard hits still surface via their own
      // tool_result with ok=false above.
      iterRealDispatches++;
      emit({ type: "tool_call", id: call.id, name: call.function.name, args });

      // WARP-437 — adaptive routing. For `search_content` calls we
      // classify the query, derive a per-class preset, pre-compute any
      // HyDE / multi-query embeddings, and attach the result via
      // `_meta._enhancement` (NOT as a tool argument — the tool's input
      // schema rejects unknown properties). Failures fall through to the
      // baseline tool call so a flaky classifier / embedder can never
      // block retrieval.
      let toolContext = req.toolCallContext;
      if (call.function.name === "search_content" && deps.enhancement) {
        toolContext = await resolveSearchEnhancement(
          deps.enhancement,
          args,
          req.toolCallContext,
        );
      }

      // ORCH-05 — a *thrown* tool dispatch (stdio hiccup, child-process
      // blip, or a handler that throws instead of returning
      // `{isError:true}`) must NOT abort the whole turn. Catch it, feed a
      // bounded structured error back to the model as a normal tool
      // result, and let the loop continue so the model can recover or
      // finalize. The `maxIter` cap still bounds a persistently-failing
      // tool. Tool-*reported* failures (`result.isError`) already flow
      // through the normal path below — this only adds the throw path.
      let result: McpToolCallResult;
      try {
        result = await deps.mcp.callTool(call.function.name, args, toolContext);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "tool_dispatch_failed",
                tool: call.function.name,
                message: message.slice(0, 500),
              }),
            },
          ],
        };
      }
      const text = result.content[0]?.text ?? "{}";
      // WARP-1604 — single parse point for the tool-result wire payload.
      // `payload` carries the mcp-server contract in its type (see
      // services/tool-result-payload.ts); `parsed` is the same value widened
      // for the existing untyped consumers (SSE event, trace).
      const payload = parseToolResultPayload(text);
      const parsed: unknown = toolResultPayloadValue(payload);
      trace.push({ tool_call_id: call.id, tool: call.function.name, args, result: parsed });

      // WARP-1480 — the ONE point that sees every tool failure, on BOTH the
      // streaming and non-streaming paths. Until now nothing in this repo had
      // ever LOGGED a tool failure (`result.isError` was only ever read, below,
      // to shape the SSE event and gate citation extraction), which is why
      // `read_file`'s intermittent error burns the iteration budget
      // unattributed. `confirmation_required` is excluded for free: mcp-server
      // sets `isError` only for `status === "error"`.
      if (result.isError) {
        logger.warn(
          describeToolError({
            tool: call.function.name,
            toolCallId: call.id,
            turnId,
            iter,
            args,
            payload,
            includeExcerpt: config.AGENT_BLANK_TURN_DEBUG,
            threadId: req.citationContext?.threadId,
          }),
          "agent_tool_error",
        );
      }

      // Translate the MCP envelope into an SSE tool_result event.
      // confirmation_required is NOT a hard error — surface ok=true so
      // the dashboard renders it as a "needs approval" chip rather than
      // a red failure. The status/message fields drive the UX label.
      const isConfirmation =
        parsed !== null &&
        typeof parsed === "object" &&
        "status" in (parsed as Record<string, unknown>) &&
        (parsed as { status: string }).status === "confirmation_required";
      const evt: Extract<SSEEvent, { type: "tool_result" }> = {
        type: "tool_result",
        id: call.id,
        ok: isConfirmation ? true : !result.isError,
      };
      if (isConfirmation) {
        evt.status = "confirmation_required";
        const errObj = (parsed as {
          error?: { message?: string; details?: unknown };
        }).error;
        evt.message =
          typeof errObj?.message === "string" ? errObj.message : undefined;
        // WARP-640 — if the tool surfaced a one-click re-issue token (e.g.
        // run_scene returns { type, sceneId, confirmationToken }), forward it so
        // the dashboard chip can render an "Approve & run" button that completes
        // the action. Tools without a token (firewall etc.) omit this and the
        // chip stays display-only.
        const details = errObj?.details as
          | { type?: string; sceneId?: string; confirmationToken?: string }
          | undefined;
        if (details && typeof details.confirmationToken === "string") {
          evt.confirmation = {
            kind: typeof details.type === "string" ? details.type : "generic",
            sceneId:
              typeof details.sceneId === "string" ? details.sceneId : undefined,
            confirmationToken: details.confirmationToken,
          };
        }
      } else {
        evt.data = parsed;
      }
      emit(evt);

      // WARP-473 — fire-and-forget citation enqueue. We extract file
      // paths from the parsed result here (rather than after the tool
      // loop) so a single helper call captures every result this turn.
      // `deps.citation.enqueue` MUST NOT await — see CitationDeps.
      if (deps.citation && req.citationContext && !result.isError) {
        const paths = extractCitedFilePaths(payload);
        if (paths.length > 0) {
          deps.citation.enqueue(paths, req.citationContext);
        } else if (!isConfirmation && isRetrievalClassTool(call.function.name)) {
          // WARP-1604 backstop. A retrieval-class tool that succeeded but
          // yielded no citable path is almost always the payload contract
          // drifting again (the whole citation trail then dies silently,
          // with no error anywhere). Debug-level: a genuinely empty search
          // or an empty directory hits this legitimately, so it must not
          // be noise at info/warn.
          logger.debug(
            {
              tool: call.function.name,
              threadId: req.citationContext.threadId,
              messageId: req.citationContext.messageId,
            },
            "retrieval-class tool succeeded with zero citable paths — no FileCitation row written (check the mcp-server ↔ extractor payload contract if persistent)",
          );
        }
      }

      // Bound the tool result we feed back to the model so one giant
      // payload doesn't blow the next-turn context window.
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: text.slice(0, 8000),
      });
    }

    // FINDING 1 — circuit breaker. A turn that only hit the hallucinated-tool
    // guard (zero real dispatches) means the model ignored the recovery
    // message; count those consecutively. Any real dispatch means the model
    // is making progress, so reset. Once the model has wasted
    // MAX_CONSECUTIVE_GUARD_HITS turns in a row, stop early with an error
    // rather than silently burning the rest of maxIter and returning blank.
    if (iterGuardHits > 0 && iterRealDispatches === 0) {
      consecutiveGuardHits++;
    } else if (iterRealDispatches > 0) {
      consecutiveGuardHits = 0;
    }
    if (consecutiveGuardHits >= MAX_CONSECUTIVE_GUARD_HITS) {
      const error = `model repeatedly called ${lastBadToolReason}: ${lastBadToolName}`;
      emit({ type: "done", iterations: iter + 1, stop_reason: "error", error });
      return {
        message: { role: "assistant", content: "" },
        trace,
        iterations: iter + 1,
        stop_reason: "error",
        error,
      };
    }
  }

  // WARP-1012 — honest fallback instead of a blank reply. Reaching this
  // exit means every iteration ended in tool_calls, so no content_delta was
  // ever emitted (only the model_done path above emits one) and the
  // persisted assistant message would otherwise be EMPTY — the customer
  // sees a blank answer (live repro: search_files/list_recent_files kept
  // failing, the model burned all iterations retrying, stop_reason
  // "iteration_limit", empty bubble). Tell the customer what happened in
  // plain language. stop_reason stays "iteration_limit" so operators and
  // the trace keep the real signal; only the visible content changes.
  const failedTools = [
    ...new Set(
      trace
        .filter((t) => {
          const r = t.result as
            | { status?: unknown; ok?: unknown; error?: unknown }
            | null
            | undefined;
          if (r === null || typeof r !== "object") return false;
          // Spec §4 — a REPEATED_CALL nudge means the call was never
          // re-dispatched this turn (its prior result already succeeded);
          // it must not read as "the tool kept failing".
          if (
            typeof r.error === "object" &&
            r.error !== null &&
            (r.error as { code?: unknown }).code === "REPEATED_CALL"
          ) {
            return false;
          }
          // Spec §3 — a TOOL_NOW_AVAILABLE heal means selection filtered the
          // tool out; it was never actually dispatched, so it must not read
          // as "the tool kept failing" either.
          if (
            typeof r.error === "object" &&
            r.error !== null &&
            (r.error as { code?: unknown }).code === "TOOL_NOW_AVAILABLE"
          ) {
            return false;
          }
          // Handler envelopes report status:"error" / ok:false; the
          // dispatch-throw path (ORCH-05) reports a string `error`.
          // confirmation_required is a UX pause, not a failure.
          return (
            r.status === "error" ||
            r.ok === false ||
            typeof r.error === "string"
          );
        })
        .map((t) => t.tool),
    ),
  ];
  // WARP-1331 — trace tool names are model-controlled: the model invents
  // garbled names ("memory_repay??", "search_content?") that the guard
  // records as failures, and interpolating them verbatim put nonsense tools
  // in customer-facing copy. Only registry-advertised names may be named;
  // failures on invented tools get the generic phrasing.
  const knownFailedTools = failedTools.filter((n) => advertisedNames.has(n));
  const fallbackText =
    knownFailedTools.length > 0
      ? `I ran into a problem while working on that — the ${knownFailedTools.join(
          ", ",
        )} tool${knownFailedTools.length > 1 ? "s" : ""} kept failing, so I couldn't finish your request. Please try again in a moment.`
      : failedTools.length > 0
        ? "I ran into a problem while working on that — one of my tools kept failing, so I couldn't finish your request. Please try again in a moment."
        : "I couldn't finish working through that request within my step limit. Please try again, or ask for a smaller piece of it.";
  emit({ type: "content_delta", text: fallbackText });
  emit({ type: "done", iterations: maxIter, stop_reason: "iteration_limit" });
  return {
    message: {
      role: "assistant",
      content: fallbackText,
      // WARP-1602 — every iteration here ended in tool_calls, so the ONLY
      // record of what the model was thinking is the quarantined trace.
      // Persist it rather than throwing away the whole turn's reasoning.
      ...(reasoningSteps.length > 0
        ? { reasoning: reasoningSteps.join(REASONING_STEP_SEPARATOR) }
        : {}),
    },
    trace,
    iterations: maxIter,
    stop_reason: "iteration_limit",
    ...(reasoningSteps.length > 0 ? { reasoningSteps } : {}),
  };
}

// WARP-1331 — model_done finalisation guard. Strips harmony citation
// cruft and demotes bare tool-args JSON to an EMPTY completion. It never
// invents prose: WARP-854 owns the empty-completion contract (done error
// frame on stream, FAILED persisted turn) and an earlier fallback here
// masked that signal — CI's WARP-854 tests are the pin.
/** gpt-oss leaks harmony-style citation tokens (`【3†source=…】`) into
 *  otherwise-correct answers — strip the tokens, keep the prose. Shared with
 *  the WARP-1479 diagnostics so both classify the same string. */
function stripPresentationCruft(raw: string | null): string {
  return (raw ?? "")
    .replace(/【[^】]*】/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function sanitizeFinalContent(raw: string | null): string {
  const stripped = stripPresentationCruft(raw);
  if (!stripped) return "";
  // A final answer that IS a bare JSON object/array is tool-call arguments
  // the loop failed to route — a failed turn, not prose. Empty routes it
  // into the WARP-854 error path. Fenced or inline JSON inside a sentence
  // doesn't parse here and passes through untouched.
  if (isBareJson(stripped)) return "";
  return stripped;
}

/** True when `s` is a bare JSON object/array — tool-call arguments the loop
 *  failed to route, not prose. Shared by the sanitizer and the WARP-1479
 *  diagnostics so the two can never disagree about what "demoted" means. */
function isBareJson(s: string): boolean {
  if (!/^[[{]/.test(s)) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * WARP-1479 — attribute a blank terminal answer to its layer. Pure; called
 * only when the sanitized answer is empty.
 */
function describeBlankAnswer(args: {
  rawContent: string | null;
  cleanedContent: string;
  providerReasoning: string | null;
  parsedReasoningSteps: number;
  toolCalls: number;
  finishReason?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}): BlankAnswerDiagnostics {
  const raw = args.rawContent ?? "";
  // "Did the model write anything at all" is asked of the UNstripped text;
  // "what did the sanitizer judge" is asked of the stripped text. Asking
  // both of the same string would misfile a citation-token-only answer as
  // an empty one.
  const wroteSomething = args.cleanedContent.trim().length > 0;
  const asSanitizerSawIt = stripPresentationCruft(args.cleanedContent);
  const providerReasoning = args.providerReasoning ?? "";
  const cause: BlankAnswerDiagnostics["cause"] = !wroteSomething
    ? // Nothing survived reasoning extraction: either the model spent the
      // turn in its reasoning channel, or it truly returned nothing.
      providerReasoning.trim() || args.parsedReasoningSteps > 0
      ? "reasoning_only"
      : "model_returned_nothing"
    : // Content existed and OUR sanitizer emptied it.
      isBareJson(asSanitizerSawIt)
      ? "sanitizer_demoted_json"
      : "sanitizer_stripped_all";
  return {
    rawContentChars: raw.length,
    cleanedChars: args.cleanedContent.length,
    visibleChars: 0,
    providerReasoningChars: providerReasoning.length,
    parsedReasoningSteps: args.parsedReasoningSteps,
    toolCalls: args.toolCalls,
    cause,
    ...(config.AGENT_BLANK_TURN_DEBUG && raw
      ? { rawExcerpt: raw.slice(0, 500) }
      : {}),
    ...(args.finishReason !== undefined
      ? { finishReason: args.finishReason }
      : {}),
    ...(args.usage?.prompt_tokens !== undefined
      ? { promptTokens: args.usage.prompt_tokens }
      : {}),
    ...(args.usage?.completion_tokens !== undefined
      ? { completionTokens: args.usage.completion_tokens }
      : {}),
  };
}

/**
 * WARP-1602 — analysis-leak heuristics for the VISIBLE answer.
 *
 * Deliberately narrow and anchored: each pattern describes prose the model
 * writes to ITSELF, not to the customer. They are diagnostics, never a filter
 * — nothing is rewritten or suppressed on a match, so a false positive costs
 * one log line and an eval label, never a lost answer.
 *
 * `step_join_run_on` is the signature the live .87 row carried: per-iteration
 * analysis fragments concatenated with no separator, so a sentence ends and
 * the next fragment starts immediately ("…list files.Let's read csv.You
 * spent…"). It is the one marker that proves CONCATENATION rather than a
 * single leaked analysis block.
 */
const ANALYSIS_LEAK_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["first_person_plan", /^\s*(?:we|i)\s+(?:need|should|must|have)\s+to\b/i],
  ["user_framing", /^\s*(?:the\s+)?user\s+(?:is\s+)?(?:asking|wants|said|means)\b/i],
  // Deliberately NOT a bare `^let's` — a helpful answer legitimately opens
  // "Let's go through them one by one." Only the retrieval verbs the model
  // uses when narrating its own plan count.
  [
    "lets_investigate_prefix",
    /^\s*let'?s\s+(?:look|check|see|read|list|search|find|open|start by|think|figure)\b/i,
  ],
  ["deliberation_prefix", /^\s*(?:ok|okay|alright|so|hmm)[,.]?\s+(?:let'?s|we|i|the user)\b/i],
  ["likely_hedge", /^\s*likely\s+(?:refers|means|the)\b/i],
  ["channel_label", /^\s*(?:analysis|assistantanalysis|commentary)\b/i],
  ["harmony_control_token", /<\|(?:channel|start|end|message)\|>/],
  ["step_join_run_on", /[a-z]{2}\.(?:Let'?s|We\s|I\s|The user|You\s|Now\s)/],
];

/**
 * WARP-1602 — attribute an answer that still looks like chain-of-thought.
 * Pure. Returns `undefined` for a healthy turn so the field (and the log line
 * behind it) is absent unless something actually fired — the same contract
 * WARP-1479's blank diagnostics follow.
 */
function describePollutedAnswer(args: {
  visible: string;
  quarantinedSteps: number;
  quarantinedChars: number;
  transport: "streaming" | "blocking";
  toolCalls: number;
}): PollutedAnswerDiagnostics | undefined {
  const visible = args.visible;
  // A blank answer is WARP-1479's case, not this one; don't file it twice.
  if (!visible.trim()) return undefined;
  const markers = ANALYSIS_LEAK_MARKERS.filter(([, re]) => re.test(visible)).map(
    ([name]) => name,
  );
  if (markers.length === 0) return undefined;
  return {
    markers,
    visibleChars: visible.length,
    quarantinedSteps: args.quarantinedSteps,
    quarantinedChars: args.quarantinedChars,
    transport: args.transport,
    toolCalls: args.toolCalls,
    ...(config.AGENT_BLANK_TURN_DEBUG
      ? { rawExcerpt: visible.slice(0, 500) }
      : {}),
  };
}

/**
 * WARP-437 — classify the query, derive a preset, pre-compute HyDE +
 * multi-query embeddings, and return a fresh `McpCallContext` carrying
 * the resulting `_enhancement` bundle. Any failure (classifier
 * unreachable, embedder down, malformed LLM output) is swallowed and we
 * return the original context unchanged: retrieval MUST never be blocked
 * by an enhancement-side problem.
 */
async function resolveSearchEnhancement(
  enhancement: EnhancementDeps,
  args: Record<string, unknown>,
  baseContext: McpCallContext | undefined,
): Promise<McpCallContext | undefined> {
  const query = String(args.query ?? "").trim();
  if (query.length < 2) return baseContext;
  try {
    const { cls } = await enhancement.classify(query);
    const preset = presetForClass(cls, query);

    // Merge LLM-emitted `enhance` (highest precedence — model can opt
    // in explicitly) with the class preset. The LLM's `enhance` lives
    // on the args; the orchestrator-injected vectors live on
    // `_enhancement`. Both feed `searchHybrid`.
    const llmEnhance = (args as Record<string, unknown>).enhance as
      | { hyde?: boolean; multiQuery?: boolean; n?: number }
      | undefined;
    const effective = {
      hyde: llmEnhance?.hyde ?? preset.enhance?.hyde ?? false,
      multiQuery: llmEnhance?.multiQuery ?? preset.enhance?.multiQuery ?? false,
      n: llmEnhance?.n ?? preset.enhance?.n ?? 3,
    };

    let hydeVector: number[] | undefined;
    let extraQueryVectors: number[][] | undefined;
    if (effective.hyde) {
      const passage = await enhancement.hyde(query);
      const embeddings = await enhancement.embed([passage]);
      hydeVector = embeddings[0];
    }
    if (effective.multiQuery) {
      const rewrites = await enhancement.multiQuery(query, effective.n);
      if (rewrites.length > 0) {
        extraQueryVectors = await enhancement.embed(rewrites);
      }
    }

    const privateEnhancement: PrivateEnhancement = {
      hydeVector,
      extraQueryVectors,
      metadataFilter: preset.filenameContains
        ? { filenameContains: preset.filenameContains }
        : undefined,
      searchOverrides: preset.searchOverrides,
    };
    return { ...baseContext, _enhancement: privateEnhancement };
  } catch (e) {
    // Enhancement failure must NEVER block retrieval. Log at warn for
    // post-hoc debugging; fall through with the unmodified context.
    console.warn("[agent] enhancement failed, falling back to baseline:", e);
    return baseContext;
  }
}

function safeParseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * WARP-1604 — tools whose successful result is expected to name at least
 * one file. Used only by the zero-path backstop log below; extraction
 * itself is shape-driven, not name-driven, so adding a tool here can never
 * change which paths get cited.
 */
const RETRIEVAL_CLASS_TOOLS = new Set([
  "read_file",
  "search_content",
  "search_files",
  "list_files",
  "list_recent_files",
]);

function isRetrievalClassTool(name: string): boolean {
  return RETRIEVAL_CLASS_TOOLS.has(name);
}

/**
 * WARP-473 — extract file paths from a tool-result wire payload.
 *
 * WARP-1604: the keys live at the **ROOT** of the payload, not under
 * `data`. mcp-server unwraps the `ToolResult` envelope before it hits the
 * wire (`JSON.stringify(result.data)`), so what arrives here is the
 * handler's own object — and for one tool it is not an object at all:
 *   - a bare `[…]`        — list_files. Its handler returns the orchestrator
 *                           directory route's body verbatim, and that route
 *                           `res.json(entries)` with a bare `FileEntryInfo[]`
 *                           on all three of its branches (cache hit, normal,
 *                           and the `handleFileError(…, [])` degrade).
 *   - `path`              — read_file, write_file, move_file, …
 *   - `results[].path`    — search_content hits
 *   - `items[].path`      — search_files, list_recent_files
 *   - `files[].path`      — kept for any handler that wraps a listing
 *
 * The bare-array case is why `list_files` — the highest-frequency file tool
 * in the agent loop — still wrote ZERO rows after the envelope fix: an array
 * passes the `typeof === "object"` guard, but every key read off it is
 * `undefined`. The original review of this PR caught it because the test
 * asserted a `{ files: [...] }` shape `list_files` has never emitted.
 *
 * This function used to walk `data.*`, which is always `undefined` on the
 * real wire — it returned `[]` for every successful call and the whole
 * `FileCitation` trail was dead. The parameter type is the branded
 * `ToolResultPayload` precisely so a caller (including a test) cannot hand
 * it a hand-built envelope again; see services/tool-result-payload.ts.
 *
 * Anything outside these shapes is ignored — no path-finding by
 * regex across arbitrary text. Bounded to 20 paths per result so a
 * list_files on a giant directory can't enqueue thousands of rows.
 *
 * WARP-1656 — one exception to "shape only, never semantics": an entry
 * that explicitly carries a truthy `isDirectory` is skipped. A listing is
 * a `FileEntryInfo[]` in which folders are elements exactly like files, so
 * without this a folder became a `FileCitation` row — inert for the
 * related-chats reverse index, and, far worse, it spent one of the 20
 * slots a real file needed. The cap is silent, so the loss presented as
 * "Related chats is missing entries" with nothing in the logs.
 *
 * This is still a shape check — does the entry carry this field at all? —
 * not an interpretation of the payload, and it is a no-op for every shape
 * that never carries the field (read_file, search_content hits, …). The
 * skip happens BEFORE `push`, so a directory never charges the cap.
 *
 * The function is exported for direct testing.
 */
export function extractCitedFilePaths(payload: ToolResultPayload): string[] {
  const root: unknown = toolResultPayloadValue(payload);
  if (typeof root !== "object" || root === null) return [];

  const out: string[] = [];
  const push = (val: unknown) => {
    if (typeof val === "string" && val.length > 0 && out.length < 20) {
      out.push(val);
    }
  };
  const isDirectoryEntry = (item: object): boolean =>
    "isDirectory" in item && Boolean((item as { isDirectory?: unknown }).isDirectory);
  const pushFrom = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (
        item &&
        typeof item === "object" &&
        "path" in item &&
        !isDirectoryEntry(item)
      ) {
        push((item as { path?: unknown }).path);
      }
      if (out.length >= 20) return;
    }
  };

  // A bare array IS the payload (list_files). Checked first because an array
  // also satisfies the object guard above, and none of the keyed reads below
  // can ever hit on one.
  if (Array.isArray(root)) {
    pushFrom(root);
    return Array.from(new Set(out));
  }

  const d = root as {
    path?: unknown;
    results?: unknown;
    files?: unknown;
    items?: unknown;
    isDirectory?: unknown;
  };
  if (!isDirectoryEntry(d)) push(d.path);
  pushFrom(d.results);
  pushFrom(d.files);
  pushFrom(d.items);
  // De-dup within the same tool result so one path cited twice doesn't
  // produce two rows.
  return Array.from(new Set(out));
}
