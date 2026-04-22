/**
 * LLM agent loop.
 *
 * One turn of a ReAct-style loop:
 *
 *   user message  -->  ai-gateway w/ tools[]  -->  tool_calls?
 *                                                    |
 *                                                    v
 *                                             dispatch each --> tool-role messages
 *                                                    |
 *                                                    +---> loop until the model
 *                                                          returns plain content
 *                                                          OR iteration cap hit.
 *
 * We cap iterations (default 5) so a confused model can't burn tokens forever.
 * Every tool call + result is stashed in the returned `trace` so the caller
 * (dashboard, audit log, or agent-build UI) can replay the decision path.
 */

import type { PrismaClient } from "@prisma/client";
import * as aiGateway from "./ai-gateway.client.js";
import { TOOL_REGISTRY, toolsForModel, dispatchTool, type ToolContext } from "./llm-tools.js";
import type { ChatMessage, ChatResponse, ToolCall } from "../types/index.js";

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

export async function runAgent(
  req: AgentRequest,
  prisma: PrismaClient,
  userId?: string,
): Promise<AgentResult> {
  const maxIter = Math.max(1, Math.min(req.max_iter ?? DEFAULT_MAX_ITER, 10));
  const ctx: ToolContext = { prisma, userId };
  const trace: AgentTraceEntry[] = [];

  // Start with a copy of the caller's message history so we can append
  // tool results without mutating the input.
  const messages: ChatMessage[] = [...req.messages];

  // Filter the advertised tool set if the caller wants a narrower surface
  // (e.g. a "network-only" assistant page could hide file/camera tools).
  const allTools = toolsForModel();
  const tools =
    req.allowed_tools?.length
      ? allTools.filter((t) => req.allowed_tools!.includes(t.function.name))
      : allTools;

  for (let iter = 0; iter < maxIter; iter++) {
    const gwRes = await aiGateway.chat({
      model: req.model,
      messages,
      stream: false,
      temperature: req.temperature,
      tools,
      tool_choice: "auto",
    });
    if (!gwRes.ok) {
      return {
        message: { role: "assistant", content: "" },
        trace,
        iterations: iter,
        stop_reason: "error",
        error: `ai-gateway ${gwRes.status}`,
      };
    }
    const data = (await gwRes.json()) as ChatResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      return {
        message: { role: "assistant", content: "" },
        trace,
        iterations: iter,
        stop_reason: "error",
        error: "no choice in response",
      };
    }
    const asst = choice.message;

    // Happy path: model produced a final answer, no more tool calls.
    if (!asst.tool_calls?.length) {
      return {
        message: asst,
        trace,
        iterations: iter + 1,
        stop_reason: "model_done",
      };
    }

    // Otherwise: execute every requested tool and feed results back in.
    // Append the assistant's tool-call-issuing message first (required
    // by the OpenAI protocol so the tool-role messages have a parent).
    messages.push(asst);

    for (const call of asst.tool_calls) {
      const parsedArgs = safeParseArgs(call);
      const result = await dispatchTool(call.function.name, parsedArgs, ctx);
      trace.push({
        tool_call_id: call.id,
        tool: call.function.name,
        args: parsedArgs,
        result,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        // Keep payloads bounded so one giant tool result doesn't blow
        // the context window on the next turn.
        content: JSON.stringify(result).slice(0, 8000),
      });
    }
  }

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
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export { TOOL_REGISTRY };
