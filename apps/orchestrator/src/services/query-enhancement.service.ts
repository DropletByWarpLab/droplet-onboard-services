/**
 * WARP-437 — Query enhancement (HyDE + multi-query).
 *
 * Two functions, both routed through an injected `chat` callable so the
 * test surface stays mock-friendly. The real binding (production) plugs
 * `ai-gateway.client.chat` in; tests pass a vi.fn().
 *
 * `searchHybrid` does NOT call these directly — keeping LLM-orchestration
 * out of `searchHybrid` lets the same file run unchanged in both the
 * orchestrator and the mcp-server (WARP-202 mirror).
 */

import { createHash } from "node:crypto";

import type { QueryClass } from "../types/query-enhancement.js";
import { EmbeddingClient } from "./embedding.client.js";
import { QueryClassifierClient } from "./query-classifier.client.js";
import * as aiGateway from "./ai-gateway.client.js";
import { getRedis } from "./cache.service.js";
import type { EnhancementDeps } from "./llm-agent.service.js";
import type { ChatResponse } from "../types/index.js";
import { contentToText } from "../types/index.js";

// Re-export for type-narrowing call sites.
export type { QueryClass } from "../types/query-enhancement.js";

export const MULTI_QUERY_DEFAULT_N = 3;
const HYDE_MAX_TOKENS = 200;
const MULTI_QUERY_MAX_TOKENS = 300;

const HYDE_PROMPT = (query: string): string =>
  [
    "You are a helpful assistant that writes a short hypothetical passage that",
    "would answer the user's question. Write 1 paragraph, 60-120 words, in the",
    "style of a document body (not a chat reply). Do NOT add disclaimers or",
    "preambles. Do NOT use markdown.",
    "",
    `Question: ${query}`,
    "",
    "Passage:",
  ].join("\n");

const MULTI_QUERY_PROMPT = (query: string, n: number): string =>
  [
    `Rewrite the user's question as ${n} alternative search queries that capture the`,
    "same intent from different angles. Each rewrite must be self-contained (no",
    `references to "the question"). Output as a JSON array of exactly ${n} strings,`,
    "no markdown, no commentary.",
    "",
    `Question: ${query}`,
    "",
    "Rewrites:",
  ].join("\n");

export interface ChatClient {
  (args: {
    prompt: string;
    temperature: number;
    maxTokens: number;
    priority: number;
  }): Promise<{ content: string }>;
}

export interface HydeRewriteParams {
  query: string;
  chat: ChatClient;
}

export async function hydeRewrite({ query, chat }: HydeRewriteParams): Promise<string> {
  try {
    const r = await chat({
      prompt: HYDE_PROMPT(query),
      temperature: 0.2,
      maxTokens: HYDE_MAX_TOKENS,
      priority: 5, // automation, not user-initiated
    });
    const passage = r.content.trim();
    return passage.length > 0 ? passage : query;
  } catch {
    // Never let HyDE failures escape — fall back to the raw query.
    return query;
  }
}

export interface MultiQueryExpandParams {
  query: string;
  chat: ChatClient;
  n?: number;
}

export async function multiQueryExpand({
  query,
  chat,
  n = MULTI_QUERY_DEFAULT_N,
}: MultiQueryExpandParams): Promise<string[]> {
  let raw: { content: string };
  try {
    raw = await chat({
      prompt: MULTI_QUERY_PROMPT(query, n),
      temperature: 0.5,
      maxTokens: MULTI_QUERY_MAX_TOKENS,
      priority: 5,
    });
  } catch {
    return [query];
  }
  const parsed = tryParseJsonArray(raw.content);
  if (!parsed || parsed.length === 0) return [query];
  const cleaned = parsed
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, n);
  return cleaned.length > 0 ? cleaned : [query];
}

/** Classifier results are deterministic for a given query; 24 h TTL is safe. */
export const CLASSIFIER_CACHE_TTL_SEC = 24 * 60 * 60;

const CLASSIFIER_CACHE_PREFIX = "warp437:cls:";

export interface ClassifyQueryRpc {
  (args: { query: string }): Promise<{ class: string; confidence: number }>;
}

export interface ClassifyQueryCache {
  get(key: string): Promise<string | null>;
  setex(key: string, ttl: number, value: string): Promise<unknown>;
}

export interface ClassifyQueryParams {
  query: string;
  rpc: ClassifyQueryRpc;
  cache: ClassifyQueryCache;
}

export interface ClassifyResult {
  cls: QueryClass;
  confidence: number;
}

const KNOWN_CLASSES: ReadonlySet<QueryClass> = new Set<QueryClass>([
  "factual",
  "analytical",
  "conversational",
  "navigational",
  "unknown",
]);

