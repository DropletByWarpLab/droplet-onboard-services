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
