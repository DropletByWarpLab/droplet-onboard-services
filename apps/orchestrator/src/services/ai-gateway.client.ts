import { config } from "../config.js";
import { getRequestId } from "../lib/request-context.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";
import { markModelListChanged, modelListGeneration } from "./model-list-generation.js";
import type {
  ChatRequest,
  ChatStreamChunk,
  ModelCapabilities,
  LatencyResponse,
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
 * WARP-3047 — the model list behind every cached lookup in this module,
 * refreshed when stale. `degradedProviders` is non-empty only for a one-off
 * PARTIAL list served because no complete snapshot exists yet; a cached or
 * stale-but-complete snapshot always reports `[]`. Null when the gateway is
 * unreachable and the cache was never populated.
 */
export interface CachedModelListing {
  models: ModelInfo[];
  degradedProviders: string[];
}

async function modelListing(now: number): Promise<CachedModelListing | null> {
  if (!_modelsCache || now - _modelsCache.at > MODELS_CACHE_TTL_MS) {
    try {
      const generation = modelListGeneration();
      const res = await listModels();
      if (res.degraded_providers?.length) {
        // WARP-1289: a degraded fan-out (some provider raised while the
        // gateway listed models — WARP-1284's additive signal) is a PARTIAL
        // list. Never cache it: snapshotting it would pin "unknown
        // capabilities" for the full TTL after a one-blip Ollama hiccup.
        // Resolve this lookup from the partial list one-off, unless we
        // already hold a (stale but complete) snapshot — then serve stale,
        // same posture as the catch path below.
        if (!_modelsCache) {
          return { models: res.models, degradedProviders: res.degraded_providers };
        }
      } else if (generation === modelListGeneration()) {
        // WARP-3046: a download finished while this read was in flight, so
        // its list may predate the new model — never cache it (see
        // model-list-generation.ts). The lookup below then reads "unknown"
        // once, the same degrade as an unreachable gateway.
        _modelsCache = { at: now, models: res.models };
      }
    } catch {
      if (!_modelsCache) return null; // never populated → unknown
      // else: serve stale rather than failing the turn
    }
  }
  return _modelsCache ? { models: _modelsCache.models, degradedProviders: [] } : null;
}

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
  return (await modelListing(now))?.models.find((m) => m.id === model);
}

/**
 * WARP-3047 — the installed-model list for `resolveActiveModel`, from the
 * SAME 30 s snapshot vision routing uses (no second cache): the resolver
 * runs inside chat turns, tool back-ends and pre-auth warm triggers, so it
 * must not cost a gateway round-trip each time. The caller decides whether
 * `degradedProviders` makes the list untrustworthy for its purpose.
 */
export async function getCachedModelListing(
  now: number = Date.now(),
): Promise<CachedModelListing | null> {
  return modelListing(now);
}

/**
 * WARP-3046 — the installed model set just changed (a download finished):
 * make every model listing re-read it now instead of after its TTL.
 *
 * Two caches, both invalidated here: the gateway's ModelRegistry (60 s, via
 * its service-token-gated POST /ai/models/refresh) and this module's own
 * `_modelsCache` (30 s), which per-turn vision routing reads — without the
 * local clear a just-installed vision model reads as "unknown capabilities"
 * for its first turns. The local cache is dropped AFTER the gateway call, and
 * dropped even when that call fails: the local list is stale either way.
 *
 * Dropping a cache does not stop a read that was already in flight from
 * writing the pre-pull list back into it — the gateway hands a fan-out begun
 * before its invalidation to the callers already awaiting it. So this also
 * bumps the model-list generation, in the one slot that closes that window:
 * after the gateway dropped its listing, before the caller busts its own
 * caches (model-list-generation.ts has the full argument). Every writer of a
 * model-list cache skips the write when the generation moved under its read.
 * Throws on a gateway failure so the caller can log it; it never has to
 * fail the pull that triggered it.
 */
