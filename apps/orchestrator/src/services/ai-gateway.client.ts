import { config } from "../config.js";
import type { ChatRequest, ModelsResponse } from "../types/index.js";

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
