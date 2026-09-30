/**
 * WARP-3303 — the page-wide fan-out for `droplet/agent-runs/<username>`.
 *
 * One socket already exists on every signed-in page (NotificationToaster's,
 * mounted in the layout); it hands each agent-run frame to `publish`, and any
 * number of run cards and the sidebar badge `subscribe`. A second socket per
 * card would multiply connections for no gain.
 */
import type { AgentRunEvent } from "@/components/workshop/agent-runs/api";

type Listener = (evt: AgentRunEvent) => void;
const listeners = new Set<Listener>();

export function subscribeAgentRunEvents(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** A frame off the socket; anything that is not an agent-run event is ignored. */
export function publishAgentRunFrame(topic: unknown, payload: unknown): void {
  if (typeof topic !== "string" || !topic.startsWith("droplet/agent-runs/")) return;
  const evt = payload as Partial<AgentRunEvent> | null;
  if (!evt || typeof evt.runId !== "string" || typeof evt.status !== "string") return;
  for (const fn of listeners) fn(evt as AgentRunEvent);
}