export async function classifyQuery({
  query,
  rpc,
  cache,
}: ClassifyQueryParams): Promise<ClassifyResult> {
  const key = CLASSIFIER_CACHE_PREFIX + createHash("sha256").update(query).digest("hex");
  const cached = await cache.get(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as ClassifyResult;
      if (KNOWN_CLASSES.has(parsed.cls)) return parsed;
    } catch {
      // fallthrough to fresh RPC
    }
  }
  try {
    const r = await rpc({ query });
    const cls: QueryClass = KNOWN_CLASSES.has(r.class as QueryClass)
      ? (r.class as QueryClass)
      : "unknown";
    const result: ClassifyResult = { cls, confidence: r.confidence };
    await cache.setex(key, CLASSIFIER_CACHE_TTL_SEC, JSON.stringify(result));
    return result;
  } catch {
    return { cls: "unknown", confidence: 0 };
  }
}

function tryParseJsonArray(text: string): string[] | null {
  // Local 7B models often wrap JSON in ```json fences or prose. Strip both.
  const stripped = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(stripped.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    return arr.every((x) => typeof x === "string") ? (arr as string[]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Production binding (WARP-437 follow-up — keep below the unit-tested core).
// The factory below wires `hydeRewrite`, `multiQueryExpand`, `classifyQuery`
// into an `EnhancementDeps` consumable by the agent loop. Feature-flagged via
// QUERY_ENHANCEMENT_ENABLED — when the env var is not "1", the factory
// returns `undefined` and the agent loop falls back to baseline retrieval.
// ---------------------------------------------------------------------------

export interface EnhancementFactoryOptions {
  /** ai-gateway gRPC endpoint, e.g. "ai-gateway:50051". */
  aiGatewayGrpcUrl: string;
  /** Default chat model for HyDE / multi-query rewrites. */
  defaultModel: string;
}

/**
 * Build a chat adapter that wraps the HTTP `ai-gateway.client.chat` in the
 * `ChatClient` shape expected by `hydeRewrite` / `multiQueryExpand`.
 *
 * Notes:
 * - The HTTP route doesn't propagate `priority` — HyDE / multi-query are
 *   intended as automation-priority (=5) calls but production HTTP doesn't
 *   carry that field; the priority arg is accepted and discarded.
 * - On any error or non-OK response the adapter returns `{ content: "" }`;
 *   the upstream `hydeRewrite` / `multiQueryExpand` already fall back to the
 *   raw query on empty content, so enhancement degrades gracefully.
 *   (`aiGateway.chat` throws on non-OK non-stream responses; the catch
 *   below subsumes both the throw path and any other transport error.)
 */
function makeHttpChatAdapter(defaultModel: string): ChatClient {
  return async (args) => {
    try {
      const res = await aiGateway.chat({
        model: defaultModel,
        messages: [{ role: "user", content: args.prompt }],
        stream: false,
        temperature: args.temperature,
        max_tokens: args.maxTokens,
      });
      if (!res.ok) return { content: "" };
      const data = (await res.json()) as ChatResponse;
      return { content: contentToText(data.choices?.[0]?.message?.content) };
    } catch {
      return { content: "" };
    }
  };
}

/** ClassifyQueryCache adapter over the orchestrator's Redis singleton. */
function makeRedisClassifierCache(): ClassifyQueryCache {
  return {
    async get(key: string): Promise<string | null> {
      try {
        return await getRedis().get(key);
      } catch {
        return null;
      }
    },
    async setex(key: string, ttl: number, value: string): Promise<unknown> {
      try {
        return await getRedis().set(key, value, "EX", ttl);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Build the production `EnhancementDeps` if the feature flag is on.
 * Returns `undefined` otherwise — the agent loop treats that the same as
 * a missing dep (no enhancement, byte-for-byte baseline behaviour).
 */
export function createEnhancementDeps(
  opts: EnhancementFactoryOptions,
): EnhancementDeps | undefined {
  if (process.env.QUERY_ENHANCEMENT_ENABLED !== "1") return undefined;

  const embedder = new EmbeddingClient({ url: opts.aiGatewayGrpcUrl });
  const classifier = new QueryClassifierClient({ url: opts.aiGatewayGrpcUrl });
  const cache = makeRedisClassifierCache();
  const chat = makeHttpChatAdapter(opts.defaultModel);

  return {
    classify: (query: string) =>
      classifyQuery({
        query,
        rpc: (a) => classifier.classify(a),
        cache,
      }).then((r) => ({ cls: r.cls, confidence: r.confidence })),
    hyde: (query: string) => hydeRewrite({ query, chat }),
    multiQuery: (query: string, n: number) =>
      multiQueryExpand({ query, chat, n }),
    embed: (texts: string[]) => embedder.embed(texts),
  };
}
