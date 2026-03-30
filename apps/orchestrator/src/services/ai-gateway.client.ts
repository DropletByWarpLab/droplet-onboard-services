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

export async function listModels(): Promise<ModelsResponse> {
  const res = await fetch(`${BASE_URL}/ai/models`);
  if (!res.ok) throw new Error(`AI Gateway error: ${res.status}`);
  return res.json() as Promise<ModelsResponse>;
}

export async function chat(request: ChatRequest): Promise<Response> {
  // Return raw Response so the route handler can pipe streaming bodies
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
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to save key: ${body}`);
  }
}

export async function listKeys(): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/ai/keys`);
  if (!res.ok) throw new Error(`AI Gateway error: ${res.status}`);
  const data = (await res.json()) as { providers: string[] };
  return data.providers;
}

export async function deleteKey(provider: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/ai/keys/${provider}`, {
    method: "DELETE",
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
    `${BASE_URL}/ai/sessions?limit=${limit}&offset=${offset}`
  );
  if (!res.ok) throw new Error(`AI Gateway error: ${res.status}`);
  return res.json() as Promise<SessionListResponse>;
}

export async function getSession(sessionId: string): Promise<SessionDetail> {
  const res = await fetch(`${BASE_URL}/ai/sessions/${sessionId}`);
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
