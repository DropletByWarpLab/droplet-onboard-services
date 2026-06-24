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
 * Iteration cap: default 5, hard max 10 — a confused or prompt-injected
 * model can't burn unbounded tokens.
 */

import type { PrivateEnhancement } from "@droplet/tools-core";

import type {
  McpCallContext,
  McpClientService,
  ToolCallResult as McpToolCallResult,
} from "./mcp-client.service.js";
import type { ChatMessage, ChatResponse, ToolCall } from "../types/index.js";
import type { SSEEvent } from "../types/sse-events.js";
import type { QueryClass } from "../types/query-enhancement.js";

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
}

export interface AgentTraceEntry {
  tool_call_id: string;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface AgentResult {
  message: ChatMessage;
  trace: AgentTraceEntry[];
  iterations: number;
  stop_reason: "model_done" | "iteration_limit" | "error";
  error?: string;
}

const DEFAULT_MAX_ITER = 5;

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

export async function runAgent(deps: AgentDeps, req: AgentRequest): Promise<AgentResult> {
  const maxIter = Math.max(1, Math.min(req.max_iter ?? DEFAULT_MAX_ITER, 10));
  const trace: AgentTraceEntry[] = [];
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
  // Distinguish `undefined` (no restriction → every tool) from an explicit
  // empty array (caller asked for ZERO tools). Truthiness on `.length`
  // would conflate the two and silently advertise the full registry for an
  // intentional `allowed_tools: []`.
  const filtered = req.allowed_tools
    ? allTools.filter((t) => req.allowed_tools!.includes(t.name))
    : allTools;
  const tools = filtered.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
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
  const advertisedNames = new Set(tools.map((t) => t.function.name));
  const availableToolList = tools.map((t) => t.function.name).join(", ");

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

  // WARP-329 — the result returned when the client disconnects mid-turn.
  // We don't emit a `done` event (the SSE consumer is gone) and the route
  // labels the persisted row "aborted" via its own `clientAborted` flag.
  const abortedResult = (iterations: number): AgentResult => ({
    message: { role: "assistant", content: "" },
    trace,
    iterations,
    stop_reason: "error",
    error: "client_aborted",
  });

  for (let iter = 0; iter < maxIter; iter++) {
    // WARP-329 — bail before issuing another inference call if the client
    // already disconnected (e.g. during the previous iteration's tool work).
    if (req.signal?.aborted) return abortedResult(iter);
    const gw = await deps.aiGateway.chat(
      {
        model: req.model,
        messages,
        stream: false,
        temperature: req.temperature,
        // WARP-849 — forward the caller's completion budget (previously
        // dropped here, making the wizard probe's max_tokens a no-op).
        max_tokens: req.max_tokens,
        tools,
        tool_choice: toolChoice,
      },
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
    const asst = choice.message;

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
      if (req.captureReasoning) {
        // Spec §AC3: reasoning_step blocks land BEFORE the content_delta.
        for (const step of reasoning.reasoningSteps) {
          emit({ type: "reasoning_step", text: step });
        }
      }
      const visible = reasoning.cleanedContent;
      if (visible) emit({ type: "content_delta", text: visible });
      emit({ type: "done", iterations: iter + 1, stop_reason: "model_done" });
      // Surface cleaned content + concatenated reasoning on the
      // returned ChatMessage so the route layer can persist.
      const finalMessage: ChatMessage = {
        ...asst,
        content: visible,
        ...(reasoning.fullReasoning != null
          ? { reasoning: reasoning.fullReasoning }
          : {}),
      };
      return {
        message: finalMessage,
        trace,
        iterations: iter + 1,
        stop_reason: "model_done",
      };
    }

    // Otherwise: append the assistant's tool-call-issuing message
    // (required by the OpenAI protocol so role="tool" messages have a
    // parent), then dispatch every requested tool and feed results back.
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
        // FINDING 3 (security) — `call.function.name` is model-controlled
        // (steerable via prompt injection) and a degenerate huge name could
        // bloat history. Sanitize before reflecting it into the
        // role="tool" reply, which the model reads next turn as trusted
        // tool output. The raw name stays in the operator-facing SSE
        // emit / trace below (not model-facing).
        const safeName = call.function.name.slice(0, 64).replace(/[^\w:.\-]/g, "_");
        lastBadToolName = safeName;
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      trace.push({ tool_call_id: call.id, tool: call.function.name, args, result: parsed });

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
        const paths = extractCitedFilePaths(parsed);
        if (paths.length > 0) {
          deps.citation.enqueue(paths, req.citationContext);
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
      const error = `model repeatedly called unknown tool: ${lastBadToolName}`;
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

  emit({ type: "done", iterations: maxIter, stop_reason: "iteration_limit" });
  return {
    message: { role: "assistant", content: "" },
    trace,
    iterations: maxIter,
    stop_reason: "iteration_limit",
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
 * WARP-473 — extract file paths from a parsed tool result.
 *
 * Heuristic walker that covers every file-shaped result the registry
 * emits today:
 *   - `data.path`              — read_file, write_file, move_file, …
 *   - `data.results[].path`    — search_content hits
 *   - `data.files[].path`      — list_files, list_recent_files
 *   - `data.items[].path`      — older listings
 *
 * Anything outside these shapes is ignored — no path-finding by
 * regex across arbitrary text. Bounded to 20 paths per result so a
 * list_files on a giant directory can't enqueue thousands of rows.
 *
 * The function is exported for direct testing.
 */
export function extractCitedFilePaths(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const root = parsed as { data?: unknown };
  const data = root.data;
  if (typeof data !== "object" || data === null) return [];

  const out: string[] = [];
  const push = (val: unknown) => {
    if (typeof val === "string" && val.length > 0 && out.length < 20) {
      out.push(val);
    }
  };
  const pushFrom = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (item && typeof item === "object" && "path" in item) {
        push((item as { path?: unknown }).path);
      }
      if (out.length >= 20) return;
    }
  };

  const d = data as { path?: unknown; results?: unknown; files?: unknown; items?: unknown };
  push(d.path);
  pushFrom(d.results);
  pushFrom(d.files);
  pushFrom(d.items);
  // De-dup within the same tool result so one path cited twice doesn't
  // produce two rows.
  return Array.from(new Set(out));
}
