import { config } from "../config.js";
import type { ChatRequest, ModelsResponse } from "../types/index.js";

const BASE_URL = config.AI_GATEWAY_URL;

/**
 * Default timeout for non-streaming gateway calls. The local Ollama instance
 * can stall briefly under inference load, but anything over 10 seconds for a
 * model-list or key CRUD is broken upstream — failing fast lets the dashboard
 * keep its 30 s SWR poll loop healthy instead of stacking hung requests
 * (WARP-303).
 */
const DEFAULT_GATEWAY_TIMEOUT_MS = 10_000;

/**
 * Match switch.client.ts pattern: return a fresh AbortSignal that aborts
 * after `ms` ms. The native `AbortSignal.timeout()` does exactly this.
 */
function timeout(ms: number = DEFAULT_GATEWAY_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

/** True when `err` is the abort thrown by an `AbortSignal.timeout` firing. */
export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/** Wrap a fetch error with a clearer message when a timeout fired. */
function wrapTimeout(err: unknown, op: string, ms: number): Error {
  if (isTimeoutError(err)) {
    return new Error(`AI Gateway timeout after ${ms}ms during ${op}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function listModels(): Promise<ModelsResponse> {
  try {
    const res = await fetch(`${BASE_URL}/ai/models`, { signal: timeout() });
    if (!res.ok) throw new Error(`AI Gateway error: ${res.status}`);
    return (await res.json()) as ModelsResponse;
  } catch (err) {
    throw wrapTimeout(err, "listModels", DEFAULT_GATEWAY_TIMEOUT_MS);
  }
}

export async function chat(
  request: ChatRequest,
  signal?: AbortSignal,
): Promise<Response> {
  // Streaming chat: no timeout — inference can legitimately take minutes on
  // local Ollama. The orchestrator's agent loop owns turn-level timeouts.
  // Return raw Response so the route handler can pipe streaming bodies.
  //
  // WARP-329 — `signal` is the client-disconnect AbortSignal threaded from
  // the /api/llm/chat route's `req.on("close")`. Aborting it cancels the
  // in-flight inference fetch so a disconnected client doesn't keep the
  // model running.
  const res = await fetch(`${BASE_URL}/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok && !request.stream) {
    const body = await res.text();
    throw new Error(`AI Gateway error ${res.status}: ${body}`);
  }
  return res;
}

export async function saveKey(
  provider: string,
  apiKey: string
): Promise<void> {
  const res = await fetch(`${BASE_URL}/ai/keys/${provider}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
    signal: timeout(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to save key: ${body}`);
  }
}

export async function listKeys(): Promise<string[]> {
  try {
    const res = await fetch(`${BASE_URL}/ai/keys`, { signal: timeout() });
    if (!res.ok) throw new Error(`AI Gateway error: ${res.status}`);
    const data = (await res.json()) as { providers: string[] };
    return data.providers;
  } catch (err) {
    throw wrapTimeout(err, "listKeys", DEFAULT_GATEWAY_TIMEOUT_MS);
  }
}

export async function deleteKey(provider: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/ai/keys/${provider}`, {
    method: "DELETE",
    signal: timeout(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to delete key: ${body}`);
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/ai/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// WARP-311: the ai-gateway session proxy helpers (createSession,
// listSessions, getSession, updateSession, deleteSession, sessionChat)
// were removed alongside the legacy `/llm/sessions/*` routes in
// `routes/llm.ts`. Persistent conversation state now lives in the
// orchestrator's own Postgres via WARP-304; direct callers of the
// ai-gateway can still hit its session endpoints — the orchestrator
// simply doesn't proxy them anymore.
