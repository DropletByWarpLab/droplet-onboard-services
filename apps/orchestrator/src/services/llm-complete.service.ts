/**
 * WARP-1426 — single-turn, non-agentic LLM completion.
 *
 * `completeOnce` sends ONE system+user message pair to the ai-gateway and
 * returns the completion text. It exists for lightweight text-in/text-out
 * tasks that must never enter the agent loop: no conversation persistence,
 * no history, and — critically — NO tool dispatch. The `tools` /
 * `tool_choice` fields are never present on the outgoing ChatRequest, so
 * the model cannot call anything even if the gateway would forward it.
 *
 * Consumers: the `translate_text` and `summarize_file` MCP tools
 * (@droplet/tools-core) ride this via `POST /api/llm/complete` using the
 * mcp-server service principal.
 *
 * Note: `makeHttpChatAdapter` in query-enhancement.service.ts (the WARP-437
 * query-enhancement work) is the same single-turn shape but with different
 * failure semantics (silently degrades to `{ content: "" }` so retrieval
 * falls back to the raw query). It stays separate ON PURPOSE — do not
 * refactor query-enhancement.service.ts onto this helper (surgical-changes
 * rule): callers here need failures surfaced (→ 502), not swallowed.
 */
import * as aiGateway from "./ai-gateway.client.js";
import { isTimeoutError } from "./ai-gateway.client.js";
import {
  contentToText,
  type ChatMessage,
  type ChatResponse,
} from "../types/index.js";

/**
 * Belt-and-braces timeout: `aiGateway.chat` deliberately sets NO timeout
 * for chat calls (local CPU inference and cold model loads can
 * legitimately take minutes), so without our own signal a wedged gateway
 * would hang this request forever. 120 s is generous enough for a slow
 * CPU-inference completion while still bounding the caller.
 */
const COMPLETE_TIMEOUT_MS = 120_000;

/** Defaults for the light text-task profile (translation, summarization). */
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 1024;

export interface CompleteOnceArgs {
  /** Optional system prompt (task instruction). */
  system?: string;
  /** The user-turn text to complete against. */
  text: string;
  /** Fully-resolved model id — the route owns default-model resolution. */
  model: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Forwarded to the gateway as `X-Droplet-User` for per-user BYOK key
   * scoping (WARP-561); omitted → shared/device namespace.
   */
  userId?: string;
  /**
   * WARP-2964 — gpt-oss reasoning-effort control, passed straight through as
   * a top-level `reasoning_effort` (the gateway scopes it to the gpt-oss
   * family, so it is a no-op elsewhere). Unset → the key is never sent and
   * the request body stays byte-for-byte what it was.
   */
  reasoningEffort?: "low" | "medium" | "high";
}

export interface CompleteOnceResult {
  /** Completion text; "" when the model returned no content. */
  content: string;
  /** The model that was requested (echoed for the response contract). */
  model: string;
  /**
   * WARP-2964 — the provider's separate reasoning channel (`reasoning_content`;
   * gpt-oss's harmony "analysis"), trimmed; "" when there was none.
   *
   * Empty `content` on a reasoning model is ambiguous on its own: the model
   * may have had nothing to say, or it may have spent the entire `max_tokens`
   * budget thinking and been cut off before writing a word. A fat `reasoning`
   * next to `finishReason: "length"` is what tells those two apart.
   */
  reasoning: string;
  /** The provider's verdict for the choice (`stop` | `length` | …); null when absent. */
  finishReason: string | null;
}

/**
 * One non-streaming completion round-trip. Throws on any gateway failure
 * (non-OK, transport error, timeout) — the route maps that to 502
 * `llm_unavailable`. An OK response with empty content is NOT an error:
 * it resolves to `{ content: "" }`.
 */
export async function completeOnce(
  args: CompleteOnceArgs,
): Promise<CompleteOnceResult> {
  const messages: ChatMessage[] = [];
  if (args.system) {
    messages.push({ role: "system", content: args.system });
  }
  messages.push({ role: "user", content: args.text });

  let res: Response;
  try {
    res = await aiGateway.chat(
      {
        model: args.model,
        messages,
        stream: false,
        temperature: args.temperature ?? DEFAULT_TEMPERATURE,
        max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(args.reasoningEffort ? { reasoning_effort: args.reasoningEffort } : {}),
        // NO `tools` / `tool_choice` — this call path is non-agentic by
        // contract; nothing here may ever advertise a tool to the model.
      },
      AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
      args.userId,
    );
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(
        `AI Gateway timeout after ${COMPLETE_TIMEOUT_MS}ms during completeOnce`,
      );
    }
    throw err;
  }
  // `aiGateway.chat` already throws on non-OK non-stream responses; this
  // guard is belt-and-braces so a future client change can't silently
  // turn a gateway error into an empty completion.
  if (!res.ok) {
    throw new Error(`AI Gateway error ${res.status}`);
  }
  const data = (await res.json()) as ChatResponse;
  const choice = data.choices?.[0];
  return {
    content: contentToText(choice?.message?.content),
    model: args.model,
    reasoning: (choice?.message?.reasoning_content ?? "").trim(),
    finishReason: choice?.finish_reason ?? null,
  };
}