export async function refreshModels(): Promise<void> {
  try {
    const res = await internalFetch(`${BASE_URL}/ai/models/refresh`, {
      method: "POST",
      headers: authHeaders(),
      signal: timeout(),
    });
    if (!res.ok) throw new Error(`AI Gateway error: ${res.status}`);
  } catch (err) {
    throw wrapTimeout(err, "refreshModels", DEFAULT_GATEWAY_TIMEOUT_MS);
  } finally {
    _modelsCache = null;
    markModelListChanged();
  }
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

/**
 * WARP-2851 — the model's OWN context window, from the same cached list.
 *
 * The gateway publishes this per provider (`schemas.py` `ModelInfo`):
 * anthropic 200000, openai 128000, and **null for every local model** — Ollama
 * does not report a window, and the deployed one is an operator setting
 * (`OLLAMA_CONTEXT_LENGTH`) rather than a property of the model.
 *
 * `undefined` therefore means BOTH "unknown model / gateway unreachable" and
 * "the provider does not publish one", and both must resolve to the local
 * default — see `resolveTurnContextWindow`. Never guess a window: budgeting a
 * 16K model as though it were 200K is the WARP-854 overflow, which is the
 * failure this whole budget path exists to prevent.
 */
export async function getModelContextWindow(
  model: string,
  now: number = Date.now(),
): Promise<number | undefined> {
  return (await findModelInfo(model, now))?.context_window ?? undefined;
}

/**
 * WARP-2749 — per-call options. `priority` is the gateway's
 * `X-Request-Priority` (services/ai-gateway/main.py: 0 user-initiated, the
 * default when the header is absent; 5 automation; 10 background). Its
 * scheduler serves lower values first and REJECTS a request ≥ 5 with 429
 * while five or more requests are pending — so a background caller must
 * treat 429 as "chat is busy, try later", never as a failure of its own.
 */
export interface ChatCallOptions {
  priority?: number;
}

export async function chat(
  request: ChatRequest,
  signal?: AbortSignal,
  userId?: string,
  opts?: ChatCallOptions,
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
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(userId),
      ...(opts?.priority !== undefined ? { "X-Request-Priority": String(opts.priority) } : {}),
    },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok && !request.stream) {
    const body = await res.text();
    throw new Error(`AI Gateway error ${res.status}: ${body}`);
  }
  return res;
}

/**
 * WARP-1442 — SERVER-SIDE token streaming. POSTs `/ai/chat` with `stream:true`
 * and yields the gateway's OpenAI-compat SSE chunks as they arrive, so the
 * orchestrator agent loop can emit `content_delta` INCREMENTALLY instead of one
 * delta after the full blocking decode. The gateway passes Ollama's
 * `/v1/chat/completions` stream through verbatim (`services/ai-gateway`
 * `_stream_chat` → `StreamingResponse`), so each frame is one
 * `ChatStreamChunk`.
 *
 * Reuses `chat()` for the request itself — same headers, mTLS routing, and the
 * WARP-329 client-disconnect `signal` (which carries no timeout on the
 * streaming path, since inference can legitimately take minutes). Throws on a
 * non-OK status so the agent loop can fall back to the blocking `chat()`. On
 * early termination (the consumer `break`s / the client disconnects) the
 * `finally` cancels the body so the connection to the gateway — and thus the
 * upstream Ollama stream — tears down.
 */
export async function* chatStream(
  request: ChatRequest,
  signal?: AbortSignal,
  userId?: string,
  opts?: ChatCallOptions,
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  const res = await chat({ ...request, stream: true }, signal, userId, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI Gateway streaming error ${res.status}: ${body}`);
  }
  if (!res.body) {
    throw new Error("AI Gateway streaming response had no body");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseFrame = function* (frame: string): Generator<ChatStreamChunk> {
    const line = frame.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      yield JSON.parse(payload) as ChatStreamChunk;
    } catch {
      // Skip a malformed frame rather than tearing down the whole turn.
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // The gateway emits `data: {json}\n\n` frames; split on newlines and
      // parse each `data:` line (ignore keep-alives / blank separators). Stop
      // cleanly on the terminating `[DONE]`.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (rawLine.trim() === "data: [DONE]" || rawLine.trim() === "data:[DONE]") {
          return;
        }
        yield* parseFrame(rawLine);
      }
    }
    // Flush a trailing frame that arrived without a terminating newline.
    if (buffer.trim()) yield* parseFrame(buffer);
  } finally {
    // WARP-329 — cancel the body so an early break (client disconnect) tears
    // down the connection to the gateway, which closes the Ollama stream.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

export async function saveKey(
  provider: string,
  apiKey: string,
  userId?: string
): Promise<void> {
  // CodeQL js/request-forgery: `provider` is `req.params.provider` from
  // routes/llm.ts; encode it so it can only ever be one path segment of the
  // gateway URL (same as every other caller of internalFetch does).
  const res = await internalFetch(`${BASE_URL}/ai/keys/${encodeURIComponent(provider)}`, {
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
  const res = await internalFetch(`${BASE_URL}/ai/keys/${encodeURIComponent(provider)}`, {
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

/**
 * WARP-2883 — the gateway's per-endpoint round-trip probe. Best-effort: null
 * on any failure (gateway down, non-2xx, malformed body, timeout), never a
 * throw — this feeds a KPI tile, and the Models page must render without it.
 * 10 s ceiling: the gateway's own probes cap at 3 s each and run in parallel.
 */
export async function fetchLatency(): Promise<LatencyResponse | null> {
  try {
    const res = await internalFetch(`${BASE_URL}/ai/latency`, {
      headers: authHeaders(),
      signal: timeout(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<LatencyResponse> | null;
    const p = body?.providers;
    if (!p || typeof p !== "object") return null;
    const ms = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    return { providers: { local: ms(p.local), anthropic: ms(p.anthropic), openai: ms(p.openai) } };
  } catch {
    return null;
  }
}
