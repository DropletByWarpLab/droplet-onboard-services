/**
 * WARP-3306 — the ai-gateway's `preempted_for_chat` answer. A background
 * agent run's model call, sent `X-Preemptible: 1`, gives the single inference
 * slot up when an interactive chat request arrives: 409 at open, or a final
 * error frame mid-stream. The gateway client turns either into this error;
 * the agent loop lets it through untouched; the agent-run worker requeues the
 * run and redoes the iteration from its checkpoint.
 *
 * Its own module (not ai-gateway.client.ts) because many tests replace the
 * client with a factory mock, and the loop and the worker must still see this.
 */
export const PREEMPTED_FOR_CHAT = "preempted_for_chat";

export class GatewayPreemptedError extends Error {
  readonly code = PREEMPTED_FOR_CHAT;
  constructor() {
    super("AI Gateway preempted_for_chat: an interactive chat request took the inference slot");
    this.name = "GatewayPreemptedError";
  }
}

/** Duck-typed on `code`, so a test gateway can throw a plain object-shaped error. */
export function isGatewayPreempted(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === PREEMPTED_FOR_CHAT;
}
