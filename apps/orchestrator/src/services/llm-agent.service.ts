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

import type {
  McpCallContext,
  McpClientService,
} from "./mcp-client.service.js";
import type { ChatMessage, ChatResponse, ToolCall } from "../types/index.js";
import type { SSEEvent } from "../types/sse-events.js";

export interface AgentDeps {
  mcp: McpClientService;
  aiGateway: {
    chat: (req: {
      model: string;
      messages: ChatMessage[];
      stream?: boolean;
      temperature?: number;
      tools?: {
        type: "function";
        function: { name: string; description: string; parameters: Record<string, unknown> };
      }[];
      tool_choice?: "auto" | "none";
    }) => Promise<{ ok: boolean; status?: number; json: () => Promise<ChatResponse> }>;
  };
  onEvent?: (e: SSEEvent) => void;
}

export interface AgentRequest {
  model: string;
  messages: ChatMessage[];
  max_iter?: number;
  temperature?: number;
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
  const filtered = req.allowed_tools?.length
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

  for (let iter = 0; iter < maxIter; iter++) {
    const gw = await deps.aiGateway.chat({
      model: req.model,
      messages,
      stream: false,
      temperature: req.temperature,
      tools,
      tool_choice: toolChoice,
    });
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
        content: asst.content ?? null,
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
    for (const call of asst.tool_calls) {
      const args = safeParseArgs(call);
      emit({ type: "tool_call", id: call.id, name: call.function.name, args });
      const result = await deps.mcp.callTool(
        call.function.name,
        args,
        req.toolCallContext,
      );
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
        const errObj = (parsed as { error?: { message?: string } }).error;
        evt.message = typeof errObj?.message === "string" ? errObj.message : undefined;
      } else {
        evt.data = parsed;
      }
      emit(evt);

      // Bound the tool result we feed back to the model so one giant
      // payload doesn't blow the next-turn context window.
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: text.slice(0, 8000),
      });
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
