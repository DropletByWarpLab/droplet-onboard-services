import { config } from "../config.js";
import { getRequestId } from "../lib/request-context.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";
import type {
  ChatRequest,
  ModelCapabilities,
  ModelInfo,
  ModelsResponse,
} from "../types/index.js";

// WARP-236: rewrite the internal base URL to https:// and present our client
// cert when DROPLET_INTERNAL_TLS=1; identity + plain fetch when off.
const BASE_URL = internalBaseUrl(config.AI_GATEWAY_URL);

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
  const rid = getRequestId();
  if (rid) headers["x-request-id"] = rid;
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
    const res = await internalFetch(`${BASE_URL}/ai/models`, {
      headers: authHeaders(),
      signal: timeout(),
    });
    if (!res.ok) throw new Error(`AI Gateway error: ${res.status}`);
    return (await res.json()) as ModelsResponse;
  } catch (err) {
    throw wrapTimeout(err, "listModels", DEFAULT_GATEWAY_TIMEOUT_MS);
  }
}

// Model-info lookup for vision routing. The models list is small and changes
// rarely, so a short TTL cache keeps per-turn routing off the gateway's hot
// path. On a gateway error we degrade to "unknown" (undefined) rather than
// blocking chat — the route then treats the model as non-vision (OCR fallback).
let _modelsCache: { at: number; models: ModelInfo[] } | null = null;
const MODELS_CACHE_TTL_MS = 30_000;

/**
 * Resolve one model's info from the TTL-cached model list, refreshing the
 * cache when stale. Returns `undefined` when the model is unknown OR the
 * gateway is unreachable and the cache was never populated — callers must
 * treat that as "unknown" and degrade, never block the turn.
 */
async function findModelInfo(
  model: string,
  now: number,
): Promise<ModelInfo | undefined> {
  if (!_modelsCache || now - _modelsCache.at > MODELS_CACHE_TTL_MS) {
    try {
      const res = await listModels();
      _modelsCache = { at: now, models: res.models };
    } catch {
      if (!_modelsCache) return undefined; // never populated → unknown
      // else: serve stale rather than failing the turn
    }
  }
  return _modelsCache?.models.find((m) => m.id === model);
}

export async function getModelCapabilities(
  model: string,
  now: number = Date.now(),
): Promise<ModelCapabilities | undefined> {
  return (await findModelInfo(model, now))?.capabilities;
}

/**
 * WARP-904: the provider that serves `model` (e.g. "ollama", "openai"), read
 * from the same cached model list vision routing already uses. Needed so the
 * per-turn audit trail records the provider of the model that ACTUALLY ran
 * when vision auto-routing swaps the user's cloud pick for a local vision
 * model. `undefined` when the model is unknown (never a guess).
 */
export async function getModelProvider(
  model: string,
  now: number = Date.now(),
): Promise<string | undefined> {
  return (await findModelInfo(model, now))?.provider;
}

export async function chat(
  request: ChatRequest,
  signal?: AbortSignal,
  userId?: string
): Promise<Response> {
  // Streaming chat: no timeout — inference can legitimately take minutes on
  // local Ollama. The orchestrator's agent loop owns turn-level timeouts.
  // Return raw Response so the route handler can pipe streaming bodies.
  //
  // WARP-329 — `signal` is the client-disconnect AbortSignal threaded from
  // the /api/llm/chat route's `req.on("close")`. Aborting it cancels the
  // in-flight inference fetch so a disconnected client doesn't keep the
  // model running.
  const res = await internalFetch(`${BASE_URL}/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(userId) },
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
  apiKey: string,
  userId?: string
): Promise<void> {
  const res = await internalFetch(`${BASE_URL}/ai/keys/${provider}`, {
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
    const res = await internalFetch(`${BASE_URL}/ai/keys`, {
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
  const res = await internalFetch(`${BASE_URL}/ai/keys/${provider}`, {
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
    const res = await internalFetch(`${BASE_URL}/ai/health`, {
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
