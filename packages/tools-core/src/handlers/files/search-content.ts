import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Natural-language search query (>= 2 characters)." },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Max results to return (default 10).",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const query = String(args.query ?? "").trim();
  if (query.length < 2) return err("INVALID_ARGS", "query must be at least 2 characters");
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));

  if (!ctx.embedText) return err("EMBEDDING_UNAVAILABLE", "embedding_service_unavailable");

  let embedVec: number[];
  try {
    const vectors = await ctx.embedText([query]);
    if (!vectors?.[0] || !Array.isArray(vectors[0])) {
      return err("EMBEDDING_FAILED", "embedding_service_returned_no_vector");
    }
    embedVec = vectors[0];
    if (!embedVec.every((v) => typeof v === "number" && Number.isFinite(v))) {
      return err("EMBEDDING_FAILED", "embedding_service_returned_invalid_vector");
    }
  } catch {
    return err("EMBEDDING_UNAVAILABLE", "embedding_service_unavailable");
  }

  const vecLiteral = `[${embedVec.join(",")}]`;
  const rows: Array<{ path: string; score: number; text: string }> = await (
    ctx.prisma as unknown as {
      $queryRawUnsafe: (
        query: string,
        ...params: unknown[]
      ) => Promise<Array<{ path: string; score: number; text: string }>>;
    }
  ).$queryRawUnsafe(
    `
    SELECT path, score, text FROM (
      SELECT DISTINCT ON ("ncFileId")
        "path",
        1 - ("embedding" <=> $1::vector) AS score,
        "text"
      FROM "FileContentChunk"
      WHERE "userId" = $2
      ORDER BY "ncFileId", "embedding" <=> $1::vector
    ) ranked
    ORDER BY score DESC
    LIMIT $3
    `,
    vecLiteral,
    ctx.userId,
    limit,
  );
  return { ok: true, data: { query, results: rows } };
}

const tool: Tool = {
  name: "search_content",
  description:
    "Semantic full-text search across the user's Nextcloud documents. Returns the most relevant text snippets ranked by cosine similarity, each with the source file path and a relevance score (0..1).",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
