import { config } from "../config.js";
import type { ChatRequest, ModelsResponse } from "../types/index.js";

const BASE_URL = config.AI_GATEWAY_URL;

/**
 * WARP-560: service-to-service auth headers for the ai-gateway, which now
 * requires a Bearer service token on every /ai/* route. Mirrors
 * switch.client.ts's `authHeaders()`: SERVICE_TOKEN_AI_GATEWAY is the dedicated
 * bearer (compose wires the ai-gateway's SERVICE_TOKEN_AI_GATEWAY to the same
 * value); SERVICE_SECRET is the legacy shared-secret fallback for installs
 * whose .env predates the dedicated token.
 *
 * `userId` (optional) is forwarded as `X-Droplet-User` so the gateway can scope
 * per-user BYOK keys (WARP-561) and session ownership (WARP-560). Omitted →
 * the gateway uses its shared/device namespace (background / service calls).
 */
function authHeaders(userId?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = config.SERVICE_TOKEN_AI_GATEWAY || config.SERVICE_SECRET;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (userId) {
    headers["X-Droplet-User"] = userId;
  }
  return headers;
}

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
    const res = await fetch(`${BASE_URL}/ai/models`, {
      headers: authHeaders(),
      signal: timeout(),
    });
    if (!res.ok) throw new Error(`AI Gateway error: ${res.status}`);
    return (await res.json()) as ModelsResponse;
  } catch (err) {
    throw wrapTimeout(err, "listModels", DEFAULT_GATEWAY_TIMEOUT_MS);
  }
}

export async function chat(
  request: ChatRequest,
  userId?: string
): Promise<Response> {
  // Streaming chat: no timeout — inference can legitimately take minutes on
  // local Ollama. The orchestrator's agent loop owns turn-level timeouts.
  // Return raw Response so the route handler can pipe streaming bodies.
  const res = await fetch(`${BASE_URL}/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(userId) },
    body: JSON.stringify(request),
  });
  if (!res.ok && !request.stream) {
    const body = await res.text();
    throw new Error(`AI Gateway error ${res.status}: ${body}`);
  }
  return res;
}

export async function saveKey(
  provider: string,
  apiKey: string,
  userId?: string
): Promise<void> {
  const res = await fetch(`${BASE_URL}/ai/keys/${provider}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(userId) },
    body: JSON.stringify({ api_key: apiKey }),
    signal: timeout(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to save key: ${body}`);
  }
}

export async function listKeys(userId?: string): Promise<string[]> {
  try {
    const res = await fetch(`${BASE_URL}/ai/keys`, {
      headers: authHeaders(userId),
      signal: timeout(),
    });
    if (!res.ok) throw new Error(`AI Gateway error: ${res.status}`);
    const data = (await res.json()) as { providers: string[] };
    return data.providers;
  } catch (err) {
    throw wrapTimeout(err, "listKeys", DEFAULT_GATEWAY_TIMEOUT_MS);
  }
}

export async function deleteKey(
  provider: string,
  userId?: string
): Promise<void> {
  const res = await fetch(`${BASE_URL}/ai/keys/${provider}`, {
    method: "DELETE",
    headers: authHeaders(userId),
    signal: timeout(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to delete key: ${body}`);
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    // /ai/health is the only route the gateway leaves unauthenticated (the
    // compose healthcheck + ops probe hit it tokenless), so no auth header here.
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
