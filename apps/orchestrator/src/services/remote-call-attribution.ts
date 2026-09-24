/**
 * WARP-2900 — who a remote dispatch ran for, for the orchestrator's OWN audit.
 *
 * The multiplexer never hands `McpCallContext` to a remote port: it carries
 * the caller's Nextcloud token and a confirmation token, and a remote server
 * is not trusted with either (mcp-multiplexer.service.ts, "What is
 * deliberately NOT forwarded"; its test pins `callTool` at two arguments).
 * But an in-process port wrapper that writes the `tool_call` row (the
 * extension attach's audited port) still has to say whose turn and which
 * durable run made the call, the way the stdio row does.
 *
 * So the multiplexer runs the remote call inside this async-local scope,
 * holding ONLY the two attribution fields — never a token — and the wrapper
 * reads them back. Nothing here reaches a wire: a port that sends it
 * anywhere would have to read it on purpose.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RemoteCallAttribution {
  /** The caller's username, as on the stdio `tool_call` row (`refs.userId`). */
  userId?: string;
  /** The durable run this dispatch belongs to (`refs.agentRunId`). */
  agentRunId?: string;
}

const scope = new AsyncLocalStorage<RemoteCallAttribution>();

export function withRemoteCallAttribution<T>(attribution: RemoteCallAttribution, fn: () => Promise<T>): Promise<T> {
  return scope.run({ userId: attribution.userId, agentRunId: attribution.agentRunId }, fn);
}

/** The attribution of the remote call in progress, or undefined outside one. */
export function remoteCallAttribution(): RemoteCallAttribution | undefined {
  return scope.getStore();
}
