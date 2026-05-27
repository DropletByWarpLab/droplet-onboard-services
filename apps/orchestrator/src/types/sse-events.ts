/**
 * Typed SSE event surface emitted by `/api/llm/chat` when `stream=true`.
 *
 * The orchestrator agent loop (`runAgent` in `services/llm-agent.service.ts`)
 * pushes one of these events per phase: token deltas from the model
 * (`content_delta`), each tool dispatch (`tool_call`/`tool_result`), and
 * a terminating `done`. The shape is the contract spec §8.2 promises to
 * MCP-aware downstream clients (dashboard chat, inference-engine, future
 * external CLIs).
 */
export type SSEEvent =
  | { type: "content_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | {
      type: "tool_result";
      id: string;
      ok: boolean;
      data?: unknown;
      status?: string;
      message?: string;
    }
  /**
   * WARP-458 — one step of the assistant's deep-reasoning trace. Emitted
   * BEFORE any `content_delta` block on the same turn, in arrival order
   * (one event per `<reasoning>…</reasoning>` segment, plus an extra
   * leading step for the provider-native reasoning field when present).
   * The dashboard renders these as a collapsible "thinking" timeline
   * above the answer; the orchestrator persists the concatenated trace
   * to `ChatMessage.reasoning` so a refresh / rehydrate can re-render
   * them without re-running inference.
   *
   * Gated on the per-request `captureReasoning` flag (default false).
   * When the flag is false the agent loop still parses + persists, but
   * suppresses these events on the wire. See WARP-458 AC §4.
   */
  | { type: "reasoning_step"; text: string }
  | {
      type: "done";
      iterations: number;
      stop_reason: "model_done" | "iteration_limit" | "error";
      error?: string;
    };

/**
 * Encode an `SSEEvent` as a single SSE frame, terminated by the canonical
 * blank line that delimits frames. The `event:` line lets browser
 * `EventSource` consumers route to per-type handlers.
 */
export function encodeSSE(event: SSEEvent): string {
  const { type, ...payload } = event;
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}
