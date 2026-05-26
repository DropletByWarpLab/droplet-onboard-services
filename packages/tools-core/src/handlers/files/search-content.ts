import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural-language search query (>= 2 characters).",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Max results to return (default 10).",
    },
    enhance: {
      type: "object",
      description:
        "WARP-437: optional query enhancement knobs. Omit for baseline behaviour. Adaptive routing in the orchestrator's agent loop typically sets these based on classified query intent; the LLM may also opt in directly.",
      properties: {
        hyde: {
          type: "boolean",
          description:
            "Run HyDE rewrite + average the hypothetical-passage embedding with the raw query.",
        },
        multiQuery: {
          type: "boolean",
          description:
            "Run multi-query expansion (n paraphrases) and RRF-fuse across vector arms.",
        },
        n: {
          type: "integer",
          minimum: 2,
          maximum: 5,
          description: "Paraphrase count when multiQuery=true (default 3).",
        },
      },
      additionalProperties: false,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

function parseEnhance(
  raw: unknown,
): { hyde?: boolean; multiQuery?: boolean; n?: number } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: { hyde?: boolean; multiQuery?: boolean; n?: number } = {};
  if (typeof r.hyde === "boolean") out.hyde = r.hyde;
  if (typeof r.multiQuery === "boolean") out.multiQuery = r.multiQuery;
  if (typeof r.n === "number" && Number.isInteger(r.n) && r.n >= 2 && r.n <= 5) {
    out.n = r.n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const query = String(args.query ?? "").trim();
  if (query.length < 2)
    return err("INVALID_ARGS", "query must be at least 2 characters");
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
  // WARP-437: parse enhance, allow undefined to flow through (default behaviour).
  const enhance = parseEnhance(args.enhance);

  // WARP-286: delegate to the orchestrator-side searchHybrid shim. The
  // handler no longer assembles its own embedding + SQL; that knowledge
  // lives in apps/orchestrator/src/services/file-search.service.ts where
  // the dashboard /knowledge route also consumes it. One pipeline, two
  // callers, no drift.
  if (!ctx.searchHybrid)
    return err("SEARCH_UNAVAILABLE", "search_unavailable");

  let hits: Awaited<ReturnType<NonNullable<typeof ctx.searchHybrid>>>;
  try {
    hits = await ctx.searchHybrid({ query, limit, enhance });
  } catch {
    return err("SEARCH_FAILED", "search_failed");
  }

  return {
    ok: true,
    data: {
      query,
      results: hits.map((h) => ({
        source: h.source,
        path: h.path,
        chunkIdx: h.chunkIdx,
        pageNumber: h.pageNumber,
        score: h.score,
        text: h.snippet,
      })),
    },
  };
}

const tool: Tool = {
  name: "search_content",
  description:
    "Hybrid (BM25 + vector + cross-encoder reranker) search across the user's Nextcloud documents and uploaded brain items. Returns the most relevant text snippets ranked by reranker score, each with source / path / chunk-index / optional page-number / score.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
