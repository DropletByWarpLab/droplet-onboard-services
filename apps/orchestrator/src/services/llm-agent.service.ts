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

/**
 * WARP-399 — Tier-2 deferral hook for autonomous mode.
 *
 * In `interactive` mode the agent loop dispatches every tool call.
 * In `autonomous` mode (e.g. the smart-port subscriber kicks off a run
 * with no operator in the chat) the loop calls `deferTier2ToolCall`
 * BEFORE dispatching. If the hook returns a `ToolDeferral`, dispatch
 * is skipped: a synthetic tool result is fed back to the model and
 * the loop continues. The hook owner (smart-port-agent.service) is
 * responsible for persisting the `AutonomousProposal` row.
 *
 * Returning `null` means "go ahead, dispatch normally" — the hook
 * uses this for Tier-1 tools and as the fallback when an autonomous
 * agent legitimately calls a tool that doesn't require confirmation.
 */
export interface ToolDeferral {
  proposal_id: string;
  reason: string;
}

export type ToolDeferralHook = (input: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  agentRunId?: string;
}) => Promise<ToolDeferral | null>;

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
  /**
   * Optional Tier-2 deferral hook. Wired by the orchestrator boot when
   * the autonomous-agent runtime is enabled. Left `undefined` for the
   * default interactive path (dashboard chat) — equivalent to "no
   * deferral, dispatch every call".
   */
  deferTier2ToolCall?: ToolDeferralHook;
}

export interface AgentRequest {
  model: string;
  messages: ChatMessage[];
  max_iter?: number;
  temperature?: number;
  /** If set, restrict the registry to this subset of tool names. */
  allowed_tools?: string[];
  /**
   * Per-call session context passed verbatim to every `mcp.callTool`
   * invocation in this loop. Today the only field is `ncToken` so file
   * tools can authenticate to Nextcloud as the dashboard user. The
   * MCP `_meta` channel carries it to the stdio child; stdio is
   * in-process trusted, so it's safe to plumb session tokens this way.
   */
  toolCallContext?: McpCallContext;
  /**
   * WARP-399 — run mode.
   *
   * `interactive` (default): an operator is on the other end of the
   * conversation. Tier-2 tools require dashboard confirm and the
   * existing camera-discovery / switch-service flow handles it.
   *
   * `autonomous`: no operator in chat. Tier-2 dispatches are routed
   * through `deferTier2ToolCall` and staged as proposals for later
   * operator approval. Set together with `agentRunId` (the
   * CommandAuditLog row id) so each deferred proposal can be joined
   * back to the run that produced it.
   */
  mode?: "interactive" | "autonomous";
  /** Audit row id for the in-flight agent run. Required when mode=autonomous. */
  agentRunId?: string;
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

      // WARP-399 — Tier-2 deferral in autonomous mode. The hook is the
      // arbiter; this code path doesn't know which tools require
      // confirmation (that lives in the `tools-core` registry, not on
      // the MCP descriptor). When the hook returns a `ToolDeferral`,
      // we synthesise a `confirmation_required` tool result and skip
      // the real dispatch — the model can keep classifying (Tier-1
      // reads) or stop, either is fine.
      const deferral =
        req.mode === "autonomous" && deps.deferTier2ToolCall
          ? await deps.deferTier2ToolCall({
              toolName: call.function.name,
              toolArgs: args,
              agentRunId: req.agentRunId,
            })
          : null;
      let text: string;
      let parsed: unknown;
      let isErrorResult: boolean;
      if (deferral) {
        const synthetic = {
          ok: false,
          status: "confirmation_required",
          error: {
            code: "TIER2_DEFERRED",
            message: deferral.reason,
            details: { proposal_id: deferral.proposal_id, deferred: true },
          },
        };
        text = JSON.stringify(synthetic);
        parsed = synthetic;
        isErrorResult = false; // proposals aren't errors — surface as a chip
      } else {
        const result = await deps.mcp.callTool(
          call.function.name,
          args,
          req.toolCallContext,
        );
        text = result.content[0]?.text ?? "{}";
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
        isErrorResult = result.isError;
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
        ok: isConfirmation ? true : !isErrorResult,
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
