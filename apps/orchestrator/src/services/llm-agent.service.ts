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
  /**
   * WARP-437 — when present, the agent loop classifies every
   * `search_content` query and pre-computes HyDE + multi-query embeddings
   * based on the resulting class preset. When absent (the default), the
   * loop dispatches `search_content` unchanged — no enhancement,
   * byte-for-byte the pre-WARP-437 behaviour. Enhancement failures NEVER
   * propagate; the loop falls through to the baseline tool call.
   */
  enhancement?: EnhancementDeps;
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
      if (asst.content) emit({ type: "content_delta", text: asst.content });
      emit({ type: "done", iterations: iter + 1, stop_reason: "model_done" });
      return { message: asst, trace, iterations: iter + 1, stop_reason: "model_done" };
    }

    // Otherwise: append the assistant's tool-call-issuing message
    // (required by the OpenAI protocol so role="tool" messages have a
    // parent), then dispatch every requested tool and feed results back.
    messages.push(asst);
    for (const call of asst.tool_calls) {
      const args = safeParseArgs(call);
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

      const result = await deps.mcp.callTool(
        call.function.name,
        args,
        toolContext,
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
