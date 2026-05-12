import { config } from "../config.js";
import type {
  ChatRequest,
  ModelsResponse,
  SessionInfo,
  SessionDetail,
  SessionListResponse,
  SessionChatRequest,
} from "../types/index.js";

const BASE_URL = config.AI_GATEWAY_URL;

/**
 * Default timeout for non-streaming gateway calls. The Ollama Orin Nano can
 * stall briefly under inference load, but anything over 10 seconds for a
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

export async function chat(request: ChatRequest): Promise<Response> {
  // Streaming chat: no timeout — inference can legitimately take minutes on
  // local Ollama. The orchestrator's agent loop owns turn-level timeouts.
  // Return raw Response so the route handler can pipe streaming bodies.
  const res = await fetch(`${BASE_URL}/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

// --- Sessions ---

export async function createSession(body: {
  model: string;
  title?: string;
  system_prompt?: string | null;
}): Promise<SessionInfo> {
  const res = await fetch(`${BASE_URL}/ai/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeout(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create session: ${text}`);
  }
  return res.json() as Promise<SessionInfo>;
}

export async function listSessions(
  limit = 50,
  offset = 0
): Promise<SessionListResponse> {
  const res = await fetch(
    `${BASE_URL}/ai/sessions?limit=${limit}&offset=${offset}`,
    { signal: timeout() }
  );
  if (!res.ok) throw new Error(`AI Gateway error: ${res.status}`);
  return res.json() as Promise<SessionListResponse>;
}

export async function getSession(sessionId: string): Promise<SessionDetail> {
  const res = await fetch(`${BASE_URL}/ai/sessions/${sessionId}`, {
    signal: timeout(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get session: ${text}`);
  }
  return res.json() as Promise<SessionDetail>;
}

export async function updateSession(
  sessionId: string,
  title: string
): Promise<SessionInfo> {
  const res = await fetch(`${BASE_URL}/ai/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
    signal: timeout(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update session: ${text}`);
  }
  return res.json() as Promise<SessionInfo>;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/ai/sessions/${sessionId}`, {
    method: "DELETE",
    signal: timeout(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to delete session: ${text}`);
  }
}

export async function sessionChat(
  sessionId: string,
  request: SessionChatRequest
): Promise<Response> {
  // Streaming chat: see `chat()` above for rationale on omitting timeout.
  const res = await fetch(`${BASE_URL}/ai/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok && !request.stream) {
    const body = await res.text();
    throw new Error(`Session chat error ${res.status}: ${body}`);
  }
  return res;
}
