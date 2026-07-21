/**
 * WARP-1440 — `search_camera_events` LLM tool.
 *
 * Natural-language search over recorded camera events ("delivery truck
 * last week") backed by the orchestrator's
 * `GET /api/cameras/events/search` (Frigate 0.14+ CLIP semantic
 * search). We go through the orchestrator — not `ctx.http.cameras` —
 * for the same reasons as `list-cameras.ts`: it owns the typed event
 * DTO (camera.service.ts `searchEventsSemanticTyped`) and the
 * mcp-server's `createHttpClient` auto-injects the service-principal
 * JWT for the orchestrator target.
 *
 * The route also accepts `labels`, `min_score`, `before` and `after`;
 * we deliberately expose only the query/camera/limit/search_type
 * subset — the natural-language query already carries object and time
 * intent, and fewer knobs means fewer ways for the model to
 * over-filter itself into empty results.
 *
 * Frigate without the embeddings stack makes the route answer 503 +
 * an operator hint; we surface that verbatim as
 * `SEMANTIC_SEARCH_DISABLED` so the agent can tell the user how to
 * turn the feature on. Tier-1 read — no writes, no confirmation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const MAX_QUERY_CHARS = 300;
const MAX_LIMIT = 50;

/** Same convention the orchestrator route enforces (cameras.ts CAMERA_NAME_RE). */
const CAMERA_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Fallback when the 503 body can't be parsed for the route's hint. */
const SEMANTIC_DISABLED_FALLBACK =
  "Semantic search isn't enabled on this Frigate. Add `semantic_search.enabled: true` to config.yml under your model section, save from the System page, and try again.";

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: MAX_QUERY_CHARS,
      description:
        'What to look for, in plain language — e.g. "delivery truck", "person carrying a box at night".',
    },
    camera: {
      type: "string",
      description:
        "Optional camera name to restrict the search to (as returned by list_cameras).",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: "Max events to return (default 50).",
    },
    search_type: {
      type: "string",
      enum: ["thumbnail", "description"],
      description:
        'Which embedding to match against: "thumbnail" (visual similarity, default) or "description" (the AI-generated event description).',
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

function invalidArgs(message: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: { code: "INVALID_ARGS", message },
  };
}

function searchFailed(detail: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: "SEARCH_FAILED",
      message: `camera event search failed — ${detail}`,
    },
  };
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const rawQuery = typeof args.query === "string" ? args.query : "";
  const query = rawQuery.trim();
  if (!query) {
    return invalidArgs("query is required and must be a non-empty string");
  }
  if (query.length > MAX_QUERY_CHARS) {
    return invalidArgs(`query must be at most ${MAX_QUERY_CHARS} characters`);
  }

  const params: Record<string, unknown> = { query };

  if (args.camera !== undefined) {
    if (typeof args.camera !== "string" || !CAMERA_NAME_RE.test(args.camera)) {
      return invalidArgs(
        "camera must be a valid camera name (letters, digits, underscores, hyphens)",
      );
    }
    // The route takes a comma-separated `cameras` list; the tool exposes
    // a single camera filter, so forward it as a one-entry list.
    params.cameras = args.camera;
  }

  if (args.limit !== undefined) {
    const n = Number(args.limit);
    if (!Number.isFinite(n)) {
      return invalidArgs("limit must be a number between 1 and 50");
    }
    params.limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
  }

  if (args.search_type !== undefined) {
    if (args.search_type !== "thumbnail" && args.search_type !== "description") {
      return invalidArgs('search_type must be "thumbnail" or "description"');
    }
    params.search_type = args.search_type;
  }

  let payload: Record<string, unknown>;
  try {
    const res = await ctx.http.orchestrator.get("/api/cameras/events/search", {
      params,
    });
    if (res.status === 503) {
      // Route-level "Frigate has no embeddings stack" — pass the
      // operator hint through so the agent can explain the fix.
      let hint = SEMANTIC_DISABLED_FALLBACK;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string" && body.error.length > 0) {
          hint = body.error;
        }
      } catch {
        // non-JSON body — keep the fallback hint
      }
      return {
        ok: false,
        status: "error",
        error: { code: "SEMANTIC_SEARCH_DISABLED", message: hint },
      };
    }
    if (!res.ok) {
      return searchFailed(`orchestrator returned ${res.status}`);
    }
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    return searchFailed("orchestrator not reachable");
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  return {
    ok: true,
    data: {
      type: "search_camera_events",
      query,
      events,
      count: events.length,
    },
  };
}

const tool: Tool = {
  name: "search_camera_events",
  description:
    'Search recorded security-camera events by natural language (e.g. "delivery truck last week", "person near the gate at night") using the NVR\'s semantic search. Optionally restrict to one camera. Requires the NVR\'s semantic-search feature — if it is disabled the tool returns SEMANTIC_SEARCH_DISABLED with instructions to relay to the user for enabling it.',
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
