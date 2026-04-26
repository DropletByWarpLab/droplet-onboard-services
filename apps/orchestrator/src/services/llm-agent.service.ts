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

import type { McpClientService } from "./mcp-client.service.js";
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
  const allTools = await deps.mcp.listTools();
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
      tool_choice: "auto",
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
      const result = await deps.mcp.callTool(call.function.name, args);
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
